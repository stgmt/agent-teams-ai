import { deliverStartupWorkAfterConfirmation } from '@main/services/team/provisioning/TeamProvisioningStartupWorkDelivery';
import { getErrorMessage } from '@shared/utils/errorHandling';

import type { MemberProcessToken, TeamRunIdentity } from '../../../contracts';
import type { ConfiguredMemberLaunch } from '../../../core/application/ports/MemberRuntimePorts';
import type { MemberLifecycleRegistry } from '../../../core/domain/MemberLifecycleRegistry';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type {
  StartupWorkDeliveryController,
  StartupWorkDeliveryRun,
} from '@main/services/team/provisioning/TeamProvisioningStartupWorkDelivery';
import type { TeamTask } from '@shared/types';

interface DeliveryState {
  token: Readonly<MemberProcessToken>;
  launch: Readonly<ConfiguredMemberLaunch>;
  contextSignal: AbortSignal;
  contextAbortListener: (() => void) | null;
  launchId: string;
  completed: boolean;
  retryDelayMs: number;
  retryTimer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
}

interface Dependencies {
  registry: Pick<MemberLifecycleRegistry, 'find' | 'isLive'>;
  contextInvalidationSignal(expected: AppConnectionContext): AbortSignal;
  withExpectedContext<T>(expected: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
  createController(input: {
    teamName: string;
    claudeDir: string;
    readOnlyTaskSnapshot: TeamTask[];
  }): StartupWorkDeliveryController;
  readTasks(teamName: string): Promise<TeamTask[]>;
  getClaudeBasePath(): string;
  appendDiagnostic(run: TeamRunIdentity, memberName: string, text: string): void;
  logger: { warn(message: string): void };
}

function launchId(token: Readonly<MemberProcessToken>): string {
  return [token.runId, token.memberName, token.generation, token.operationId]
    .map(encodeURIComponent)
    .join('/');
}

const STARTUP_WORK_RETRY_BASE_DELAY_MS = 500;
const STARTUP_WORK_RETRY_MAX_DELAY_MS = 30_000;

/** Retries startup handover failures while the exact connected generation remains current. */
export class NativeStartupWorkDelivery {
  private readonly deliveriesByTeam = new Map<string, Map<string, DeliveryState>>();

  constructor(private readonly deps: Dependencies) {}

  confirmed(
    launch: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>
  ): Promise<void> {
    if (
      launch.role === 'lead' ||
      launch.memberName !== token.memberName ||
      launch.team.teamName !== token.teamName ||
      launch.team.runId !== token.runId ||
      launch.team.appInstanceId !== token.appInstanceId ||
      launch.team.dataRootFingerprint !== token.dataRootFingerprint ||
      launch.team.connectionGeneration !== token.connectionGeneration
    )
      return Promise.resolve();

    const attemptId = launchId(token);
    const memberDeliveries = this.deliveriesByTeam.get(token.teamName);
    const existing = memberDeliveries?.get(token.memberName);
    if (existing?.launchId === attemptId && memberDeliveries) {
      if (!this.isCurrent(existing, memberDeliveries)) {
        this.invalidateState(token.teamName, memberDeliveries, token.memberName, existing);
        return Promise.resolve();
      }
      if (existing.completed || existing.retryTimer !== null) {
        return Promise.resolve();
      }
      if (existing.inFlight) return existing.inFlight;
      return this.runAttempt(existing, memberDeliveries);
    }

    const contextSignal = this.deps.contextInvalidationSignal(token);
    if (!this.isRegistryCurrent(token, contextSignal)) return Promise.resolve();

    const deliveries = memberDeliveries ?? new Map<string, DeliveryState>();
    if (existing) {
      deliveries.delete(token.memberName);
      this.disposeState(existing);
    }
    this.deliveriesByTeam.set(token.teamName, deliveries);
    const state: DeliveryState = {
      token: Object.freeze({ ...token }),
      launch,
      contextSignal,
      contextAbortListener: null,
      launchId: attemptId,
      completed: false,
      retryDelayMs: STARTUP_WORK_RETRY_BASE_DELAY_MS,
      retryTimer: null,
      inFlight: null,
    };
    deliveries.set(token.memberName, state);
    const abort = (): void =>
      this.invalidateState(token.teamName, deliveries, token.memberName, state);
    state.contextAbortListener = abort;
    contextSignal.addEventListener('abort', abort, { once: true });
    if (contextSignal.aborted) {
      abort();
      return Promise.resolve();
    }
    return this.runAttempt(state, deliveries);
  }

