import { memberIsLive } from '@features/team-provisioning';

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

function isLaneBlocked(member: MemberLifecycleSnapshot): boolean {
  return member.lane !== null && member.lane.permissionBlocked;
}

function lanePendingBootstrap(member: MemberLifecycleSnapshot): boolean {
  return member.lane !== null && member.lane.runtimeAlive && !member.lane.bootstrapConfirmed;
}

function spawnStatus(member: MemberLifecycleSnapshot): MemberSpawnStatus {
  // Terminal phases win over lane heuristics: a failed lane is an error, not "waiting".
  if (member.phase === 'failed') return 'error';
  if (member.phase === 'stopped' || member.phase === 'exited')
    return member.skippedForLaunch ? 'skipped' : 'offline';
  if (isLaneBlocked(member)) return 'spawning';
  if (lanePendingBootstrap(member)) return 'spawning';
  if (member.lane !== null && !member.lane.runtimeAlive) return 'waiting';
  switch (member.phase) {
    case 'ready':
    case 'unresponsive':
      return 'online';
    case 'starting':
    case 'connecting':
      return 'spawning';
    case 'stopping':
      return 'waiting';
  }
}

function launchState(member: MemberLifecycleSnapshot): MemberLaunchState {
  if (isLaneBlocked(member)) return 'runtime_pending_permission';
  if (lanePendingBootstrap(member)) return 'runtime_pending_bootstrap';
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

function livenessKind(
  member: MemberLifecycleSnapshot
): 'confirmed_bootstrap' | 'runtime_process' | 'permission_blocked' | null {
  if (isLaneBlocked(member)) return 'permission_blocked';
  if (member.lane !== null) {
    if (!member.lane.runtimeAlive) return null;
    return member.lane.bootstrapConfirmed ? 'confirmed_bootstrap' : 'runtime_process';
  }
  if (member.process === null) return null;
  return member.phase === 'ready' ? 'confirmed_bootstrap' : 'runtime_process';
}

/** Current lifecycle only; persisted launch metadata is not an input here. */
export function toTeamRuntimeState(snapshot: Readonly<TeamLifecycleSnapshot>): TeamRuntimeState {
  return {
    teamName: snapshot.identity.teamName,
    isAlive: Object.values(snapshot.members).some(
      (member) => member.membership === 'configured' && memberIsLive(member)
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
    const alive = memberIsLive(member);
    const lane = member.lane;
    // A terminal lifecycle phase with no live process is authoritative stopped
    // evidence. Starting, permission-blocked and still-live members stay distinct.
    const kind =
      livenessKind(member) ??
      (!alive && (member.phase === 'stopped' || member.phase === 'exited') ? 'not_found' : null);
    members[member.memberName] = {
      memberName: member.memberName,
      alive,
      // The lead has its own restart path; only a configured teammate is a member restart target.
      // An adapter lane restart is not wired yet, so a lane member is not restartable.
      restartable: member.role === 'member' && lane === null,
      backendType: member.role === 'lead' ? 'lead' : 'process',
      ...(member.process ? { pid: member.process.pid, runtimePid: member.process.pid } : {}),
      ...(lane
        ? {
            laneId: lane.laneId,
            ...(lane.hostPid !== null
              ? { runtimeLoadScope: 'shared-host' as const, pidSource: 'opencode_bridge' as const }
              : {}),
          }
        : {}),
      ...(kind ? { livenessKind: kind } : {}),
      ...(member.phase === 'failed'
        ? {
            ...(member.error ? { runtimeDiagnostic: member.error } : {}),
            runtimeDiagnosticSeverity: 'error' as const,
          }
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
    const alive = memberIsLive(member);
    const lane = member.lane;
    const kind = livenessKind(member);
    expectedMembers.push(member.memberName);
    statuses[member.memberName] = {
      status: spawnStatus(member),
      launchState: launchState(member),
      runtimeAlive: alive,
      ...(member.phase === 'failed' && member.error
        ? { error: member.error, hardFailure: true }
        : {}),
      ...(member.skippedForLaunch ? { skippedForLaunch: true } : {}),
      ...(lane?.bootstrapConfirmed ||
      (lane === null && member.process !== null && member.phase === 'ready')
        ? { livenessSource: 'heartbeat' as const }
        : alive
          ? { livenessSource: 'process' as const }
          : {}),
      ...(kind ? { livenessKind: kind } : {}),
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
