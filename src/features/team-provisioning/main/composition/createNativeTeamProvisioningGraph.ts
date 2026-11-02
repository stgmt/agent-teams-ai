import { NodeTeamLaunchSettings } from '../adapters/output/NodeTeamLaunchSettings';

import { createNativeTeamProvisioningRoot } from './createNativeTeamProvisioningRoot';

import type { NativeDesktopTeamRuntimeDependencies } from './createNativeDesktopTeamRuntime';
import type { NativeTeamLifecycleDependencies } from './createNativeTeamLifecycle';
import type { NativeTeamProvisioningRoot } from './createNativeTeamProvisioningRoot';
import type { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import type { TeamMcpConfigBuilder } from '@main/services/team/TeamMcpConfigBuilder';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaStore } from '@main/services/team/TeamMetaStore';

/**
 * Collaborators the native graph builds itself, exactly as the legacy service did
 * with its constructor defaults. They are ordinary stores and writers, not the
 * service chain being replaced.
 */
export interface NativeTeamProvisioningStores {
  teamsRoot: string;
  metadata: Pick<TeamMetaStore, 'getMeta'>;
  members: Pick<TeamMembersMetaStore, 'getMeta'>;
  mcp: Pick<TeamMcpConfigBuilder, 'writeConfigFile'>;
  inbox: Pick<TeamInboxWriter, 'sendMessage'>;
  invalidate(teamName: string): void;
}

export interface NativeTeamProvisioningGraphDependencies {
  /** Paths and stores the graph owns wiring for; everything else is supplied by the shell. */
  stores: NativeTeamProvisioningStores;
  runtimeDeps: Omit<NativeDesktopTeamRuntimeDependencies, 'settings' | 'mcp' | 'inbox'>;
  mcpConfig: {
    removeConfigFile(path: string): Promise<void>;
  };
  apisDeps: Parameters<typeof createNativeTeamProvisioningRoot>[0]['apisDeps'];
  watchdogDeps: Parameters<typeof createNativeTeamProvisioningRoot>[0]['watchdogDeps'];
  prepDeps: Parameters<typeof createNativeTeamProvisioningRoot>[0]['prepDeps'];
  languageDeps: Parameters<typeof createNativeTeamProvisioningRoot>[0]['languageDeps'];
  busyStatus: Parameters<typeof createNativeTeamProvisioningRoot>[0]['busyStatus'];
  inboxRelay: Parameters<typeof createNativeTeamProvisioningRoot>[0]['inboxRelay'];
}

/**
 * One production graph: the stores the legacy service created for itself, wired
 * into the native owner instead. `settings`, `mcp` and `inbox` are built here so
 * no shell has to know their shapes; the runtime, watchdog, preparation and
 * language ports stay explicit dependencies of the composition they feed.
 */
export function createNativeTeamProvisioningGraph(
  deps: NativeTeamProvisioningGraphDependencies
): NativeTeamProvisioningRoot {
  const lifecycleSettings: NativeTeamLifecycleDependencies['settings'] = {
    metadata: deps.stores.metadata,
    members: deps.stores.members,
  };
  const mcp: NativeTeamLifecycleDependencies['mcp'] = {
    writeConfigFile: (cwd, options) =>
      deps.stores.mcp.writeConfigFile(cwd, options as never) as Promise<string>,
    removeConfigFile: (path) => deps.mcpConfig.removeConfigFile(path),
  };
  return createNativeTeamProvisioningRoot({
    runtimeDeps: {
      ...deps.runtimeDeps,
      settings: lifecycleSettings,
      mcp,
      inbox: { sendMessage: (teamName, message, options) => deps.stores.inbox.sendMessage(teamName, message, options) },
    },
    apisDeps: deps.apisDeps,
    watchdogDeps: deps.watchdogDeps,
    prepDeps: deps.prepDeps,
    languageDeps: deps.languageDeps,
    busyStatus: deps.busyStatus,
    inboxRelay: deps.inboxRelay,
  });
}

/** Re-exported so a shell can name the launch settings type it hands over. */
export type { NodeTeamLaunchSettings };
