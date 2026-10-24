import { isProcessAlive } from '@main/utils/processHealth';

import {
  type MemberRuntimeProcessState,
  MemberRuntimeRestartError,
} from './MemberRuntimeRestartError';
import { matchesMemberNameOrBase } from './TeamProvisioningMemberIdentity';

import type { TeamMembersMetaStore } from '../TeamMembersMetaStore';
import type {
  EffectiveConfiguredMember,
  LiveRosterAttachReason,
  PersistedRuntimeMemberLike,
  ProvisioningRun,
} from './TeamProvisioningMemberLifecycleTypes';
import type { TeamConfig } from '@shared/types';

export interface RestartOrAttachDirectProcessMemberInput {
  run: ProvisioningRun;
  teamName: string;
  memberName: string;
  config: TeamConfig;
  metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>;
  configuredMember: EffectiveConfiguredMember;
  options?: { reason?: LiveRosterAttachReason };
}

export interface MemberRestartFailureContext {
  teamName: string;
  memberName: string;
  reason: LiveRosterAttachReason | undefined;
  /** Pids of the teammate seen while the restart ran. */
  knownRuntimePids: ReadonlySet<number>;
  readPersistedMembers(): readonly PersistedRuntimeMemberLike[];
  diagnostic(message: string): void;
}

/** What is left of the teammate's process: any recorded or observed pid still alive. */
export function readMemberRuntimeProcessState(
  memberName: string,
  knownRuntimePids: ReadonlySet<number>,
  persistedMembers: readonly PersistedRuntimeMemberLike[]
): MemberRuntimeProcessState {
  const pids = new Set(knownRuntimePids);
  for (const member of persistedMembers) {
    const candidateName = typeof member.name === 'string' ? member.name.trim() : '';
    if (
      candidateName.length > 0 &&
      matchesMemberNameOrBase(candidateName, memberName) &&
      typeof member.runtimePid === 'number'
    ) {
      pids.add(member.runtimePid);
    }
  }
  return [...pids].some((pid) => Number.isFinite(pid) && pid > 0 && isProcessAlive(pid))
    ? 'running'
    : 'stopped';
}

export interface MemberLaunchTraceContext<TOperation extends string> {
  teamName: string;
  memberName: string;
  operation: TOperation;
  diagnostic(message: string): void;
}

/** Writes when a teammate launch starts, ends and how long it took; the launch result is untouched. */
export async function traceMemberLaunch<TOperation extends string, TResult>(
  context: MemberLaunchTraceContext<TOperation>,
  launch: (operation: TOperation) => Promise<TResult>
): Promise<TResult> {
  const { teamName, memberName, operation } = context;
  const startedAt = Date.now();
  context.diagnostic(`[${teamName}] Launching teammate "${memberName}" (${operation})`);
  try {
    const result = await launch(operation);
    context.diagnostic(
      `[${teamName}] Launched teammate "${memberName}" (${operation}) in ${Date.now() - startedAt} ms`
    );
    return result;
  } catch (error) {
    context.diagnostic(
      `[${teamName}] Launch of teammate "${memberName}" (${operation}) failed after ${Date.now() - startedAt} ms: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw error;
  }
}

/**
 * The error to throw for a failed restart. Only a `member_updated` restart reports what is left of
 * the teammate's process; any other failure, and one already reported, passes through unchanged.
 */
export function toMemberRestartError(
  error: unknown,
  context: MemberRestartFailureContext
): unknown {
  if (context.reason !== 'member_updated' || error instanceof MemberRuntimeRestartError) {
    return error;
  }
  const cause = error instanceof Error ? error.message : String(error);
  const memberProcess = readMemberRuntimeProcessState(
    context.memberName,
    context.knownRuntimePids,
    context.readPersistedMembers()
  );
  context.diagnostic(
    `[${context.teamName}] Restart of teammate "${context.memberName}" failed, process is ${memberProcess}: ${cause}`
  );
  return new MemberRuntimeRestartError(cause, memberProcess, error);
}
