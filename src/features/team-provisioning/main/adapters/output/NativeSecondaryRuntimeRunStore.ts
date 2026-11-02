import type {
  RuntimeAdapterRunEntry,
  SecondaryRuntimeRunEntry,
  SecondaryRuntimeRunStore,
} from '@main/services/team/provisioning/TeamProvisioningSecondaryRuntimeRuns';

/**
 * Which runtime run each lane of each team is on, owned by this process.
 *
 * The store is the app's single answer to "what is running where": the delivery
 * supervisor asks it before a lane is delivered to, and the stopped-team cleanup
 * removes lanes through it. Keeping the two maps private and the deletes narrow
 * is what stops a stopped team from leaving a lane behind that a later delivery
 * would treat as live.
 */
export interface NativeSecondaryRuntimeRunStore extends SecondaryRuntimeRunStore {
  /** The run the team itself (its lead lane) is on. */
  setPrimaryRuntimeRun(teamName: string, entry: RuntimeAdapterRunEntry): void;
  getPrimaryRuntimeRun(teamName: string): RuntimeAdapterRunEntry | null;
  /** Forgets the team's own run; the secondary lanes are cleared separately. */
  clearPrimaryRuntimeRun(teamName: string): void;
  /** Every team that still has a recorded run of either kind. */
  listTrackedTeamNames(): readonly string[];
}

export function createNativeSecondaryRuntimeRunStore(): NativeSecondaryRuntimeRunStore {
  const primary = new Map<string, RuntimeAdapterRunEntry>();
  const secondary = new Map<string, Map<string, SecondaryRuntimeRunEntry>>();

  const lanesOf = (teamName: string): Map<string, SecondaryRuntimeRunEntry> | undefined =>
    secondary.get(teamName);

  return {
    hasSecondaryRuntimeRuns: (teamName) => (lanesOf(teamName)?.size ?? 0) > 0,
    getSecondaryRuntimeRuns: (teamName) => [...(lanesOf(teamName)?.values() ?? [])],
    setSecondaryRuntimeRun: ({ teamName, ...entry }) => {
      const lanes = lanesOf(teamName) ?? new Map<string, SecondaryRuntimeRunEntry>();
      lanes.set(entry.laneId, entry);
      secondary.set(teamName, lanes);
    },
    deleteSecondaryRuntimeRun: (teamName, laneId) => {
      const lanes = lanesOf(teamName);
      if (!lanes) return;
      lanes.delete(laneId);
      if (lanes.size === 0) secondary.delete(teamName);
    },
    clearSecondaryRuntimeRuns: (teamName) => {
      secondary.delete(teamName);
    },
    setPrimaryRuntimeRun: (teamName, entry) => {
      primary.set(teamName, entry);
    },
    getPrimaryRuntimeRun: (teamName) => primary.get(teamName) ?? null,
    clearPrimaryRuntimeRun: (teamName) => {
      primary.delete(teamName);
    },
    listTrackedTeamNames: () => [
      ...new Set([...primary.keys(), ...secondary.keys()]),
    ],
  };
}
