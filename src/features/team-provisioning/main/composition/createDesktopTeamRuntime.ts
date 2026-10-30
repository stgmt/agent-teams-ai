import { toTeamProvisioningProgress } from '@main/team-runtime/nativeTeamProgressProjection';
import { toTeamRuntimeState } from '@main/team-runtime/nativeTeamRuntimeProjection';

import type { TeamRunIdentity } from '../../contracts';
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
  isTeamAlive(teamName: string): boolean;
  getAliveTeams(): string[];
  getCurrentRunId(teamName: string): string | null;
}

const TERMINAL_STATES = new Set(['ready', 'degraded', 'failed', 'stopped', 'release-failed']);

function hasOwnedProcess(snapshot: ReturnType<NativeTeamLifecycle['snapshot']>): boolean {
  return Object.values(snapshot.members).some(
    (member) => member.membership === 'configured' && member.process !== null
  );
}

export function createDesktopTeamRuntime(deps: DesktopTeamRuntimeDependencies): DesktopTeamRuntime {
  const context = (): Readonly<AppConnectionContext> => Object.freeze({ ...deps.currentContext() });
  const emit = (
    snapshot: NonNullable<ReturnType<NativeTeamLifecycle['snapshot']>>,
    onProgress: (progress: TeamProvisioningProgress) => void,
    last: { version: number }
  ): void => {
    if (snapshot.version === last.version) return;
    last.version = snapshot.version;
    onProgress(toTeamProvisioningProgress(snapshot, deps.now()));
  };

  const launch = async (
    teamName: string,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> => {
    const before = deps.lifecycle.runs.find(teamName);
    const alreadyRunning = before ? before.desired === 'running' && hasOwnedProcess(before) : false;
    const alreadyLaunching = before
      ? before.desired === 'running' && !hasOwnedProcess(before)
      : false;
    const previousRunId = before?.identity.runId ?? null;
    const feed = deps.lifecycle.watch(teamName);
    const last = { version: -1 };
    let admittedRunId: string | null = null;
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await feed.return();
    };
    void (async () => {
      try {
        for (;;) {
          const next = await feed.next();
          if (next.done || closed) return;
          const snapshot = next.value;
          // The feed replays the last stopped run; it is not this launch's progress.
          if (snapshot.identity.runId === previousRunId) continue;
          emit(snapshot, onProgress, last);
          if (admittedRunId && snapshot.identity.runId === admittedRunId) {
            if (TERMINAL_STATES.has(snapshot.state)) return;
          }
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
        expectedContext: context(),
        teamName,
      });
      const runId = receipt.run.runId;
      admittedRunId = runId;
      const current = deps.lifecycle.runs.findByRunId(runId);
      if (current) emit(current, onProgress, last);
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
      const observed = admittedRunId
        ? deps.lifecycle.runs.findByRunId(admittedRunId)
        : deps.lifecycle.runs.find(teamName);
      if (observed && observed.identity.runId !== previousRunId) emit(observed, onProgress, last);
      await close();
      throw error;
    }
  };

  const stop = async (run: Readonly<TeamRunIdentity>): Promise<void> => {
    await deps.lifecycle.commands.stop({
      expectedContext: context(),
      teamName: run.teamName,
      runId: run.runId,
    });
  };

  return {
    async createTeam(request, onProgress) {
      await deps.definitions.create(request, new AbortController().signal);
      return launch(request.teamName, onProgress);
    },

    async launchTeam(request, onProgress) {
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
      return launch(request.teamName, onProgress);
    },

    async cancelProvisioning(runId) {
      const snapshot = deps.lifecycle.runs.findByRunId(runId);
      if (!snapshot) throw new Error('Unknown runId');
      if (snapshot.desired !== 'running')
        throw new Error('Provisioning cannot be cancelled in current state');
      await stop(snapshot.identity);
    },

    hasProvisioningRun(teamName) {
      return deps.lifecycle.runs.find(teamName)?.desired === 'running';
    },

    async getRuntimeState(teamName) {
      const snapshot = deps.lifecycle.runs.find(teamName);
      if (!snapshot) return { teamName, isAlive: false, runId: null, progress: null };
      return toTeamRuntimeState(snapshot);
    },

    async stopTeam(teamName) {
      const snapshot = deps.lifecycle.runs.find(teamName);
      if (!snapshot || snapshot.desired !== 'running') return;
      await stop(snapshot.identity);
    },

    isTeamAlive(teamName) {
      return deps.lifecycle.runs.aliveRunId(teamName) !== null;
    },

    getAliveTeams() {
      return [...deps.lifecycle.runs.aliveTeamNames()];
    },

    getCurrentRunId(teamName) {
      return deps.lifecycle.runs.aliveRunId(teamName);
    },

    async findByRunId(runId) {
      const snapshot = deps.lifecycle.runs.findByRunId(runId);
      if (snapshot) return toTeamProvisioningProgress(snapshot, deps.now());
      return deps.progressHistory.findByRunId(runId);
    },
  };
}
