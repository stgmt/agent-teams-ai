import { resolveOpenCodeMemberIdentityFromDirectory } from '@main/services/team/provisioning/TeamProvisioningOpenCodeMemberIdentity';

import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { TeamConfig } from '@shared/types';

/**
 * Member → lane identity for delivery, resolved without the legacy service.
 *
 * The legacy resolver asked a facade for a "member directory": the team config
 * plus a metadata mirror. The native owner has no mirror — the config snapshot
 * is the directory — so identity becomes a pure function over one config read.
 * Which lane a member lands on (primary or a secondary one) is decided by the
 * same rules the runtime uses, because it is literally the same resolver.
 */
export interface NativeOpenCodeMemberIdentityDependencies {
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
}

export interface NativeOpenCodeMemberIdentity {
  resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeMemberIdentityResolution>;
  /** Whether this member is delivered to through an OpenCode lane at all. */
  isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean>;
}

export function createNativeOpenCodeMemberIdentity(
  deps: NativeOpenCodeMemberIdentityDependencies
): NativeOpenCodeMemberIdentity {
  const directoryFor = async (teamName: string): Promise<OpenCodeMemberDirectory> => ({
    config: await deps.readConfig(teamName),
    teamMeta: (await deps.readTeamMeta?.(teamName)) ?? null,
    metaMembers: [],
  });

  return {
    async resolveOpenCodeMemberDeliveryIdentity(teamName, memberName) {
      const directory = await directoryFor(teamName);
      const secondaryRuntimeRuns = await deps.readSecondaryRuntimeRuns?.(teamName);
      return resolveOpenCodeMemberIdentityFromDirectory({
        memberName,
        directory,
        ...(secondaryRuntimeRuns ? { secondaryRuntimeRuns } : {}),
      });
    },

    async isOpenCodeRuntimeRecipient(teamName, memberName) {
      const identity = await this.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName);
      return identity.ok;
    },
  };
}
