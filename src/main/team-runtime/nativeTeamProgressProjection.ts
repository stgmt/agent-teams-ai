import type { TeamLifecycleSnapshot } from '@features/team-provisioning/contracts';
import type { TeamProvisioningProgress } from '@shared/types';

function unavailableMembers(snapshot: Readonly<TeamLifecycleSnapshot>): string[] {
  return Object.values(snapshot.members)
    .filter(
      (member) =>
        member.membership === 'configured' &&
        !member.skippedForLaunch &&
        member.role === 'member' &&
        (member.desired !== 'running' ||
          ['stopped', 'stopping', 'exited', 'failed', 'unresponsive'].includes(member.phase))
    )
    .map((member) => member.memberName)
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Derives provisioning progress from the authoritative lifecycle snapshot.
 * Nothing is stored: a run that left the registry has no progress, and the
 * caller must read persisted history for it instead.
 */
export function toTeamProvisioningProgress(
  snapshot: Readonly<TeamLifecycleSnapshot>,
  now: string
): TeamProvisioningProgress {
  const base = {
    runId: snapshot.identity.runId,
    teamName: snapshot.identity.teamName,
    startedAt: snapshot.startedAt,
    updatedAt: now,
  };
  switch (snapshot.state) {
    case 'preparing':
      return { ...base, state: 'configuring', message: 'Preparing team run' };
    case 'starting':
      return { ...base, state: 'spawning', message: 'Starting team members' };
    case 'ready':
      return {
        ...base,
        state: 'ready',
        message: 'Team is running',
        configReady: true,
      };
    case 'degraded': {
      const unavailable = unavailableMembers(snapshot);
      return {
        ...base,
        state: 'ready',
        message:
          unavailable.length > 0
            ? `Team is running; unavailable: ${unavailable.join(', ')}`
            : 'Team is running with unavailable members',
        messageSeverity: 'warning',
        warnings: unavailable,
        configReady: true,
      };
    }
    case 'failed':
      return {
        ...base,
        state: 'failed',
        message: snapshot.error ?? 'Team launch failed',
        ...(snapshot.error ? { error: snapshot.error } : {}),
        messageSeverity: 'error',
      };
    case 'release-failed':
      return {
        ...base,
        state: 'failed',
        message: snapshot.error ?? 'Team run resources were not released',
        ...(snapshot.error ? { error: snapshot.error } : {}),
        messageSeverity: 'error',
      };
    case 'stopping':
      return {
        ...base,
        state: 'disconnected',
        message: 'Stopping team',
        disconnect: { kind: 'user_stop' },
      };
    case 'stopped':
      return {
        ...base,
        state: 'disconnected',
        message: 'Team stopped',
        disconnect: { kind: 'user_stop' },
      };
  }
}
