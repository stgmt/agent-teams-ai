import type { MemberProcessToken, OwnedProcessIdentity, TeamRunIdentity } from '../../../contracts';
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
}

export interface OwnedMemberProcess {
  identity: Readonly<OwnedProcessIdentity>;
  // Replay observations buffered between process creation and subscription.
  subscribe(events: MemberRuntimeEvents): () => void;
  stop(): Promise<void>;
  writeInput(line: string): Promise<void>;
}

export interface MemberRuntimeEvents {
  connected(): void;
  connectionLost(): void;
  failed(error: string): void;
  releaseFailed(error: string): void;
  exited(exit: { code: number | null; signal: string | null }): void;
  released(): void;
}

export interface MemberRuntimePort {
  spawn(
    settings: Readonly<ConfiguredMemberLaunch>,
    token: Readonly<MemberProcessToken>,
    signal: AbortSignal
  ): Promise<OwnedMemberProcess>;
}

export interface TeamRunResourcesPort {
  prepare(run: Readonly<TeamRunIdentity>, signal: AbortSignal): Promise<void>;
  release(run: Readonly<TeamRunIdentity>): Promise<void>;
}

export interface TeamOperationGate {
  run<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
}
