import { getClaudeBasePath } from '@main/utils/pathDecoder';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import * as agentTeamsControllerModule from 'agent-teams-controller';

import { boundLaunchDiagnostics } from '../progressPayload';
import { type TeamMembersMetaStore } from '../TeamMembersMetaStore';
import { TeamTaskReader } from '../TeamTaskReader';

import {
  createTeamProvisioningBootstrapFailureMarker,
  type TeamProvisioningBootstrapFailureMarker,
} from './TeamProvisioningBootstrapFailureMarking';
import {
  createTeamProvisioningOpenCodeBootstrapStallReconciliationPorts,
  createTeamProvisioningOpenCodeBootstrapStallStatusPorts,
  type TeamProvisioningOpenCodeBootstrapStallReconciliationPorts,
} from './TeamProvisioningBootstrapStallPortsFactory';
import { type BootstrapTranscriptOutcome } from './TeamProvisioningBootstrapTranscript';
import { buildLaunchDiagnosticsFromRun } from './TeamProvisioningLaunchDiagnostics';
import { getMemberSpawnStatusesSnapshot } from './TeamProvisioningMemberSpawnSnapshots';
import { getMemberSpawnStatusesSnapshotReadOnly } from './TeamProvisioningMemberSpawnStatusesReadOnly';
import {
  createInitialMemberSpawnStatusEntry,
  MEMBER_LAUNCH_GRACE_MS,
} from './TeamProvisioningMemberSpawnStatusPolicy';
import {
  createTeamProvisioningMemberSpawnStatusesSnapshotHostFromService,
  createTeamProvisioningMemberSpawnStatusesSnapshotPortsBoundary,
  type TeamProvisioningMemberSpawnStatusesSnapshotServiceHost,
} from './TeamProvisioningMemberSpawnStatusSnapshotPortsFactory';
import {
  isOpenCodeBootstrapStallWindowElapsed as isOpenCodeBootstrapStallWindowElapsedHelper,
  type OpenCodeBootstrapStallRetryPromptPorts,
  type OpenCodeBootstrapStallStatusPorts,
  scheduleOpenCodeBootstrapStallReevaluation as scheduleOpenCodeBootstrapStallReevaluationHelper,
} from './TeamProvisioningOpenCodeBootstrapStall';
import { type TeamProvisioningReevaluateMemberLaunchStatusBoundary } from './TeamProvisioningReevaluateMemberLaunchStatusPortsFactory';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { nowIso } from './TeamProvisioningRunProgress';
import {
  isOpenCodeRuntimeRecipient as isOpenCodeRuntimeRecipientHelper,
  resolveRuntimeRecipientProviderId as resolveRuntimeRecipientProviderIdHelper,
} from './TeamProvisioningRuntimeRecipientResolution';
import { type TeamProvisioningRuntimeSnapshotFacade } from './TeamProvisioningRuntimeSnapshotFacade';
import { type TeamProvisioningRunTrackingDeliveryHelper } from './TeamProvisioningRunTrackingDelivery';
import { updateProvisioningProgressMetadata } from './TeamProvisioningSecondaryStopProgress';
import { deliverStartupWorkAfterConfirmation } from './TeamProvisioningStartupWorkDelivery';
import { TeamProvisioningTaskActivityCompatibilityFacade } from './TeamProvisioningTaskActivityCompatibilityFacade';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamProviderId,
  TeamTask,
} from '@shared/types';

interface StartupWorkDeliveryState {
  runId: string;
  launchAttemptId: string;
  completed: boolean;
  inFlight: Promise<void> | null;
}

const logger = createLogger('Service:TeamProvisioning');
const { createController } = agentTeamsControllerModule;

export abstract class TeamProvisioningMemberStatusQueryFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningTaskActivityCompatibilityFacade<TRun> {
  protected abstract readonly runTracking: Pick<
    TeamProvisioningRunTrackingDeliveryHelper<TRun>,
    'getTrackedRunId'
  >;
  protected abstract readonly runs: ReadonlyMap<string, TRun>;
  protected abstract readonly membersMetaStore: Pick<TeamMembersMetaStore, 'getMembers'>;
  protected abstract readonly runtimeSnapshotFacade: Pick<
    TeamProvisioningRuntimeSnapshotFacade,
    'getTeamAgentRuntimeSnapshot' | 'getTeamAgentRuntimeSnapshotReadOnly'
  >;
  protected abstract readonly reevaluateMemberLaunchStatusBoundary: TeamProvisioningReevaluateMemberLaunchStatusBoundary<TRun>;
  protected abstract readonly pendingTimeouts: Map<string, NodeJS.Timeout>;
  private readonly startupWorkDeliveriesByTeam = new Map<
    string,
    Map<string, StartupWorkDeliveryState>
  >();
  private readonly pendingStartupWorkDeliveriesByTeam = new Map<string, Set<Promise<void>>>();

