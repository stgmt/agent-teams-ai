import {
  readTaskActivityRepairLaunchSnapshot,
  repairStaleTaskActivityIntervalsBeforeSnapshot,
  repairStaleTaskActivityIntervalsOnce,
  type TaskActivityRepairServicePort,
} from '@main/services/team/provisioning/TeamProvisioningTaskActivityRepair';
import { choosePreferredLaunchSnapshot } from '@main/services/team/TeamBootstrapStateReader';

import type { TeamTaskActivityRepairApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

/**
 * What the repair needs from the shell. It never asks whether a run is live: the
 * caller reports that, so a repaired team and a live team cannot disagree about
 * whose intervals are stale.
 */
export interface NativeTaskActivityRepairSources {
  /** Closes the intervals of a team whose process died without finishing them. */
  isManagedByThisProfile(teamName: string): Promise<boolean>;
  intervals: TaskActivityRepairServicePort;
  /** Snapshot the launch was last published with. */
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  /** Snapshot the bootstrap recorded, preferred over the launch one when newer. */
  readBootstrapLaunchSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  getTrackedRunId(teamName: string): string | null;
  hasRun(runId: string): boolean;
}

/**
 * The task-activity repair surface the IPC and HTTP handlers call before they read
 * a team's tasks.
 *
 * Repair runs at most once per team: the tracking sets live here, not in the caller,
 * because a second repair after a process really died would close intervals that
 * belong to the run that is starting right now.
 */
export function createNativeTaskActivityRepair(
  sources: NativeTaskActivityRepairSources
): TeamTaskActivityRepairApi {
  const repairedTeams = new Set<string>();
  const pendingSnapshots = new Map<string, PersistedTeamLaunchSnapshot | null>();
  const snapshotStore = {
    has: (teamName: string) => pendingSnapshots.has(teamName),
    get: (teamName: string) => pendingSnapshots.get(teamName),
    set: (teamName: string, launchSnapshot: PersistedTeamLaunchSnapshot | null) => {
      pendingSnapshots.set(teamName, launchSnapshot);
    },
    delete: (teamName: string) => {
      pendingSnapshots.delete(teamName);
    },
  };

  return {
    async repairStaleTaskActivityIntervalsBeforeSnapshot(teamName) {
      if (!(await sources.isManagedByThisProfile(teamName))) return;
      await repairStaleTaskActivityIntervalsBeforeSnapshot(teamName, {
        tracking: { repairedTeams, pendingSnapshots: snapshotStore },
        getTrackedRunId: (target) => sources.getTrackedRunId(target),
        hasRun: (runId) => sources.hasRun(runId),
        readRepairLaunchSnapshot: (target) =>
          readTaskActivityRepairLaunchSnapshot(target, {
            readBootstrapLaunchSnapshot: (name) => sources.readBootstrapLaunchSnapshot(name),
            readLaunchState: (name) => sources.readLaunchState(name),
            choosePreferredLaunchSnapshot: (bootstrapSnapshot, launchSnapshot) =>
              choosePreferredLaunchSnapshot(bootstrapSnapshot, launchSnapshot),
          }),
        repairOnce: (target, launchSnapshot) =>
          repairStaleTaskActivityIntervalsOnce(target, launchSnapshot, {
            taskActivityIntervalService: sources.intervals,
            tracking: { repairedTeams, pendingSnapshots: snapshotStore },
          }),
      });
    },
  };
}
