import {
  createOpenCodeRuntimeRecoveryIdentityHelpers,
  resolveOpenCodeMemberDeliveryIdentityFromDirectory,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeRecoveryIdentity';
import { resolveOpenCodeMemberIdentityFromDirectory as resolveIdentityFromDirectory } from '@main/services/team/provisioning/TeamProvisioningOpenCodeMemberIdentity';

import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { TeamConfig } from '@shared/types';

/**
 * Which lane and which run a member belongs to, answered by the native owner.
 *
 * Delivery needs three answers before it can send anything: whether the member
 * is reached through an OpenCode lane, which lane that is, and whether that lane
 * currently has a live run. All three are read-only questions over the team
 * config and the on-disk lane evidence, so the native side answers them from
 * those sources and keeps using the runtime's own rules for lane placement.
 */
export interface NativeOpenCodeMemberIdentityDependencies {
  teamsBasePath: string;
  readConfig(teamName: string): Promise<TeamConfig | null>;
  /**
   * Persisted launch metadata for the team. A team launched as OpenCode records
   * that here, which is the only answer for a member whose own config entry has
   * no provider. Absent means "read nothing", not "not OpenCode".
   */
  readTeamMeta?(teamName: string): Promise<OpenCodeMemberDirectory['teamMeta']>;
  /** Members with a live secondary adapter lane; absent means no secondary lanes. */
  readSecondaryRuntimeRuns?(
    teamName: string
  ): Promise<readonly { laneId: string; memberName: string; cwd?: string }[]>;
  /** Run the runtime holds in memory right now, if any; disk evidence is the fallback. */
  getCurrentOpenCodeRuntimeRunId?(teamName: string, laneId: string): string | null;
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
    teamMeta: (await deps.readTeamMeta?.(teamName)) ?? null,
    metaMembers: [],
  });

  const helpers = createOpenCodeRuntimeRecoveryIdentityHelpers({
    getTeamsBasePath: () => deps.teamsBasePath,
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      deps.getCurrentOpenCodeRuntimeRunId?.(teamName, laneId) ?? null,
    readOpenCodeMemberDirectory,
    resolveOpenCodeMemberIdentityFromDirectory: (_teamName, memberName, directory) =>
      resolveIdentityFromDirectory({ memberName, directory }),
  });

  return {
    readOpenCodeMemberDirectory,

    resolveOpenCodeMemberIdentityFromDirectory: (_teamName, memberName, directory) =>
      resolveIdentityFromDirectory({ memberName, directory }),

    async resolveOpenCodeMemberDeliveryIdentity(teamName, memberName) {
      const directory = await readOpenCodeMemberDirectory(teamName);
      const secondaryRuntimeRuns = await deps.readSecondaryRuntimeRuns?.(teamName);
      return resolveOpenCodeMemberDeliveryIdentityFromDirectory({
        teamName,
        memberName,
        directory,
        resolveOpenCodeMemberIdentityFromDirectory: (_teamName, directoryMemberName, dir) =>
          resolveIdentityFromDirectory({
            memberName: directoryMemberName,
            directory: dir,
            ...(secondaryRuntimeRuns ? { secondaryRuntimeRuns } : {}),
          }),
      });
    },

    async isOpenCodeRuntimeRecipient(teamName, memberName) {
      const identity = await this.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName);
      return identity.ok;
    },

    resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      helpers.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),

    isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
      helpers.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
  };
}
