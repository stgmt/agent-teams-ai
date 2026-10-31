import type {
  MemberLaneObservation,
  MemberProcessToken,
  OwnedProcessIdentity,
  TeamRunIdentity,
} from '../../../contracts';
import type { TeamMemberMcpPolicy } from '@shared/types';

export interface ConfiguredMemberLaunch {
  team: Readonly<TeamRunIdentity>;
  memberName: string;
  configurationRevision: string;
  providerId: string;
  model: string | null;
  providerBackendId?: string;
  effort?: string;
  fastMode?: 'inherit' | 'on' | 'off';
  role?: 'lead' | 'member';
  agentType?: string;
  mcpPolicy?: TeamMemberMcpPolicy;
  skipPermissions?: boolean;
  limitContext?: boolean;
  extraCliArgs?: string;
  workingDirectory: string;
  baseWorkingDirectory?: string;
  isolation?: 'worktree';
  taskLedgerProjectDirectory?: string;
  worktree?: Readonly<{
    baseRepoPath: string;
    branchName: string;
  }>;
  instructions: string;
}

export interface MemberLaunchSettingsPort {
  findConfiguredMember(
    team: TeamRunIdentity,
    memberName: string
  ): Promise<ConfiguredMemberLaunch | null>;
  /** Re-admits a member added after the original capture; attach uses this before resolving it. */
  admitConfiguredMember?(team: TeamRunIdentity, memberName: string): Promise<void>;
}

export interface OwnedMemberProcess extends OwnedMemberRuntime {
  identity: Readonly<OwnedProcessIdentity>;
}

/** Adapter-owned lane handle; the lane, not a member process, carries liveness. */
export interface OwnedMemberLane extends OwnedMemberRuntime {
  lane: Readonly<MemberLaneObservation>;
}

export interface OwnedMemberRuntime {
  // Replay observations buffered between runtime creation and subscription.
  subscribe(events: MemberRuntimeEvents): () => void;
  stop(): Promise<void>;
  writeInput(line: string): Promise<void>;
}

export interface MemberRuntimeEvents {
  connected(): void;
  connectionLost(): void;
  failed(error: string): void;
  releaseFailed(error: string): void;
  /** Process runtimes emit this before `released`; lane runtimes provide a no-op. */
  exited(exit: { code: number | null; signal: string | null }): void;
  /**
   * Terminal for the owned runtime. For a lane it is authoritative on its own:
   * the command clears a lane that never reported `laneLost` first.
   */
  released(): void;
  /** Adapter lane evidence; only lane runtimes emit these. */
  laneObserved?(observation: Readonly<MemberLaneObservation>): void;
  laneLost?(error?: string): void;
}

export interface MemberLaneGroupEvents {
  observed(memberName: string, observation: Readonly<MemberLaneObservation>): void;
  lost(memberName: string, error?: string): void;
  failed(memberName: string, error: string): void;
  released(): void;
}

/** One pending adapter permission, scoped to its lane member. */
export interface MemberLanePermission {
  memberName: string;
  requestId: string;
}

/** One adapter launch unit hosting several members in the same lane. */
export interface OwnedMemberLaneGroup {
  observations: Readonly<Record<string, Readonly<MemberLaneObservation>>>;
  subscribe(events: MemberLaneGroupEvents): () => void;
  stop(): Promise<void>;
  writeInput(memberName: string, line: string): Promise<void>;
  listPermissions?(): Promise<readonly MemberLanePermission[]>;
  answerPermission?(input: {
    memberName: string;
    requestId: string;
    allow: boolean;
    message?: string;
  }): Promise<void>;
}

export interface MemberRuntimePort {
  /** How this provider is backed; omitted means a member process. */
  kind?(providerId: string): 'process' | 'lane';
  spawn(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<OwnedMemberProcess>;
  /** Required when `kind` answers `lane` for a provider. */
  startLane?(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<OwnedMemberLane>;
  /** Aggregate lane launch: one adapter call binds every member of the lane. */
  startLaneGroup?(
    settings: readonly Readonly<ConfiguredMemberLaunch>[],
    tokens: readonly Readonly<MemberProcessToken>[],
    laneId: string,
    signal: AbortSignal
  ): Promise<OwnedMemberLaneGroup>;
}

export interface TeamRunResourcesPort {
  prepare(run: Readonly<TeamRunIdentity>, signal: AbortSignal): Promise<void>;
  release(run: Readonly<TeamRunIdentity>): Promise<void>;
}

export interface TeamOperationGate {
  run<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
}