  private runAttempt(
    state: DeliveryState,
    memberDeliveries: Map<string, DeliveryState>
  ): Promise<void> {
    const { token, launch, launchId: attemptId } = state;
    const isCurrent = (): boolean => this.isCurrent(state, memberDeliveries);
    const deliveryRun: StartupWorkDeliveryRun = {
      teamName: token.teamName,
      allEffectiveMembers: [{ name: launch.memberName, providerId: launch.providerId }],
    };
    let policyStarted = false;
    let operation: Promise<number>;
    try {
      operation = this.deps.withExpectedContext(token, async () => {
        if (!isCurrent()) return 0;
        policyStarted = true;
        return deliverStartupWorkAfterConfirmation(deliveryRun, token.memberName, attemptId, {
          createController: (input) => this.deps.createController(input),
          readTasks: (teamName) => this.deps.readTasks(teamName),
          getClaudeBasePath: () => this.deps.getClaudeBasePath(),
          isCurrent,
          appendMemberBootstrapDiagnostic: (_run, memberName, text) =>
            this.deps.appendDiagnostic(token, memberName, text),
          logger: this.deps.logger,
        });
      });
    } catch (error) {
      operation = Promise.reject(error);
    }

    const tracked: Promise<void> = operation
      .then((deliveredCount) => {
        if (!isCurrent()) {
          this.invalidateState(token.teamName, memberDeliveries, token.memberName, state);
          return;
        }
        state.completed = true;
        this.disposeState(state);
        try {
          this.deps.appendDiagnostic(
            token,
            token.memberName,
            `startup work handover completed after launch confirmation for ${attemptId}: ${deliveredCount} task message(s) delivered`
          );
        } catch (error) {
          this.deps.logger.warn(
            `[${token.teamName}] Startup work handover completed for "${token.memberName}" (${attemptId}), but its diagnostic could not be recorded: ${getErrorMessage(error)}`
          );
        }
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          this.invalidateState(token.teamName, memberDeliveries, token.memberName, state);
          return;
        }
        if (!policyStarted) {
          const reason = getErrorMessage(error);
          this.deps.logger.warn(
            `[${token.teamName}] Startup work context admission failed for "${token.memberName}" (${attemptId}): ${reason}`
          );
          this.deps.appendDiagnostic(
            token,
            token.memberName,
            `startup work delivery could not enter the app context for ${attemptId}: ${reason}`
          );
        }
        this.scheduleRetry(state, memberDeliveries);
      })
      .finally(() => {
        if (memberDeliveries.get(token.memberName) === state && state.inFlight === tracked) {
          state.inFlight = null;
        }
      });
    state.inFlight = tracked;
    return tracked;
  }

  private scheduleRetry(state: DeliveryState, memberDeliveries: Map<string, DeliveryState>): void {
    const { token } = state;
    if (!this.isCurrent(state, memberDeliveries)) {
      this.invalidateState(token.teamName, memberDeliveries, token.memberName, state);
      return;
    }
    const delay = state.retryDelayMs;
    state.retryDelayMs = Math.min(delay * 2, STARTUP_WORK_RETRY_MAX_DELAY_MS);
    const timer = setTimeout(() => {
      state.retryTimer = null;
      if (!this.isCurrent(state, memberDeliveries)) {
        this.invalidateState(token.teamName, memberDeliveries, token.memberName, state);
        return;
      }
      void this.runAttempt(state, memberDeliveries);
    }, delay);
    state.retryTimer = timer;
    if (typeof timer !== 'number') timer.unref?.();
  }

  private isCurrent(state: DeliveryState, memberDeliveries: Map<string, DeliveryState>): boolean {
    return (
      memberDeliveries.get(state.token.memberName) === state &&
      this.isRegistryCurrent(state.token, state.contextSignal)
    );
  }

  private isRegistryCurrent(
    token: Readonly<MemberProcessToken>,
    contextSignal: AbortSignal
  ): boolean {
    if (contextSignal.aborted) return false;
    const run = this.deps.registry.find(token.teamName);
    const member = run?.members[token.memberName];
    return (
      this.deps.registry.isLive(token) &&
      run?.identity.runId === token.runId &&
      run.desired === 'running' &&
      run.resources === 'held' &&
      member?.membership === 'configured' &&
      member.desired === 'running' &&
      member.phase === 'ready' &&
      member.resources === 'held' &&
      member.generation === token.generation &&
      member.operationId === token.operationId &&
      member.everConnected &&
      member.role === 'member'
    );
  }

  private disposeState(state: DeliveryState): void {
    if (state.retryTimer !== null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    if (state.contextAbortListener) {
      state.contextSignal.removeEventListener('abort', state.contextAbortListener);
      state.contextAbortListener = null;
    }
  }

  private invalidateState(
    teamName: string,
    memberDeliveries: Map<string, DeliveryState>,
    memberName: string,
    state: DeliveryState
  ): void {
    if (memberDeliveries.get(memberName) === state) memberDeliveries.delete(memberName);
    this.disposeState(state);
    if (memberDeliveries.size === 0 && this.deliveriesByTeam.get(teamName) === memberDeliveries)
      this.deliveriesByTeam.delete(teamName);
  }

  release(run: Readonly<TeamRunIdentity>): void {
    const memberDeliveries = this.deliveriesByTeam.get(run.teamName);
    if (!memberDeliveries) return;
    for (const [memberName, state] of memberDeliveries) {
      if (state.token.runId !== run.runId) continue;
      memberDeliveries.delete(memberName);
      this.disposeState(state);
    }
    if (memberDeliveries.size === 0) this.deliveriesByTeam.delete(run.teamName);
  }
}
