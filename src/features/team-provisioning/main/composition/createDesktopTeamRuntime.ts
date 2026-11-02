import { memberIsLive } from '@features/team-provisioning';
import { toTeamProvisioningProgress } from '@main/team-runtime/nativeTeamProgressProjection';
import { toTeamRuntimeState } from '@main/team-runtime/nativeTeamRuntimeProjection';
import { createLogger } from '@shared/utils/logger';

import { TeamDefinitionExistsError } from '../adapters/output/NodeTeamDefinitionStore';

import type { TeamLifecycleSnapshot, TeamRunIdentity } from '../../contracts';
import type { ProvisioningStatusReaderPort } from '../../core/application/use-cases/GetProvisioningStatusUseCase';
import type { TeamLaunchSettingsUpdate } from '../adapters/output/NodeTeamDefinitionStore';
import type { NativeTeamLifecycle } from './createNativeTeamLifecycle';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type {
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types';

/** Fields the launch dialog may change without rewriting the roster. */
export interface TeamLaunchRequestPersistence {
  create(input: TeamCreateConfigRequest, signal: AbortSignal): Promise<void>;
  updateLaunchSettings(
    teamName: string,
    update: TeamLaunchSettingsUpdate,
    signal: AbortSignal
  ): Promise<void>;
}

export interface DesktopTeamRuntimeDependencies {
  currentContext(): Readonly<AppConnectionContext>;
  lifecycle: Pick<NativeTeamLifecycle, 'commands' | 'runs' | 'watch'>;
  definitions: TeamLaunchRequestPersistence;
  /** Persisted progress for runs the native registry no longer holds (app restart). */
  progressHistory: ProvisioningStatusReaderPort;
  /** Persisted runtime state for a team the current registry never saw. */
  bootstrapRuntime?: { read(teamName: string): Promise<TeamRuntimeState | null> };
  /**
   * Cross-feature launch admission: throws when another launch path is already
   * admitting, so two owners never provision the same runtime at once.
   */
  launchAdmission?: { assertAdmitted(): void };
  now(): string;
}

/** Lifecycle-facing part of the production team API; transport wiring is phase 8. */
export interface DesktopTeamRuntime extends ProvisioningStatusReaderPort {
  createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
  cancelProvisioning(runId: string): Promise<void>;
  hasProvisioningRun(teamName: string): boolean;
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  stopTeam(teamName: string): Promise<void>;
  /**
   * Shutdown path: stops every team that still holds a run and reports the ones
   * that failed, so one stuck release cannot keep the process alive.
   */
  stopAllTeams(): Promise<readonly { teamName: string; error: string }[]>;
  isTeamAlive(teamName: string): boolean;
  getAliveTeams(): string[];
  /** Same facts under the name the application root reads them by. */
  getAliveTeamNames(): string[];
  /**
   * Whether the team system holds anything right now: an admitted launch or a
   * run that still owns its team. The app shell keeps shared resources (the
   * bridge, the scheduler) alive while this is true.
   */
  hasActiveTeamRuntimes(): boolean;
  getCurrentRunId(teamName: string): string | null;
  /**
   * Launches admitted and not yet finished. A pending launch consumes the
   * app-owned HTTP bridge the same way a live lane does, so the bridge must not
   * be torn down while this is non-zero.
   */
  pendingLaunchAdmissions(): number;
}

const logger = createLogger('Service:TeamRuntime');

const PROVISIONING_STATES = new Set(['preparing', 'starting']);
const FAILED_STATES = new Set(['failed', 'release-failed']);
const TERMINAL_STATES = new Set(['ready', 'degraded', 'failed', 'stopped', 'release-failed']);

function hasLiveMember(snapshot: Readonly<TeamLifecycleSnapshot>): boolean {
  return Object.values(snapshot.members).some(
    (member) => member.membership === 'configured' && memberIsLive(member)
  );
}

function isActive(snapshot: Readonly<TeamLifecycleSnapshot> | null): boolean {
  return snapshot !== null && snapshot.desired === 'running' && !FAILED_STATES.has(snapshot.state);
}

export function createDesktopTeamRuntime(deps: DesktopTeamRuntimeDependencies): DesktopTeamRuntime {
  const context = (): Readonly<AppConnectionContext> => Object.freeze({ ...deps.currentContext() });

  const stop = async (run: Readonly<TeamRunIdentity>): Promise<void> => {
    await deps.lifecycle.commands.stop({
      expectedContext: context(),
      teamName: run.teamName,
      runId: run.runId,
    });
  };

  const stopTeam = async (teamName: string): Promise<void> => {
    const snapshot = deps.lifecycle.runs.find(teamName);
    // A stopped and released run has nothing to stop; anything else (including a
    // failed release) must reach the command so the release can be retried.
    if (!snapshot || snapshot.state === 'stopped') return;
    await stop(snapshot.identity);
  };

  let pendingLaunchAdmissions = 0;
  const launch = async (
    teamName: string,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> => {
    deps.launchAdmission?.assertAdmitted();
    pendingLaunchAdmissions += 1;
    try {
      return await launchRun(teamName, onProgress);
    } finally {
      pendingLaunchAdmissions -= 1;
    }
  };

  const launchRun = async (
    teamName: string,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> => {
    const admittedContext = context();
    // A failed run still owns resources; stop it exactly before admitting a successor.
    const observed = deps.lifecycle.runs.find(teamName);
    if (observed && observed.desired === 'running' && FAILED_STATES.has(observed.state)) {
      await stop(observed.identity);
    }
    const before = deps.lifecycle.runs.find(teamName);
    const alreadyRunning = before !== null && isActive(before) && hasLiveMember(before);
    const alreadyLaunching = before !== null && isActive(before) && !hasLiveMember(before);
    // The feed replays the last snapshot on subscribe; it is history, not this launch.
    let historyVersion = before?.version ?? -1;
    const feed = deps.lifecycle.watch(teamName);
    const last = { version: -1 };
    let admittedRunId: string | null = null;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await feed.return();
    };
    const emit = (snapshot: Readonly<TeamLifecycleSnapshot>): void => {
      if (snapshot.version <= historyVersion || snapshot.version === last.version) return;
      last.version = snapshot.version;
      onProgress(toTeamProvisioningProgress(snapshot, deps.now()));
      // A failed run must say why. Without this the interface shows "Team launch failed"
      // and the reason dies with the snapshot the user never sees.
      if (FAILED_STATES.has(snapshot.state)) {
        const memberErrors = Object.values(snapshot.members)
          .filter((member) => member.error)
          .map((member) => `${member.memberName}: ${member.error}`);
        logger.error(
          `[${snapshot.identity.teamName}] launch ${snapshot.state}: ${
            snapshot.error ?? 'no team error'
          }${memberErrors.length ? ` | ${memberErrors.join(' | ')}` : ''}`
        );
      }
    };
    void (async () => {
      try {
        for (;;) {
          const next = await feed.next();
          if (next.done || closed) return;
          const snapshot = next.value;
          if (snapshot.version <= historyVersion) continue;
          emit(snapshot);
          if (
            admittedRunId &&
            snapshot.identity.runId === admittedRunId &&
            TERMINAL_STATES.has(snapshot.state)
          )
            return;
        }
      } catch {
        // Feed closed by stop, context invalidation or shutdown.
      } finally {
        closed = true;
        await feed.return();
      }
    })();
    try {
      const receipt = await deps.lifecycle.commands.launch({
        expectedContext: admittedContext,
        teamName,
      });
      const runId = receipt.run.runId;
      admittedRunId = runId;
      // The admitted run may itself be the snapshot replayed on subscribe.
      historyVersion = -1;
      const current = deps.lifecycle.runs.findByRunId(runId);
      if (current) emit(current);
      if (!current || TERMINAL_STATES.has(current.state)) await close();
      return {
        runId,
        launchStatus: alreadyRunning
          ? 'already_running'
          : alreadyLaunching
            ? 'already_launching'
            : 'started',
        ...(alreadyRunning ? { alreadyRunning: true } : {}),
        ...(alreadyLaunching ? { alreadyLaunching: true } : {}),
      };
    } catch (error) {
      const failed = admittedRunId
        ? deps.lifecycle.runs.findByRunId(admittedRunId)
        : deps.lifecycle.runs.find(teamName);
      if (failed) emit(failed);
      await close();
      throw error;
    }
  };

  const persistLaunchSettings = async (request: TeamLaunchRequest): Promise<void> => {
    await deps.definitions.updateLaunchSettings(
      request.teamName,
      {
        cwd: request.cwd,
        prompt: request.prompt,
        providerId: request.providerId,
        providerBackendId: request.providerBackendId,
        model: request.model,
        effort: request.effort,
        fastMode: request.fastMode,
        syncModelsWithLead: request.syncModelsWithLead,
        limitContext: request.limitContext,
        skipPermissions: request.skipPermissions,
        worktree: request.worktree,
        extraCliArgs: request.extraCliArgs,
      },
      new AbortController().signal
    );
  };

  return {
    async createTeam(request, onProgress) {
      try {
        await deps.definitions.create(request, new AbortController().signal);
      } catch (error) {
        // A metadata-only draft already exists; keep its roster and only update launch fields.
        if (!(error instanceof TeamDefinitionExistsError)) throw error;
        if (!isActive(deps.lifecycle.runs.find(request.teamName))) {
          await persistLaunchSettings(request);
        }
      }
      return launch(request.teamName, onProgress);
    },

    async launchTeam(request, onProgress) {
      // Never rewrite the definition of a live run: its captured revision is fenced.
      if (!isActive(deps.lifecycle.runs.find(request.teamName))) {
        await persistLaunchSettings(request);
      }
      return launch(request.teamName, onProgress);
    },

    async cancelProvisioning(runId) {
      const snapshot = deps.lifecycle.runs.findByRunId(runId);
      if (!snapshot) throw new Error('Unknown runId');
      if (!PROVISIONING_STATES.has(snapshot.state))
        throw new Error('Provisioning cannot be cancelled in current state');
      await stop(snapshot.identity);
    },

    hasProvisioningRun(teamName) {
      const snapshot = deps.lifecycle.runs.find(teamName);
      return snapshot !== null && PROVISIONING_STATES.has(snapshot.state);
    },

    async getRuntimeState(teamName) {
      const snapshot = deps.lifecycle.runs.find(teamName);
      if (!snapshot) {
        return (
          (await deps.bootstrapRuntime?.read(teamName)) ?? {
            teamName,
            isAlive: false,
            runId: null,
            progress: null,
          }
        );
      }
      const runtime = toTeamRuntimeState(snapshot);
      if (snapshot.state === 'stopped') return { ...runtime, runId: null, progress: null };
      return { ...runtime, progress: toTeamProvisioningProgress(snapshot, deps.now()) };
    },

    stopTeam,

    async stopAllTeams() {
      const failures: { teamName: string; error: string }[] = [];
      for (const teamName of deps.lifecycle.runs.aliveTeamNames()) {
        try {
          await stopTeam(teamName);
        } catch (error) {
          failures.push({
            teamName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return failures;
    },

    isTeamAlive(teamName) {
      return deps.lifecycle.runs.aliveRunId(teamName) !== null;
    },

    getAliveTeams() {
      return [...deps.lifecycle.runs.aliveTeamNames()];
    },

    getAliveTeamNames() {
      return [...deps.lifecycle.runs.aliveTeamNames()];
    },

    hasActiveTeamRuntimes() {
      return pendingLaunchAdmissions > 0 || deps.lifecycle.runs.aliveTeamNames().length > 0;
    },

    getCurrentRunId(teamName) {
      return deps.lifecycle.runs.aliveRunId(teamName);
    },

    pendingLaunchAdmissions() {
      return pendingLaunchAdmissions;
    },

    async findByRunId(runId) {
      const snapshot = deps.lifecycle.runs.findByRunId(runId);
      if (snapshot) return toTeamProvisioningProgress(snapshot, deps.now());
      return deps.progressHistory.findByRunId(runId);
    },
  };
}