  protected abstract findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome | null>;
  protected abstract sendOpenCodeMemberMessageToRuntimeSerialized(
    input: Parameters<
      OpenCodeBootstrapStallRetryPromptPorts['sendOpenCodeMemberMessageToRuntimeSerialized']
    >[0]
  ): ReturnType<
    OpenCodeBootstrapStallRetryPromptPorts['sendOpenCodeMemberMessageToRuntimeSerialized']
  >;
  protected abstract emitMemberSpawnChange(run: TRun, memberName: string): void;
  protected abstract persistLaunchStateSnapshot(
    run: TRun,
    phase: 'active' | 'finished'
  ): Promise<unknown>;

  async resolveRuntimeRecipientProviderId(
    teamName: string,
    memberName: string
  ): Promise<TeamProviderId | undefined> {
    return resolveRuntimeRecipientProviderIdHelper(
      { teamName, memberName },
      {
        readConfigSnapshot: (candidateTeamName) => this.readConfigSnapshot(candidateTeamName),
        readMembersMeta: (candidateTeamName) => this.membersMetaStore.getMembers(candidateTeamName),
      }
    );
  }

  protected readTeamTasks(teamName: string): Promise<TeamTask[]> {
    return new TeamTaskReader().getTasks(teamName);
  }

  async isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean> {
    return isOpenCodeRuntimeRecipientHelper(
      { teamName, memberName },
      {
        readConfigSnapshot: (candidateTeamName) => this.readConfigSnapshot(candidateTeamName),
        readMembersMeta: (candidateTeamName) => this.membersMetaStore.getMembers(candidateTeamName),
      }
    );
  }

  protected isCurrentTrackedRun(run: TRun): boolean {
    return this.runTracking.getTrackedRunId(run.teamName) === run.runId;
  }

  private createBootstrapFailureMarker(): TeamProvisioningBootstrapFailureMarker<TRun> {
    return createTeamProvisioningBootstrapFailureMarker<TRun>({
      nowIso,
      createInitialMemberSpawnStatusEntry,
      isMemberLifecycleOperationActive: (teamName, memberName) =>
        this.isMemberLifecycleOperationActive(teamName, memberName),
      syncMemberTaskActivityForRuntimeTransition: (targetRun, memberName, previous, next, at) =>
        this.syncMemberTaskActivityForRuntimeTransition(targetRun, memberName, previous, next, at),
      appendMemberBootstrapDiagnostic: (targetRun, memberName, detail) =>
        this.appendMemberBootstrapDiagnostic(targetRun, memberName, detail),
      isCurrentTrackedRun: (targetRun) => this.isCurrentTrackedRun(targetRun),
      emitMemberSpawnChange: (targetRun, memberName) =>
        this.emitMemberSpawnChange(targetRun, memberName),
    });
  }

  protected markUnconfirmedBootstrapMembersFailed(
    run: TRun,
    reason: string,
    options?: { cleanupRequested?: boolean; preserveExistingFailure?: boolean }
  ): void {
    this.createBootstrapFailureMarker().markUnconfirmedBootstrapMembersFailed(run, reason, options);
  }

  protected startRuntimeToolActivity(
    run: TRun,
    memberName: string,
    block: Record<string, unknown>
  ): void {
    this.runtimeToolActivity.startRuntimeToolActivity(run, memberName, block);
  }

  protected finishRuntimeToolActivity(
    run: TRun,
    toolUseId: string,
    resultContent: unknown,
    isError: boolean
  ): void {
    this.runtimeToolActivity.finishRuntimeToolActivity(run, toolUseId, resultContent, isError);
  }

  protected appendMemberBootstrapDiagnostic(run: TRun, memberName: string, text: string): void {
    this.runtimeToolActivity.appendMemberBootstrapDiagnostic(run, memberName, text);
  }

  protected updateLaunchDiagnosticsForRun(run: TRun, observedAt: string): void {
    const launchDiagnostics = boundLaunchDiagnostics(
      buildLaunchDiagnosticsFromRun(run, { nowIso: () => observedAt })
    );
    if (!launchDiagnostics) {
      return;
    }
    updateProvisioningProgressMetadata(run, {
      updatedAt: observedAt,
      launchDiagnostics,
    });
    run.onProgress(run.progress);
  }

