import { repairStaleTaskActivityIntervalsBeforeSnapshot } from '@main/services/team/provisioning/TeamProvisioningTaskActivityRepair';

import type { TeamRunRegistryRead } from '../../../contracts';
import type {
  TaskActivityRepairSnapshotStorePort,
  TaskActivityRepairTeamSetPort,
} from '@main/services/team/provisioning/TeamProvisioningTaskActivityRepair';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

export interface NativeTaskActivityRepairDependencies {
  runs: Pick<TeamRunRegistryRead, 'aliveRunId' | 'findByRunId' | 'isLive'>;
  tracking: {
    repairedTeams: TaskActivityRepairTeamSetPort;
    pendingSnapshots: TaskActivityRepairSnapshotStorePort;
  };
  readRepairLaunchSnapshot(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  repairOnce(
    teamName: string,
    launchSnapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<boolean>;
}

/**
 * Legacy task-activity repair driven by the native run registry: a live run
 * skips repair, a stopped or foreign run is repaired once before the snapshot.
 */
export class NativeTaskActivityRepair {
  constructor(private readonly deps: NativeTaskActivityRepairDependencies) {}

  repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void> {
    return repairStaleTaskActivityIntervalsBeforeSnapshot(teamName, {
      tracking: this.deps.tracking,
      getTrackedRunId: (name) => this.deps.runs.aliveRunId(name),
      hasRun: (runId) => {
        const snapshot = this.deps.runs.findByRunId(runId);
        return snapshot !== null && this.deps.runs.isLive(snapshot.identity);
      },
      readRepairLaunchSnapshot: this.deps.readRepairLaunchSnapshot,
      repairOnce: this.deps.repairOnce,
    });
  }
}
