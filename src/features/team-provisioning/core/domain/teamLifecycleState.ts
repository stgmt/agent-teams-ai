import type {
  MemberLifecycleSnapshot,
  TeamLifecycleState,
  TeamRunResourceState,
} from '../../contracts';

/** A process handle or adapter lane is the only current liveness evidence. */
export function memberIsLive(member: Readonly<MemberLifecycleSnapshot>): boolean {
  if (member.process !== null) return true;
  return member.lane !== null && member.lane.runtimeAlive && !member.lane.permissionBlocked;
}

/** One projection of current observations; bootstrap history never establishes present readiness. */
export function teamLifecycleState(team: {
  desired: 'running' | 'stopped';
  resources: TeamRunResourceState;
  error: string | null;
  members: Iterable<Readonly<MemberLifecycleSnapshot>>;
}): TeamLifecycleState {
  const allMembers = [...team.members];
  if (
    team.resources === 'release-failed' ||
    allMembers.some((member) => member.resources === 'release-failed')
  )
    return 'release-failed';
  if (team.desired === 'stopped') {
    return team.resources === 'released' ? 'stopped' : 'stopping';
  }
  if (team.resources === 'preparing') return 'preparing';
  if (team.error) return 'failed';
  const members = allMembers.filter(
    (member) => member.membership === 'configured' && !member.skippedForLaunch
  );
  const lead = members.find((member) => member.role === 'lead');
  const unavailable = (member: Readonly<MemberLifecycleSnapshot>): boolean =>
    member.desired !== 'running' ||
    ['stopped', 'stopping', 'exited', 'failed', 'unresponsive'].includes(member.phase);
  if (!lead || unavailable(lead)) return 'failed';
  if (members.some(unavailable)) return 'degraded';
  if (members.every((member) => member.phase === 'ready' && memberIsLive(member))) return 'ready';
  return 'starting';
}