  protected resetRuntimeToolActivity(run: TRun, memberName?: string): void {
    this.runtimeToolActivity.resetRuntimeToolActivity(run, memberName);
  }

  protected clearMemberSpawnToolTracking(run: TRun, memberName: string): void {
    this.runtimeToolActivity.clearMemberSpawnToolTracking(run, memberName);
  }

  protected pauseMemberTaskActivityForRuntimeLoss(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    observedAt: string
  ): void {
    this.runtimeToolActivity.pauseMemberTaskActivityForRuntimeLoss(
      run,
      memberName,
      previous,
      observedAt
    );
  }

  protected syncMemberTaskActivityForRuntimeTransition(
    run: TRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): Promise<void> {
    this.runtimeToolActivity.syncMemberTaskActivityForRuntimeTransition(
      run,
      memberName,
      previous,
      next,
      observedAt
    );
    return this.ensureStartupWorkDelivery(run, memberName, next);
  }

  /**
   * Retry a confirmed member's startup hand-over on every status activity until it succeeds.
   * The per-team/member record is scoped to one run and launch attempt, so a restart cannot
   * inherit an earlier attempt's completion or pending request.
   */
  private ensureStartupWorkDelivery(
    run: TRun,
    memberName: string,
    status: MemberSpawnStatusEntry
  ): Promise<void> {
    if (!status.bootstrapConfirmed || !this.isCurrentTrackedRun(run)) {
      return Promise.resolve();
    }
    const launchAttemptId = `${run.runId}@${status.firstSpawnAcceptedAt ?? status.updatedAt}`;
    const teamDeliveries =
      this.startupWorkDeliveriesByTeam.get(run.teamName) ??
      new Map<string, StartupWorkDeliveryState>();
    this.startupWorkDeliveriesByTeam.set(run.teamName, teamDeliveries);
    let state = teamDeliveries.get(memberName);
    if (!state || state.runId !== run.runId || state.launchAttemptId !== launchAttemptId) {
      state = {
        runId: run.runId,
        launchAttemptId,
        completed: false,
        inFlight: null,
      };
      teamDeliveries.set(memberName, state);
    }
    if (state.completed) {
      return Promise.resolve();
    }
    if (state.inFlight) {
      return state.inFlight;
    }

    const delivery = deliverStartupWorkAfterConfirmation(run, memberName, launchAttemptId, {
      createController: (input) => createController(input),
      readTasks: (teamName) => this.readTeamTasks(teamName),
      getClaudeBasePath,
      isCurrent: () =>
        this.isCurrentTrackedRun(run) &&
        teamDeliveries.get(memberName) === state &&
        state.runId === run.runId &&
        state.launchAttemptId === launchAttemptId,
      appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
        this.appendMemberBootstrapDiagnostic(targetRun, targetMember, text),
      logger,
    });
    const ownedDelivery = delivery.then(
      (deliveredCount) => {
        if (teamDeliveries.get(memberName) === state) {
          state.completed = true;
          if (deliveredCount > 0) {
            this.appendMemberBootstrapDiagnostic(
              run,
              memberName,
              `startup work delivered after launch confirmation for ${launchAttemptId}: ` +
                `${deliveredCount} task message(s)`
            );
          }
        }
      },
      () => {
        if (teamDeliveries.get(memberName) === state) {
          state.completed = false;
        }
      }
    );
    const trackedDelivery = this.trackStartupWorkDelivery(run.teamName, ownedDelivery);
    const stateDelivery: Promise<void> = trackedDelivery.finally(() => {
      if (teamDeliveries.get(memberName) === state && state.inFlight === stateDelivery) {
        state.inFlight = null;
      }
    });
    state.inFlight = stateDelivery;
    return stateDelivery;
  }

  protected clearStartupWorkDeliveryState(run: Pick<TRun, 'runId' | 'teamName'>): void {
    const teamDeliveries = this.startupWorkDeliveriesByTeam.get(run.teamName);
    if (!teamDeliveries) {
      return;
    }
    for (const [memberName, state] of teamDeliveries) {
      if (state.runId === run.runId) {
        teamDeliveries.delete(memberName);
      }
    }
    if (teamDeliveries.size === 0) {
      this.startupWorkDeliveriesByTeam.delete(run.teamName);
    }
  }

