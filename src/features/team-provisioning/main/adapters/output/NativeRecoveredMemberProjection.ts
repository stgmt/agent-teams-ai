import type { RecoveredMemberIdentity } from '../../../core/domain/MemberLifecycleRegistry';
import type { NativeRunRecovery } from './NodeNativeTeamConfig';

/** Project only persisted identities already verified by config recovery. */
export function projectRecoveredMembers(recovery: NativeRunRecovery): RecoveredMemberIdentity[] {
  return recovery.members.map((row) => ({
    memberName: String(row.name),
    role: row.recoveryRole === 'lead' ? 'lead' : 'member',
    generation: typeof row.runtimeGeneration === 'number' ? row.runtimeGeneration : 0,
    operationId: typeof row.runtimeOperationId === 'string' ? row.runtimeOperationId : null,
    process:
      typeof row.recoveryProcessStartedAt === 'number' &&
      typeof row.runtimePid === 'number' &&
      typeof row.runtimeProcessBirthId === 'string' &&
      (row.providerId ?? row.provider) !== 'opencode'
        ? { pid: row.runtimePid, birthId: row.runtimeProcessBirthId }
        : null,
    lane: null,
  }));
}

export function recoveredWorkspace(recovery: NativeRunRecovery) {
  const row =
    recovery.members.find((member) => member.recoveryRole === 'lead') ?? recovery.members[0];
  if (!row || typeof row.cwd !== 'string')
    throw new Error('Surviving run has no persisted workspace');
  return {
    workingDirectory: typeof row.worktreePath === 'string' ? row.worktreePath : row.cwd,
    ...(typeof row.worktreeGitRoot === 'string' && typeof row.worktreeBranch === 'string'
      ? { worktree: { baseRepoPath: row.worktreeGitRoot, branchName: row.worktreeBranch } }
      : {}),
  };
}
