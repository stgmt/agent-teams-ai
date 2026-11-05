import type { MemberSpawnStatusEntry } from '@shared/types';

export const MEMBER_SPAWN_STATUS_REFRESH_MS = 2_500;

export function hasUnresolvedMemberSpawnStatus(
  memberSpawnStatuses: Record<string, MemberSpawnStatusEntry> | undefined,
  memberSpawnSnapshot:
    | {
        statuses?: Record<string, MemberSpawnStatusEntry>;
        summary?: { pendingCount?: number };
      }
    | undefined
): boolean {
  if ((memberSpawnSnapshot?.summary?.pendingCount ?? 0) > 0) {
    return true;
  }
  const entries = [
    ...Object.values(memberSpawnStatuses ?? {}),
    ...Object.values(memberSpawnSnapshot?.statuses ?? {}),
  ];
  return entries.some((entry) => {
    if (entry.status === 'offline' || entry.status === 'skipped' || entry.status === 'error')
      return false;
    return (
      entry.status === 'waiting' ||
      entry.status === 'spawning' ||
      entry.launchState === 'starting' ||
      entry.launchState === 'runtime_pending_bootstrap' ||
      entry.launchState === 'runtime_pending_permission'
    );
  });
}