  private trackStartupWorkDelivery(teamName: string, delivery: Promise<void>): Promise<void> {
    const pending =
      this.pendingStartupWorkDeliveriesByTeam.get(teamName) ?? new Set<Promise<void>>();
    this.pendingStartupWorkDeliveriesByTeam.set(teamName, pending);
    const trackedDelivery: Promise<void> = delivery.finally(() => {
      pending.delete(trackedDelivery);
      if (pending.size === 0) {
        this.pendingStartupWorkDeliveriesByTeam.delete(teamName);
      }
    });
    pending.add(trackedDelivery);
    void trackedDelivery.catch(() => undefined);
    return trackedDelivery;
  }

  private async waitForStartupWorkDeliveries(teamName: string): Promise<void> {
    while (true) {
      const pending = this.pendingStartupWorkDeliveriesByTeam.get(teamName);
      if (!pending || pending.size === 0) {
        return;
      }
      await Promise.all([...pending]);
    }
  }

  private createMemberSpawnStatusesSnapshotPorts() {
    const host = createTeamProvisioningMemberSpawnStatusesSnapshotHostFromService(
      this as unknown as TeamProvisioningMemberSpawnStatusesSnapshotServiceHost<TRun>
    );
    return createTeamProvisioningMemberSpawnStatusesSnapshotPortsBoundary(host);
  }

  protected loadMemberSpawnStatusesSnapshot(
    teamName: string
  ): Promise<MemberSpawnStatusesSnapshot> {
    return getMemberSpawnStatusesSnapshot(teamName, this.createMemberSpawnStatusesSnapshotPorts());
  }

  private async retryConfirmedStartupWorkDeliveries(
    teamName: string,
    snapshot: MemberSpawnStatusesSnapshot
  ): Promise<void> {
    const run = snapshot.runId ? this.runs.get(snapshot.runId) : undefined;
    if (!run || run.teamName !== teamName || !this.isCurrentTrackedRun(run)) {
      return;
    }
    await Promise.all(
      Object.entries(snapshot.statuses)
        .filter(([, status]) => status.bootstrapConfirmed)
        .map(([memberName, status]) => this.ensureStartupWorkDelivery(run, memberName, status))
    );
  }

  async getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot> {
    const snapshot = await this.loadMemberSpawnStatusesSnapshot(teamName);
    await this.retryConfirmedStartupWorkDeliveries(teamName, snapshot);
    await this.waitForStartupWorkDeliveries(teamName);
    return snapshot;
  }

  /**
   * The write-free projection, for callers that must not disturb a launch (the
   * HTTP diagnostics route an external monitor polls).
   *
   * The IPC/UI path deliberately keeps the writing variant: the persisted-launch
   * reconcile, the task-activity repair and the expired-launch-grace
   * persistence only ever run from it, and the renderer already backs its poll
   * off during launch. Those maintenance jobs riding a getter is why the two
   * variants have to exist at all; moving them onto their own scheduler would
   * let this one collapse back into `getMemberSpawnStatuses`.
   */
  async getMemberSpawnStatusesReadOnly(teamName: string): Promise<MemberSpawnStatusesSnapshot> {
    return getMemberSpawnStatusesSnapshotReadOnly(
      teamName,
      this.createMemberSpawnStatusesSnapshotPorts()
    );
  }

