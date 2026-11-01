import { resolveOpenCodeMemberIdentityFromDirectory as resolveIdentityFromDirectory } from '@main/services/team/provisioning/TeamProvisioningOpenCodeMemberIdentity';
import {
  createOpenCodeRuntimeRecoveryIdentityHelpers,
  resolveOpenCodeMemberDeliveryIdentityFromDirectory,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeRecoveryIdentity';

import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { TeamConfig, TeamMember } from '@shared/types';

/** A member the runtime is driving on a secondary lane right now. */
export interface OpenCodeSecondaryLaneRun {
  laneId: string;
  memberName: string;
  cwd?: string;
}

/**
 * Which lane and which run a member belongs to, answered by the native owner.
 *
 * Delivery needs four answers before it can send anything: whether the member is
 * reached through an OpenCode lane, which lane that is, whether that lane has a
 * live run, and which members the lane actually carries. Every source below is
 * required: a delivery question answered from a missing source would place the
 * member on the wrong lane or skip a member the lane is driving, and both look
 * like a hang rather than an error.
 */
export interface NativeOpenCodeMemberIdentityDependencies {
  teamsBasePath: string;
  readConfig(teamName: string): Promise<TeamConfig | null>;
  /** Persisted launch metadata; the only provider answer for a member without its own entry. */
  readTeamMeta(teamName: string): Promise<OpenCodeMemberDirectory['teamMeta']>;
  /** Members recorded in launch metadata, including ones the config no longer lists. */
  readMetaMembers(teamName: string): Promise<readonly TeamMember[]>;
  /** Members the runtime currently drives on secondary adapter lanes. */
  readSecondaryRuntimeRuns(teamName: string): Promise<readonly OpenCodeSecondaryLaneRun[]>;
  /** Run the runtime holds in memory; disk evidence answers when it holds none. */
  getCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): string | null;
}

export interface NativeOpenCodeMemberIdentity {
  readOpenCodeMemberDirectory(teamName: string): Promise<OpenCodeMemberDirectory>;
  resolveOpenCodeMemberIdentityFromDirectory(
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ): OpenCodeMemberIdentityResolution;
  resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeMemberIdentityResolution>;
  /** Whether this member is delivered to through an OpenCode lane at all. */
  isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean>;
  /** The run the lane is on, from memory when live and from disk evidence otherwise. */
  resolveCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): Promise<string | null>;
  isOpenCodeRuntimeLaneIndexActive(teamName: string, laneId: string): Promise<boolean>;
}

export function createNativeOpenCodeMemberIdentity(
  deps: NativeOpenCodeMemberIdentityDependencies
): NativeOpenCodeMemberIdentity {
  const readOpenCodeMemberDirectory = async (
    teamName: string
  ): Promise<OpenCodeMemberDirectory> => ({
    config: await deps.readConfig(teamName),
    teamMeta: await deps.readTeamMeta(teamName),
    metaMembers: [...(await deps.readMetaMembers(teamName))],
  });

  const helpers = createOpenCodeRuntimeRecoveryIdentityHelpers({
    getTeamsBasePath: () => deps.teamsBasePath,
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      deps.getCurrentOpenCodeRuntimeRunId(teamName, laneId),
    readOpenCodeMemberDirectory,
    resolveOpenCodeMemberIdentityFromDirectory: (_teamName, memberName, directory) =>
      resolveIdentityFromDirectory({ memberName, directory }),
  });

  const resolveOpenCodeMemberDeliveryIdentity = async (
    teamName: string,
    memberName: string
  ): Promise<OpenCodeMemberIdentityResolution> => {
    const [directory, secondaryRuntimeRuns] = await Promise.all([
      readOpenCodeMemberDirectory(teamName),
      deps.readSecondaryRuntimeRuns(teamName),
    ]);
    return resolveOpenCodeMemberDeliveryIdentityFromDirectory({
      teamName,
      memberName,
      directory,
      resolveOpenCodeMemberIdentityFromDirectory: (_teamName, directoryMemberName, dir) =>
        resolveIdentityFromDirectory({
          memberName: directoryMemberName,
          directory: dir,
          secondaryRuntimeRuns,
        }),
    });
  };

  return {
    readOpenCodeMemberDirectory,
    resolveOpenCodeMemberIdentityFromDirectory: (_teamName, memberName, directory) =>
      resolveIdentityFromDirectory({ memberName, directory }),
    resolveOpenCodeMemberDeliveryIdentity,
    isOpenCodeRuntimeRecipient: async (teamName, memberName) =>
      (await resolveOpenCodeMemberDeliveryIdentity(teamName, memberName)).ok,
    resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      helpers.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
    isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
      helpers.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
  };
}
