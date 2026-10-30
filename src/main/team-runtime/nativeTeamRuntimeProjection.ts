import type {
  MemberLifecycleSnapshot,
  TeamLifecycleSnapshot,
} from '@features/team-provisioning/contracts';
import type {
  MemberLaunchState,
  MemberSpawnStatus,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeSnapshot,
  TeamRuntimeState,
} from '@shared/types';

/** A process handle is the only current liveness evidence; a phase name is not. */
function hasProcess(member: MemberLifecycleSnapshot): boolean {
  return member.process !== null;
}

function spawnStatus(member: MemberLifecycleSnapshot): MemberSpawnStatus {
  switch (member.phase) {
    case 'ready':
    case 'unresponsive':
      return 'online';
    case 'starting':
    case 'connecting':
      return 'spawning';
    case 'failed':
      return 'error';
    case 'stopping':
      return 'waiting';
    case 'stopped':
    case 'exited':
      return member.skippedForLaunch ? 'skipped' : 'offline';
  }
}

function launchState(member: MemberLifecycleSnapshot): MemberLaunchState {
  switch (member.phase) {
    case 'ready':
    case 'unresponsive':
      return 'confirmed_alive';
    case 'starting':
    case 'connecting':
      return 'runtime_pending_bootstrap';
    case 'failed':
      return 'failed_to_start';
    case 'stopping':
    case 'stopped':
    case 'exited':
      // The DTO has no terminal launch state. `status` carries offline/skipped; polling
      // must not treat this value as pending (see hasUnresolvedMemberSpawnStatus).
      return member.skippedForLaunch ? 'skipped_for_launch' : 'starting';
  }
}

/** Current lifecycle only; persisted launch metadata is not an input here. */
export function toTeamRuntimeState(snapshot: Readonly<TeamLifecycleSnapshot>): TeamRuntimeState {
  return {
    teamName: snapshot.identity.teamName,
    isAlive: Object.values(snapshot.members).some(
      (member) => member.membership === 'configured' && hasProcess(member)
    ),
    runId: snapshot.identity.runId,
    progress: null,
  };
}

export function toTeamAgentRuntimeSnapshot(
  snapshot: Readonly<TeamLifecycleSnapshot>,
  now: string
): TeamAgentRuntimeSnapshot {
  const members: Record<string, TeamAgentRuntimeEntry> = {};
  for (const member of Object.values(snapshot.members)) {
    if (member.membership !== 'configured') continue;
    const alive = hasProcess(member);
    members[member.memberName] = {
      memberName: member.memberName,
      alive,
      // The lead has its own restart path; only a configured teammate is a member restart target.
      restartable: member.role === 'member',
      backendType: member.role === 'lead' ? 'lead' : 'process',
      ...(member.process ? { pid: member.process.pid, runtimePid: member.process.pid } : {}),
      ...(alive
        ? {
            livenessKind:
              member.phase === 'ready'
                ? ('confirmed_bootstrap' as const)
                : ('runtime_process' as const),
          }
        : {}),
      ...(member.phase === 'failed' && member.error
        ? { runtimeDiagnostic: member.error, runtimeDiagnosticSeverity: 'error' as const }
        : {}),
      ...(member.phase === 'unresponsive'
        ? {
            runtimeDiagnostic: 'connection lost',
            runtimeDiagnosticSeverity: 'warning' as const,
          }
        : {}),
      updatedAt: now,
    };
  }
  return {
    teamName: snapshot.identity.teamName,
    updatedAt: now,
    runId: snapshot.identity.runId,
    members,
  };
}

export function toMemberSpawnStatuses(
  snapshot: Readonly<TeamLifecycleSnapshot>,
  now: string
): MemberSpawnStatusesSnapshot {
  const statuses: MemberSpawnStatusesSnapshot['statuses'] = {};
  const expectedMembers: string[] = [];
  for (const member of Object.values(snapshot.members)) {
    if (member.membership !== 'configured' || member.role === 'lead') continue;
    const alive = hasProcess(member);
    expectedMembers.push(member.memberName);
    statuses[member.memberName] = {
      status: spawnStatus(member),
      launchState: launchState(member),
      runtimeAlive: alive,
      ...(member.phase === 'failed' && member.error
        ? { error: member.error, hardFailure: true }
        : {}),
      ...(member.skippedForLaunch ? { skippedForLaunch: true } : {}),
      ...(member.phase === 'ready'
        ? { livenessSource: 'heartbeat' as const, livenessKind: 'confirmed_bootstrap' as const }
        : alive
          ? { livenessSource: 'process' as const, livenessKind: 'runtime_process' as const }
          : {}),
      ...(member.phase === 'failed' && member.error
        ? { runtimeDiagnostic: member.error, runtimeDiagnosticSeverity: 'error' as const }
        : {}),
      ...(member.phase === 'unresponsive'
        ? {
            runtimeDiagnostic: 'connection lost',
            runtimeDiagnosticSeverity: 'warning' as const,
          }
        : {}),
      // Lifecycle snapshots carry no per-member timestamp; `now` is the projection time,
      // not a claim that the member status changed at this instant.
      updatedAt: now,
    };
  }
  return {
    statuses,
    runId: snapshot.identity.runId,
    expectedMembers: expectedMembers.sort((a, b) => a.localeCompare(b)),
    updatedAt: now,
    source: 'live',
  };
}