  async getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    return this.runtimeSnapshotFacade.getTeamAgentRuntimeSnapshot(teamName);
  }

  /**
   * `memberSpawnStatuses` lets a caller that already read
   * `getMemberSpawnStatusesReadOnly` hand that projection over instead of
   * paying for a second one - the HTTP diagnostics route reports both in one
   * response, and only one projection can answer for both halves of it.
   */
  async getTeamAgentRuntimeSnapshotReadOnly(
    teamName: string,
    options?: { memberSpawnStatuses?: MemberSpawnStatusesSnapshot }
  ): Promise<TeamAgentRuntimeSnapshot> {
    return this.runtimeSnapshotFacade.getTeamAgentRuntimeSnapshotReadOnly(teamName, options);
  }

  protected getMemberLaunchGraceKey(run: TRun, memberName: string): string {
    return `member-launch-grace:${run.runId}:${memberName}`;
  }

  protected syncMemberLaunchGraceCheck(
    run: TRun,
    memberName: string,
    entry: MemberSpawnStatusEntry
  ): void {
    const key = this.getMemberLaunchGraceKey(run, memberName);
    const existing = this.pendingTimeouts.get(key);
    if (entry.launchState === 'failed_to_start' || entry.launchState === 'confirmed_alive') {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      return;
    }
    if (!entry.firstSpawnAcceptedAt) {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      return;
    }
    const remainingMs =
      Date.parse(entry.firstSpawnAcceptedAt) + MEMBER_LAUNCH_GRACE_MS - Date.now();
    if (remainingMs <= 0) {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      void this.reevaluateMemberLaunchStatus(run, memberName);
      return;
    }
    if (existing) {
      return;
    }
    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(key);
      void this.reevaluateMemberLaunchStatus(run, memberName);
    }, remainingMs);
    timer.unref?.();
    this.pendingTimeouts.set(key, timer);
  }

  protected async reevaluateMemberLaunchStatus(run: TRun, memberName: string): Promise<void> {
    await this.reevaluateMemberLaunchStatusBoundary.reevaluateMemberLaunchStatus(run, memberName);
  }

  protected getOpenCodeBootstrapStallStatusPorts(): OpenCodeBootstrapStallStatusPorts {
    return createTeamProvisioningOpenCodeBootstrapStallStatusPorts<TRun>({
      nowIso,
      syncMemberTaskActivityForRuntimeTransition: (targetRun, targetMember, previous, next, at) =>
        this.syncMemberTaskActivityForRuntimeTransition(
          targetRun,
          targetMember,
          previous,
          next,
          at
        ),
      updateLaunchDiagnostics: (targetRun, observedAt) =>
        this.updateLaunchDiagnosticsForRun(targetRun, observedAt),
      appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
        this.appendMemberBootstrapDiagnostic(targetRun, targetMember, text),
      isCurrentTrackedRun: (targetRun) => this.isCurrentTrackedRun(targetRun),
      emitMemberSpawnChange: (targetRun, targetMember) =>
        this.emitMemberSpawnChange(targetRun, targetMember),
      persistLaunchStateSnapshot: (targetRun, phase) => {
        void this.persistLaunchStateSnapshot(targetRun, phase).catch((error: unknown) => {
          logger.warn(
            `[${targetRun.teamName}] Failed to persist bootstrap-stall launch snapshot: ${getErrorMessage(error)}`
          );
        });
      },
    });
  }

  protected getOpenCodeBootstrapStallReconciliationPorts(): TeamProvisioningOpenCodeBootstrapStallReconciliationPorts {
    return createTeamProvisioningOpenCodeBootstrapStallReconciliationPorts<TRun>({
      getOpenCodeBootstrapStallStatusPorts: () => this.getOpenCodeBootstrapStallStatusPorts(),
      findBootstrapTranscriptOutcome: (teamName, memberName, acceptedAtMs) =>
        this.findBootstrapTranscriptOutcome(teamName, memberName, acceptedAtMs),
      getOpenCodeRuntimeMessageAdapter: () =>
        this.appShellBoundary.getOpenCodeRuntimeMessageAdapter(),
      sendOpenCodeMemberMessageToRuntimeSerialized: (sendInput) =>
        this.sendOpenCodeMemberMessageToRuntimeSerialized(sendInput),
      appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
        this.appendMemberBootstrapDiagnostic(targetRun, targetMember, text),
      isCurrentTrackedRun: (targetRun) => this.isCurrentTrackedRun(targetRun),
      scheduleOpenCodeBootstrapStallReevaluation: (targetRun, targetMember, firstSpawnAcceptedAt) =>
        this.scheduleOpenCodeBootstrapStallReevaluation(
          targetRun,
          targetMember,
          firstSpawnAcceptedAt
        ),
    });
  }

  protected scheduleOpenCodeBootstrapStallReevaluation(
    run: TRun,
    memberName: string,
    firstSpawnAcceptedAt: string
  ): void {
    scheduleOpenCodeBootstrapStallReevaluationHelper(run, memberName, firstSpawnAcceptedAt, {
      nowMs: () => Date.now(),
      getMemberLaunchGraceKey: (targetRun, targetMember) =>
        this.getMemberLaunchGraceKey(targetRun as TRun, targetMember),
      hasPendingTimeout: (key) => this.pendingTimeouts.has(key),
      setPendingTimeout: (key, timer) => this.pendingTimeouts.set(key, timer),
      deletePendingTimeout: (key) => this.pendingTimeouts.delete(key),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      reevaluateMemberLaunchStatus: (targetRun, targetMember) =>
        this.reevaluateMemberLaunchStatus(targetRun as TRun, targetMember),
    });
  }

  protected isOpenCodeBootstrapStallWindowElapsed(
    firstSpawnAcceptedAt: string | undefined
  ): boolean {
    return isOpenCodeBootstrapStallWindowElapsedHelper(firstSpawnAcceptedAt, Date.now());
  }
}
