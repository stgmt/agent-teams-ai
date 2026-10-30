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

export interface MemberLifecycleSnapshot extends ConfiguredMemberIdentity {
  membership: 'configured' | 'removed';
  desired: 'running' | 'stopped';
  phase: MemberPhase;
  resources: TeamRunResourceState;
  generation: number;
  operationId: string | null;
  process: Readonly<OwnedProcessIdentity> | null;
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
  members: Readonly<Record<string, Readonly<MemberLifecycleSnapshot>>>;
}

/** Read-only run lookup for approvals, task activity, relay, logs and cleanup. */
export interface TeamRunRegistryRead {
  find(teamName: string): Readonly<TeamLifecycleSnapshot> | null;
  hasRun(run: Readonly<TeamRunIdentity>): boolean;
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
