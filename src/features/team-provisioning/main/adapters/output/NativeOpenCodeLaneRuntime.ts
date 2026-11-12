import { buildOpenCodeSecondaryLaneId } from '@features/team-runtime-lanes';

import type { MemberLaneObservation, MemberProcessToken } from '../../../contracts';
import type {
  ConfiguredMemberLaunch,
  MemberLaneGroupEvents,
  MemberLanePermission,
  MemberRuntimeEvents,
  MemberRuntimePort,
  OwnedMemberLane,
  OwnedMemberLaneGroup,
  OwnedMemberProcess,
} from '../../../core/application/ports/MemberRuntimePorts';
import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeReconcileInput,
} from '@main/services/team/runtime';
import type { EffortLevel, PersistedTeamLaunchSnapshot } from '@shared/types';

export interface NativeOpenCodeLaneRuntimeDependencies {
  adapter: Pick<
    TeamLaunchRuntimeAdapter,
    'launch' | 'reconcile' | 'stop' | 'answerRuntimePermission' | 'listRuntimePermissions'
  >;
  /** Persisted launch history; native progress persistence is a phase 7 gap. */
  previousLaunchState?: PersistedTeamLaunchSnapshot | null;
  reconcileIntervalMs?: number;
}

const DEFAULT_RECONCILE_INTERVAL_MS = 2_000;

function toObservation(
  evidence: TeamRuntimeMemberLaunchEvidence,
  laneId: string
): MemberLaneObservation {
  const pendingRequests = [
    ...(evidence.pendingPermissionRequestIds ?? []),
    ...(evidence.pendingApprovals ?? []).map((entry) => entry.requestId),
    ...(evidence.pendingPermissions ?? []).map((entry) => entry.requestId),
  ];
  const pendingPermissionRequestIds = [...new Set(pendingRequests)].filter((id) => id.trim());
  return {
    laneId,
    sessionId: evidence.sessionId?.trim() || null,
    hostPid: evidence.runtimePid ?? null,
    runtimeAlive: evidence.runtimeAlive === true,
    bootstrapConfirmed: evidence.bootstrapConfirmed === true,
    permissionBlocked:
      pendingPermissionRequestIds.length > 0 || evidence.livenessKind === 'permission_blocked',
    ...(evidence.hardFailure
      ? { failure: evidence.hardFailureReason ?? 'OpenCode lane member failed' }
      : {}),
    ...(pendingPermissionRequestIds.length > 0 ? { pendingPermissionRequestIds } : {}),
  };
}

function memberSpec(settings: Readonly<ConfiguredMemberLaunch>) {
  return {
    name: settings.memberName,
    role: settings.role,
    providerId: 'opencode' as const,
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort as EffortLevel } : {}),
    cwd: settings.workingDirectory,
    ...(settings.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
  };
}

/** One adapter lane launched with its whole roster; reconcile keeps it live. */
class OpenCodeLaneGroup implements OwnedMemberLaneGroup {
  observations: Readonly<Record<string, Readonly<MemberLaneObservation>>>;
  private events: MemberLaneGroupEvents | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconciling = false;

  constructor(
    private readonly deps: NativeOpenCodeLaneRuntimeDependencies,
    private readonly input: TeamRuntimeLaunchInput,
    observations: Record<string, MemberLaneObservation>
  ) {
    this.observations = Object.freeze(observations);
  }

  subscribe(events: MemberLaneGroupEvents): () => void {
    if (this.timer) clearInterval(this.timer);
    this.events = events;
    this.timer = setInterval(
      () => void this.reconcile(),
      this.deps.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS
    );
    this.timer.unref?.();
    return () => this.detach();
  }

  async stop(): Promise<void> {
    this.detach();
    await this.deps.adapter.stop({
      runId: this.input.runId,
      teamName: this.input.teamName,
      ...(this.input.laneId ? { laneId: this.input.laneId } : {}),
      cwd: this.input.cwd,
      providerId: 'opencode',
      reason: 'user_requested',
      previousLaunchState: this.input.previousLaunchState,
    });
  }

  async writeInput(): Promise<void> {
    // OpenCode delivery is owned by the inbox relay, not a stdin pipe.
    throw new Error('OpenCode lane input is delivered through the inbox relay');
  }

