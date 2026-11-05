import { NodeTeamDefinitionStore } from '../adapters/output/NodeTeamDefinitionStore';

import type { TeamLaunchRequestPersistence } from './createDesktopTeamRuntime';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaStore } from '@main/services/team/TeamMetaStore';

export interface NativeDefinitionStoreSources {
  teamsRoot: string;
  tasksRoot: string;
  metadata: Pick<TeamMetaStore, 'serializeMeta' | 'updateMeta'>;
  members: Pick<TeamMembersMetaStore, 'serializeMembers'>;
  /**
   * Drops the shell's cached team reads. The store calls this after it writes a
   * definition and does not name a team, so the shell must be able to invalidate all.
   */
  invalidate(): void;
}

/**
 * Where a team's definition is written.
 *
 * Team creation and launch-setting updates both land here, on the same two files the
 * rest of the app reads, so a team created by the native root is indistinguishable
 * from one created before it.
 */
export function createNativeDefinitionStore(
  sources: NativeDefinitionStoreSources
): TeamLaunchRequestPersistence {
  return new NodeTeamDefinitionStore({
    teamsRoot: sources.teamsRoot,
    tasksRoot: sources.tasksRoot,
    metadata: sources.metadata,
    members: sources.members,
    invalidate: () => sources.invalidate(),
  });
}
