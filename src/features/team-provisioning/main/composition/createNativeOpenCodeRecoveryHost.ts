import { TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade';
import {
  createTeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFromHost,
  type TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryHost,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactory';
import { createTeamProvisioningOpenCodeRuntimeRecoveryBoundary } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeRecoveryBoundaryFactory';
import { getErrorMessage } from '@shared/utils/errorHandling';

import { createNativeOpenCodeMemberIdentity } from '../adapters/output/NativeOpenCodeMemberIdentity';

import type { NativeOpenCodeMemberIdentity } from '../adapters/output/NativeOpenCodeMemberIdentity';
import type { NativeSecondaryRuntimeRunStore } from '../adapters/output/NativeSecondaryRuntimeRunStore';
import type { OpenCodeMemberDirectory } from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodeRuntimeLaneRecoveryPorts } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeRecoveryFlow';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime/TeamRuntimeAdapter';
import type { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import type { TeamConfig } from '@shared/types';

/**
 * What lane recovery needs from the shell. These are stores and predicates, not the
 * service that used to own them: recovery has to run before a delivery, after a
 * restart and during a watchdog sweep, and each of those has to see the same lanes.
 */
export interface NativeOpenCodeRecoverySources {
  teamsBasePath: string;
  launchState: Pick<TeamLaunchStateStore, 'read'>;
  runs: NativeSecondaryRuntimeRunStore;
  config: { read(teamName: string): Promise<TeamConfig | null> };
  teamMeta: Pick<TeamMetaStore, 'getMeta'>;
  membersMeta: Pick<TeamMembersMetaStore, 'getMeta'>;
  /** Whether a lane of this team may be delivered to right now. */
  isDeliverable(teamName: string): boolean;
  cleanupStoppedLanesInBackground(teamName: string): void;
  readPersistedTeamProjectPath(teamName: string): string | null;
  openCodeAdapter(): TeamLaunchRuntimeAdapter | null;
  logger: { info(message: string): void; warn(message: string): void };
}

export interface NativeOpenCodeRecoveryHost {
  identity: NativeOpenCodeMemberIdentity;
  host: TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryHost;
  ports: OpenCodeRuntimeLaneRecoveryPorts;
  /** The recovery entry points the delivery path calls before a message is sent. */
  facade: TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade;
}

/**
 * One lane-recovery host, shared by the delivery path and the watchdog.
 *
 * Building it twice would give the two paths separate identity caches and separate
 * recovery boundaries, so a lane recovered by one could look unknown to the other.
 */
export function createNativeOpenCodeRecoveryHost(
  sources: NativeOpenCodeRecoverySources
): NativeOpenCodeRecoveryHost {
  const readTeamMetaForDirectory = async (
    teamName: string
  ): Promise<OpenCodeMemberDirectory['teamMeta']> => {
    const meta = await sources.teamMeta.getMeta(teamName);
    if (!meta) return null as unknown as OpenCodeMemberDirectory['teamMeta'];
    return {
      ...(meta.providerId ? { providerId: meta.providerId } : {}),
      cwd: meta.cwd,
    } as OpenCodeMemberDirectory['teamMeta'];
  };
  const readMembers = async (teamName: string) =>
    (await sources.membersMeta.getMeta(teamName))?.members ?? [];
  const identity = createNativeOpenCodeMemberIdentity({
    teamsBasePath: sources.teamsBasePath,
    readConfig: (teamName) => sources.config.read(teamName),
    readTeamMeta: (teamName) => readTeamMetaForDirectory(teamName),
    readMetaMembers: readMembers,
    readSecondaryRuntimeRuns: async (teamName) =>
      sources.runs.getSecondaryRuntimeRuns(teamName),
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      sources.runs.getSecondaryRuntimeRuns(teamName).find((entry) => entry.laneId === laneId)
        ?.runId ?? null,
  });
  const boundary = createTeamProvisioningOpenCodeRuntimeRecoveryBoundary({
    teamsBasePath: sources.teamsBasePath,
    logger: { warn: (message: string) => sources.logger.warn(message) },
    getOpenCodeRuntimeAdapter: () => sources.openCodeAdapter(),
    getErrorMessage,
  });
  const host: TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactoryHost = {
    runTracking: {
      canDeliverToOpenCodeRuntimeForTeam: (teamName) => sources.isDeliverable(teamName),
      canAttemptCommittedOpenCodeSessionRecovery: (teamName) => sources.isDeliverable(teamName),
    },
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
      sources.cleanupStoppedLanesInBackground(teamName),
    launchStateStore: { read: (teamName) => sources.launchState.read(teamName) },
    openCodeRuntimeRecoveryBoundary: boundary,
    readOpenCodeMemberDirectory: (teamName) => identity.readOpenCodeMemberDirectory(teamName),
    resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
      identity.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
    readConfigForObservation: (teamName) => sources.config.read(teamName),
    teamMetaStore: { getMeta: (teamName) => readTeamMetaForDirectory(teamName) },
    membersMetaStore: { getMembers: (teamName) => readMembers(teamName) },
    readPersistedTeamProjectPath: (teamName) => sources.readPersistedTeamProjectPath(teamName),
    openCodeRuntimeRecoveryIdentity: {
      isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
        identity.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
    },
  };
  return {
    identity,
    host,
    ports: createTeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFromHost(host, {
      logger: sources.logger,
    }),
    facade: new TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade(host, {
      getTeamsBasePath: () => sources.teamsBasePath,
      logger: sources.logger,
    }),
  };
}
