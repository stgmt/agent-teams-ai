import {
  type OpenCodeRuntimeLaneRecoveryPorts,
  tryRecoverOpenCodeRuntimeLaneBeforeDelivery,
  tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery,
  tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeRecoveryFlow';
import {
  type PersistedTeamConfigCacheEntry,
  readPersistedTeamProjectPath,
} from '@main/services/team/provisioning/TeamProvisioningPersistedTeamConfigAccess';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';

import type { NativeOpenCodeMemberIdentity } from './NativeOpenCodeMemberIdentity';
import type { OpenCodeCommittedBootstrapSessionEvidence } from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type { TeamRuntimeMemberLaunchEvidence } from '@main/services/team/runtime';
import type { PersistedTeamLaunchSnapshot, TeamConfig, TeamMember } from '@shared/types';

/**
 * Bringing a dead lane back before a message is handed to it.
 *
 * Delivery has nowhere to go if the lane is gone, so before a prompt is sent the
 * app checks the persisted launch record and the committed bootstrap session,
 * and — when either proves the lane existed — asks the runtime to bring it back
 * and marks the lane active again. The evidence is all on disk; only starting the
 * lane is the runtime's job, so that single step is supplied as a port.
 */
export interface NativeOpenCodeLaneRecoveryDependencies {
  teamsBasePath: string;
  identity: NativeOpenCodeMemberIdentity;
  readConfig(teamName: string): Promise<TeamConfig | null>;
  logger: { info(message: string): void; warn(message: string): void };
  /** The team still has a runtime this app is willing to deliver to. */
  canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean;
  /** The team is in a state where a committed session may still be revived. */
  canAttemptCommittedOpenCodeSessionRecovery(teamName: string): boolean;
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName: string): void;
  tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    persistedMember: Parameters<
      OpenCodeRuntimeLaneRecoveryPorts['tryRecoverMissingOpenCodeSecondaryLaneFromRuntime']
    >[0]['persistedMember'];
  }): Promise<TeamRuntimeMemberLaunchEvidence | null>;
  tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<TeamRuntimeMemberLaunchEvidence | null>;
  readLaunchState?(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  readCommittedBootstrapSessionEvidence?(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }): Promise<OpenCodeCommittedBootstrapSessionEvidence>;
}

export interface NativeOpenCodeLaneRecovery {
  tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
  }): Promise<boolean>;
  tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState?: PersistedTeamLaunchSnapshot | null;
  }): Promise<boolean>;
  /**
   * Startup recovery for every lane the team records: brings back the ones that
   * can still run and cleans away the ones whose team is stopped. Returns the
   * lane ids it recovered.
   */
  recoverLanesForWatchdog(
    teamName: string,
    options: { allowCommittedSessionRecoveryWithoutTeamRuntime?: boolean }
  ): Promise<string[]>;
}

export function createNativeOpenCodeLaneRecovery(
  deps: NativeOpenCodeLaneRecoveryDependencies
): NativeOpenCodeLaneRecovery {
  const launchStateStore = new TeamLaunchStateStore();
  const configCache = new Map<string, PersistedTeamConfigCacheEntry>();

  const ports: OpenCodeRuntimeLaneRecoveryPorts = {
    teamsBasePath: deps.teamsBasePath,
    logger: deps.logger,
    canDeliverToOpenCodeRuntimeForTeam: (teamName) =>
      deps.canDeliverToOpenCodeRuntimeForTeam(teamName),
    canAttemptCommittedOpenCodeSessionRecovery: (teamName) =>
      deps.canAttemptCommittedOpenCodeSessionRecovery(teamName),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
      deps.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName),
    readLaunchState: (teamName) =>
      deps.readLaunchState ? deps.readLaunchState(teamName) : launchStateStore.read(teamName),
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: (input) =>
      deps.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(input),
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: (input) =>
      deps.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(input),
    readOpenCodeMemberDirectory: (teamName) => deps.identity.readOpenCodeMemberDirectory(teamName),
    resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
      deps.identity.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
    readConfigForObservation: (teamName) => deps.readConfig(teamName),
    // The metadata mirror is a legacy store the native owner does not keep; the
    // config snapshot already carries the members a recovery candidate needs.
    readTeamMeta: async () => null,
    readMetaMembers: async () => [],
    readPersistedTeamProjectPath: (teamName) =>
      readPersistedTeamProjectPath(teamName, { teamsBasePath: deps.teamsBasePath, cache: configCache }),
    isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
      deps.identity.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
    ...(deps.readCommittedBootstrapSessionEvidence
      ? { readCommittedOpenCodeBootstrapSessionEvidence: deps.readCommittedBootstrapSessionEvidence }
      : {}),
  };

  return {
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: (input) =>
      tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input, ports),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: (input) =>
      tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input, ports),
    // The watchdog asks the same question at startup, for every lane at once:
    // which recorded lanes can be brought back, and which belong to a team that
    // is gone and should be cleaned away instead.
    recoverLanesForWatchdog: (teamName, options) =>
      tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(teamName, options, ports),
  };
}
