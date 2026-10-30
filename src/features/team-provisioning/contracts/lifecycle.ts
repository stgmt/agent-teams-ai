import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

export interface TeamRunIdentity extends AppConnectionContext {
  teamName: string;
  runId: string;
}

export interface MemberProcessToken extends TeamRunIdentity {
  memberName: string;
  generation: number;
  operationId: string;
}

/** Destructive member commands must name the generation observed by their caller. */
export interface MemberGenerationTarget extends TeamRunIdentity {
  memberName: string;
  generation: number;
}

export interface OwnedProcessIdentity {
  pid: number;
  birthId: string;
}

/**
 * Adapter-owned runtime lane. OpenCode members run inside a shared host, so the
 * lane carries its own liveness evidence instead of a member process handle.
 */
export interface MemberLaneObservation {
  laneId: string;
  sessionId: string | null;
  /** Host process shared by several members; never a member-owned pid. */
  hostPid: number | null;
  runtimeAlive: boolean;
  bootstrapConfirmed: boolean;
  permissionBlocked: boolean;
  /** Adapter-reported hard failure for this member, if any. */
  failure?: string | null;
  /** Pending permission request ids owned by this member. */
  pendingPermissionRequestIds?: readonly string[];
}

export type MemberPhase =
  | 'stopped'
  | 'starting'
  | 'connecting'
  | 'ready'
  | 'unresponsive'
  | 'stopping'
  | 'exited'
  | 'failed';

export interface ConfiguredMemberIdentity {
  memberName: string;
  role: 'lead' | 'member';
}

/** One adapter lane and the configured members it hosts. */
export interface TeamLaneGroup {
  laneId: string;
  memberNames: readonly string[];
}

export interface MemberLifecycleSnapshot extends ConfiguredMemberIdentity {
  membership: 'configured' | 'removed';
  desired: 'running' | 'stopped';
  phase: MemberPhase;
  resources: TeamRunResourceState;
  generation: number;
  operationId: string | null;
  process: Readonly<OwnedProcessIdentity> | null;
  /** Adapter-owned lane when the member is not backed by its own process. */
  lane: Readonly<MemberLaneObservation> | null;
  everConnected: boolean;
  skippedForLaunch: boolean;
  error: string | null;
  exit: Readonly<{ code: number | null; signal: string | null }> | null;
}

export type TeamRunResourceState =
  | 'preparing'
  | 'held'
  | 'releasing'
  | 'released'
  | 'release-failed';

export type TeamLifecycleState =
  | 'preparing'
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'failed'
  | 'stopping'
  | 'stopped'
  | 'release-failed';

export interface TeamLifecycleSnapshot {
  identity: Readonly<TeamRunIdentity>;
  desired: 'running' | 'stopped';
  resources: TeamRunResourceState;
  state: TeamLifecycleState;
  error: string | null;
  version: number;
  /** When this run was admitted; it never changes for the run's lifetime. */
  startedAt: string;
  members: Readonly<Record<string, Readonly<MemberLifecycleSnapshot>>>;
}

/**
 * Identity and liveness registry for one application owner. It is not a
 * run-payload store: approvals, relay, logs and live lead messages keep their
 * own run-scoped state and must not grow a second copy here.
 *
 * Composition-internal: reads are not context-fenced, so IPC/HTTP consumers
 * use the bound lifecycle queries instead.
 */
export interface TeamRunRegistryRead {
  /** Registered run for a team, including a stopped run kept as history. */
  find(teamName: string): Readonly<TeamLifecycleSnapshot> | null;
  /** Registered run by id, including stopped history; used by cancel and status. */
  findByRunId(runId: string): Readonly<TeamLifecycleSnapshot> | null;
  /** Registered identity match, including stopped history. */
  hasRun(run: Readonly<TeamRunIdentity>): boolean;
  /** Registered and still owning the run: not stopped, released, or release-failed. */
  isLive(run: Readonly<TeamRunIdentity>): boolean;
  aliveTeamNames(): readonly string[];
  aliveRunId(teamName: string): string | null;
}

/** Latest authoritative snapshots; returning the iterator releases its subscription. */
export interface TeamLifecycleFeed extends AsyncIterator<
  Readonly<TeamLifecycleSnapshot>,
  undefined,
  void
> {
  return(): Promise<IteratorResult<Readonly<TeamLifecycleSnapshot>, undefined>>;
  [Symbol.asyncIterator](): TeamLifecycleFeed;
}

export type MemberStartAdmission =
  | { kind: 'launch'; token: Readonly<MemberProcessToken> }
  | { kind: 'pending'; token: Readonly<MemberProcessToken> }
  | { kind: 'already-running' }
  | { kind: 'stopping' };
