import { createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary } from '@main/services/team/provisioning/TeamProvisioningOpenCodeStoppedLaneCleanupBoundary';
import {
  type PersistedTeamConfigCacheEntry,
  readPersistedTeamProjectPath,
} from '@main/services/team/provisioning/TeamProvisioningPersistedTeamConfigAccess';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';

import type { TeamOperationQueue } from '../../../core/application/TeamOperationQueue';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';
import type { PersistedTeamLaunchSnapshot, TeamConfig, TeamMember } from '@shared/types';

/**
 * Putting a stopped team's lanes away for good.
 *
 * A team that was stopped keeps its lane storage, its recorded pids and its run
 * tracking on disk until someone sweeps them; the sweep must not touch a lane a
 * newer launch has taken over, which is why every step re-checks ownership
 * against the launch freshness marker before it deletes anything.
 */
export interface NativeOpenCodeStoppedTeamLaneCleanupDependencies {
  teamsBasePath: string;
  queue: Pick<TeamOperationQueue, 'run'>;
  readConfig(teamName: string): Promise<TeamConfig | null>;
  readMembersMeta(teamName: string): Promise<readonly TeamMember[]>;
  canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  clearPrimaryRuntimeRun(teamName: string): void;
  logger: { info(message: string): void; warn(message: string): void };
}

export interface NativeOpenCodeStoppedTeamLaneCleanup {
  /** Sweeps the lanes of a team that is no longer running; returns how many it stopped. */
  stopLanesForStoppedTeam(teamName: string): Promise<number>;
  /** The same sweep, fired and forgotten; a stop never waits for clean-up. */
  stopLanesForStoppedTeamInBackground(teamName: string): void;
  hasAlivePersistedTeamProcess(teamName: string): boolean;
  hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName: string): boolean;
}

export function createNativeOpenCodeStoppedTeamLaneCleanup(
  deps: NativeOpenCodeStoppedTeamLaneCleanupDependencies
): NativeOpenCodeStoppedTeamLaneCleanup {
  const store = new TeamLaunchStateStore();
  const configCache = new Map<string, PersistedTeamConfigCacheEntry>();
  const cleanedTeams = new Set<string>();

  const boundary = createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary(
    {
      withTeamLock: (teamName, operation) => deps.queue.run(teamName, operation),
      canDeliverToOpenCodeRuntimeForTeam: (teamName) =>
        deps.canDeliverToOpenCodeRuntimeForTeam(teamName),
      getOpenCodeRuntimeAdapter: () => deps.getOpenCodeRuntimeAdapter(),
      readPreviousLaunchState: (teamName): Promise<PersistedTeamLaunchSnapshot | null> =>
        store.read(teamName),
      readConfigForObservation: (teamName) => deps.readConfig(teamName),
      readMembersMeta: (teamName) => deps.readMembersMeta(teamName),
      readPersistedTeamProjectPath: (teamName) =>
        readPersistedTeamProjectPath(teamName, {
          teamsBasePath: deps.teamsBasePath,
          cache: configCache,
        }),
      deleteSecondaryRuntimeRun: (teamName, laneId) =>
        deps.deleteSecondaryRuntimeRun(teamName, laneId),
      clearPrimaryRuntimeRun: (teamName) => deps.clearPrimaryRuntimeRun(teamName),
      // Remembering which teams were swept keeps a repeated shutdown from
      // re-walking storage that is already gone.
      markStoppedTeamOpenCodeRuntimeLanesCleaned: (teamName) => {
        cleanedTeams.add(teamName);
      },
      logInfo: (message) => deps.logger.info(message),
      logWarning: (message) => deps.logger.warn(message),
    },
    { getTeamsBasePath: () => deps.teamsBasePath }
  );

  return {
    stopLanesForStoppedTeam: (teamName) => boundary.stopOpenCodeRuntimeLanesForStoppedTeam(teamName),
    stopLanesForStoppedTeamInBackground: (teamName) =>
      boundary.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName),
    hasAlivePersistedTeamProcess: (teamName) => boundary.hasAlivePersistedTeamProcess(teamName),
    hasOnlyExplicitlyStoppedPersistedTeamProcesses: (teamName) =>
      boundary.hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName),
  };
}
