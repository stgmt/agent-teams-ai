import { normalizeMemberName } from '../core/domain/memberName';

import type { RoleRuntimeState } from '../core/domain/RoleActivationPlan';
import type { TeamAgentRuntimeEntry, TeamAgentRuntimeSnapshot } from '@shared/types';

const SNAPSHOT_MAX_AGE_MS = 60_000;
const CLOCK_SKEW_MS = 5_000;

/** `alive: false` can mean permission pending or an unverified process, not stopped. */
export function plannerRuntimeState(entry: TeamAgentRuntimeEntry): RoleRuntimeState {
  if (
    entry.alive &&
    (entry.livenessKind === 'runtime_process' || entry.livenessKind === 'confirmed_bootstrap')
  )
    return 'running';
  if (
    !entry.alive &&
    (entry.livenessKind === 'not_found' || entry.livenessKind === 'stale_metadata')
  ) {
    return 'stopped';
  }
  return 'unknown';
}

function snapshotSignature(snapshot: TeamAgentRuntimeSnapshot): string {
  return JSON.stringify(
    Object.values(snapshot.members)
      .map((entry) => [
        normalizeMemberName(entry.memberName),
        entry.alive,
        entry.livenessKind,
        entry.backendType,
        entry.pid,
      ])
      .sort((left, right) => String(left[0]).localeCompare(String(right[0])))
  );
}

export function isPlannerSnapshotTrusted(
  snapshot: TeamAgentRuntimeSnapshot | null,
  current: TeamAgentRuntimeSnapshot | undefined,
  teamName: string,
  now: number
): boolean {
  if (!snapshot?.runId || snapshot.teamName !== teamName) return false;
  const age = now - Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(age) || age < -CLOCK_SKEW_MS || age > SNAPSHOT_MAX_AGE_MS) return false;
  if (
    current &&
    (current.runId !== snapshot.runId || snapshotSignature(current) !== snapshotSignature(snapshot))
  )
    return false;
  return true;
}

interface RolePlannerRuntimeProjection {
  runningRuntimeMembers: string[];
  leadRuntimeMembers: string[];
  runtimeOccupancyUncertain: boolean;
  stateFor: (name: string) => RoleRuntimeState;
}

export function projectRuntimeForRolePlan(
  snapshot: TeamAgentRuntimeSnapshot | null,
  trusted: boolean
): RolePlannerRuntimeProjection {
  const entries = trusted && snapshot ? Object.values(snapshot.members) : [];
  const byName = new Map<string, TeamAgentRuntimeEntry[]>();
  for (const entry of entries) {
    const name = normalizeMemberName(entry.memberName);
    const matching = byName.get(name) ?? [];
    matching.push(entry);
    byName.set(name, matching);
  }
  return {
    runningRuntimeMembers: entries.filter((entry) => entry.alive).map((entry) => entry.memberName),
    leadRuntimeMembers: entries
      .filter((entry) => entry.backendType === 'lead')
      .map((entry) => entry.memberName),
    runtimeOccupancyUncertain:
      entries.some(
        (entry) =>
          !normalizeMemberName(entry.memberName) || plannerRuntimeState(entry) === 'unknown'
      ) || [...byName.values()].some((matching) => matching.length !== 1),
    stateFor(name: string): RoleRuntimeState {
      const matching = byName.get(normalizeMemberName(name)) ?? [];
      return matching.length === 1 ? plannerRuntimeState(matching[0]) : 'unknown';
    },
  };
}