  async listPermissions(): Promise<readonly MemberLanePermission[]> {
    const list = this.deps.adapter.listRuntimePermissions;
    if (!list) return [];
    const result = await list.call(this.deps.adapter, {
      teamName: this.input.teamName,
      ...(this.input.laneId ? { laneId: this.input.laneId } : {}),
      cwd: this.input.cwd,
    });
    const permissions: MemberLanePermission[] = [];
    for (const permission of result.permissions) {
      const member =
        Object.entries(this.observations).find(
          ([, observation]) =>
            permission.sessionId != null && observation.sessionId === permission.sessionId
        ) ??
        Object.entries(this.observations).find(([, observation]) =>
          observation.pendingPermissionRequestIds?.includes(permission.requestId)
        );
      if (member) permissions.push({ memberName: member[0], requestId: permission.requestId });
    }
    return permissions;
  }

  async answerPermission(input: {
    memberName: string;
    requestId: string;
    allow: boolean;
    message?: string;
  }): Promise<void> {
    const answer = this.deps.adapter.answerRuntimePermission;
    if (!answer) throw new Error('Adapter permission answers are not available');
    await answer.call(this.deps.adapter, {
      runId: this.input.runId,
      teamName: this.input.teamName,
      ...(this.input.laneId ? { laneId: this.input.laneId } : {}),
      cwd: this.input.cwd,
      providerId: 'opencode',
      memberName: input.memberName,
      requestId: input.requestId,
      decision: input.allow ? 'allow' : 'reject',
      ...(input.message ? { message: input.message } : {}),
      expectedMembers: this.input.expectedMembers,
      previousLaunchState: this.input.previousLaunchState,
    });
  }

  private detach(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.events = null;
  }

  private async reconcile(): Promise<void> {
    if (this.reconciling || !this.events) return;
    this.reconciling = true;
    const events = this.events;
    try {
      const input: TeamRuntimeReconcileInput = {
        runId: this.input.runId,
        teamName: this.input.teamName,
        ...(this.input.laneId ? { laneId: this.input.laneId } : {}),
        providerId: 'opencode',
        expectedMembers: this.input.expectedMembers,
        previousLaunchState: this.input.previousLaunchState,
        reason: 'launch_progress',
      };
      const result = await this.deps.adapter.reconcile(input);
      if (result.observationUnavailable) return;
      // A detached or replaced subscription must not receive late evidence.
      if (this.events !== events) return;
      const next: Record<string, MemberLaneObservation> = {};
      for (const [memberName, evidence] of Object.entries(result.members)) {
        const previous = this.observations[memberName];
        if (!previous) continue;
        const observation = toObservation(evidence, previous.laneId);
        next[memberName] = observation;
        if (observation.failure && !previous.failure) {
          events.failed(memberName, observation.failure);
        } else if (previous.runtimeAlive && !observation.runtimeAlive) {
          events.lost(memberName);
        } else {
          events.observed(memberName, observation);
        }
      }
      this.observations = Object.freeze({ ...this.observations, ...next });
    } catch {
      // Observation failures keep the last known evidence; stop/launch still owns the lane.
    } finally {
      this.reconciling = false;
    }
  }
}

/** Single-member view over a lane group, used by the per-member restart path. */
class OpenCodeSingleLane implements OwnedMemberLane {
  lane: Readonly<MemberLaneObservation>;

  constructor(
    private readonly group: OwnedMemberLaneGroup,
    private readonly memberName: string
  ) {
    this.lane = group.observations[memberName]!;
  }

  subscribe(events: MemberRuntimeEvents): () => void {
    return this.group.subscribe({
      observed: (memberName, observation) => {
        if (memberName !== this.memberName) return;
        this.lane = observation;
        events.laneObserved?.(observation);
      },
      lost: (memberName, error) => {
        if (memberName === this.memberName) events.laneLost?.(error);
      },
      failed: (memberName, error) => {
        if (memberName === this.memberName) events.failed(error);
      },
      released: () => events.released(),
    });
  }

  stop(): Promise<void> {
    return this.group.stop();
  }

  writeInput(line: string): Promise<void> {
    return this.group.writeInput(this.memberName, line);
  }
}

/** Native lane runtime for OpenCode teams; the adapter owns host/session state. */
export class NativeOpenCodeLaneRuntime implements MemberRuntimePort {
  constructor(private readonly deps: NativeOpenCodeLaneRuntimeDependencies) {}

  kind(): 'lane' {
    return 'lane';
  }

  async spawn(): Promise<OwnedMemberProcess> {
    throw new Error('OpenCode members run in adapter lanes, not member processes');
  }

  async observeExisting(input: TeamRuntimeLaunchInput): Promise<OwnedMemberLaneGroup> {
    const result = await this.deps.adapter.reconcile({
      runId: input.runId,
      teamName: input.teamName,
      laneId: input.laneId,
      providerId: 'opencode',
      expectedMembers: input.expectedMembers,
      previousLaunchState: input.previousLaunchState,
      reason: 'startup_recovery',
    });
    if (
      result.observationUnavailable ||
      result.runId !== input.runId ||
      result.teamName !== input.teamName
    )
      throw new Error('Surviving OpenCode lane observation is unavailable');
    const observations: Record<string, MemberLaneObservation> = {};
    for (const member of input.expectedMembers) {
      const evidence = result.members[member.name];
      if (!evidence) throw new Error(`Surviving lane evidence is missing for ${member.name}`);
      observations[member.name] = toObservation(evidence, input.laneId ?? 'primary');
    }
    return new OpenCodeLaneGroup(this.deps, input, observations);
  }

  async startLane(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<OwnedMemberLane> {
    const group = await this.startLaneGroup(
      [settings],
      [token],
      buildOpenCodeSecondaryLaneId({ name: token.memberName }),
      signal
    );
    return new OpenCodeSingleLane(group, token.memberName);
  }

  async startLaneGroup(
    settings: readonly Readonly<ConfiguredMemberLaunch>[],
    tokens: readonly Readonly<MemberProcessToken>[],
    laneId: string,
    signal: AbortSignal
  ): Promise<OwnedMemberLaneGroup> {
    signal.throwIfAborted();
    const [firstSetting] = settings;
    const [token] = tokens;
    if (!firstSetting || !token)
      throw new Error('OpenCode lane launch requires a configured roster');
    // A primary lane is launched by its lead; a secondary lane holds one member and
    // has no lead at all, so that member is its launch subject.
    const subject = settings.find((entry) => entry.role === 'lead') ?? firstSetting;
    if (settings.some((entry) => entry.providerId !== 'opencode'))
      throw new Error('OpenCode lane launch accepts only OpenCode members');
    const input: TeamRuntimeLaunchInput = {
      runId: token.runId,
      teamName: token.teamName,
      laneId,
      cwd: subject.workingDirectory,
      ...(subject.instructions.trim() ? { prompt: subject.instructions } : {}),
      providerId: 'opencode',
      ...(subject.model ? { model: subject.model } : {}),
      ...(subject.effort ? { effort: subject.effort as EffortLevel } : {}),
      skipPermissions: subject.skipPermissions !== false,
      expectedMembers: settings.map(memberSpec),
      previousLaunchState: this.deps.previousLaunchState ?? null,
    };
    const result = await this.deps.adapter.launch(input);
    if (result.preLaunchGate?.blocked) throw new Error(result.preLaunchGate.reason);
    if (signal.aborted) {
      await this.stopLane(input);
      signal.throwIfAborted();
    }
    try {
      const observations: Record<string, MemberLaneObservation> = {};
      for (const entry of tokens) {
        const evidence = result.members[entry.memberName];
        if (!evidence) throw new Error(`OpenCode lane evidence is missing for ${entry.memberName}`);
        observations[entry.memberName] = toObservation(evidence, laneId);
      }
      return new OpenCodeLaneGroup(this.deps, input, observations);
    } catch (error) {
      await this.stopLane(input);
      throw error;
    }
  }

  private stopLane(input: TeamRuntimeLaunchInput): Promise<unknown> {
    return this.deps.adapter.stop({
      runId: input.runId,
      teamName: input.teamName,
      ...(input.laneId ? { laneId: input.laneId } : {}),
      cwd: input.cwd,
      providerId: 'opencode',
      reason: 'cleanup',
      previousLaunchState: input.previousLaunchState,
    });
  }
}
