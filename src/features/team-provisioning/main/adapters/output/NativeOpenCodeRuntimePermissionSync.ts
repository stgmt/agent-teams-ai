import {
  hasOpenCodePendingPermissionSignal,
  isOpenCodeRuntimePermissionForDeliveryTarget,
  type OpenCodeRuntimePendingPermissionsPersistencePorts,
  type OpenCodeRuntimePermissionListingAdapter,
  type OpenCodeRuntimePermissionRuntimeRunLike,
  type OpenCodeRuntimePermissionSyncInput,
  type OpenCodeRuntimePermissionToolApprovalSyncInput,
  type OpenCodeRuntimePermissionTrackedRunLike,
  persistOpenCodeRuntimePendingPermissions,
  resolveOpenCodeRuntimePermissionExpectedMembers,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimePermissions';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { isLeadMember } from '@shared/utils/leadDetection';

import type { TeamRunRegistryRead } from '../../../contracts';
import type { TeamRuntimePendingPermission } from '@main/services/team/runtime';
import type { PersistedTeamLaunchSnapshot, TeamConfig } from '@shared/types';

/**
 * A delivery that ended waiting for permission approval.
 *
 * The runtime answers a prompt with a permission request instead of a reply. The
 * user never sees that in the conversation unless the pending request is written
 * where the launch record keeps it, so this reads the runtime's own list and puts
 * the request on the member it belongs to - but only while the run that was
 * delivered to is still the team's run, because a superseded run's request is
 * not something anyone can still approve.
 */
export interface NativeOpenCodeRuntimePermissionSyncDependencies {
  teamsBasePath: string;
  runs: Pick<TeamRunRegistryRead, 'aliveRunId'>;
  readConfig(teamName: string): Promise<TeamConfig | null>;
  /** The bridge that can list a lane's pending permission requests. */
  getPermissionListingAdapter(): OpenCodeRuntimePermissionListingAdapter | null;
  store: Pick<TeamLaunchStateStore, 'read'>;
  /** How a pending request reaches the approval surface the user acts on. */
  syncToolApprovals(input: OpenCodeRuntimePermissionToolApprovalSyncInput): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  emitMemberSpawnChange(input: {
    teamName: string;
    runId?: string | null;
    memberName: string;
  }): void;
  logger: { warn(message: string): void; debug(message: string): void };
  now(): string;
  /** Serializes the read-modify-write of one team's launch snapshot. */
  serializeLaunchStateUpdate<T>(teamName: string, operation: () => Promise<T>): Promise<T>;
}

export interface NativeOpenCodeRuntimePermissionSync {
  syncAfterDelivery(input: OpenCodeRuntimePermissionSyncInput): Promise<void>;
}

export function createNativeOpenCodeRuntimePermissionSync(
  deps: NativeOpenCodeRuntimePermissionSyncDependencies
): NativeOpenCodeRuntimePermissionSync {
  const persistencePorts: OpenCodeRuntimePendingPermissionsPersistencePorts = {
    nowIso: () => deps.now(),
    getTrackedRunId: (teamName) => deps.runs.aliveRunId(teamName),
    enqueueLaunchStateStoreOperation: (teamName, operation) =>
      deps.serializeLaunchStateUpdate(teamName, operation),
    readLaunchState: (teamName) => deps.store.read(teamName),
    writeLaunchStateSnapshot: async (teamName, snapshot, options) => {
      const wrote = await new TeamLaunchStateStore().write(teamName, snapshot, options);
      return wrote;
    },
    invalidateRuntimeSnapshotCaches: (teamName) => deps.invalidateRuntimeSnapshotCaches(teamName),
    emitMemberSpawnChange: (input) => deps.emitMemberSpawnChange(input),
    logDebug: (message) => deps.logger.debug(message),
  };

  const trackedRunFor = async (
    teamName: string,
    runId: string
  ): Promise<OpenCodeRuntimePermissionTrackedRunLike | null> => {
    const config = await deps.readConfig(teamName).catch(() => null);
    if (!config) return null;
    const members = (config.members ?? []).filter((member) => member.removedAt == null);
    // Which lane a member is planned onto follows the lead's provider, and the
    // lead is the member the app marks as such in the config.
    const leadProviderId = members.find((member) => isLeadMember(member))?.providerId;
    return {
      runId,
      request: { providerId: leadProviderId as never },
      effectiveMembers: members as never,
      allEffectiveMembers: members as never,
      memberSpawnStatuses: new Map(),
      isLaunch: false,
    };
  };

  return {
    syncAfterDelivery: async (input) => {
      const runId = input.runId?.trim();
      if (!runId) return;
      if (deps.runs.aliveRunId(input.teamName) !== runId) return;
      if (!hasOpenCodePendingPermissionSignal(input)) return;

      const adapter = deps.getPermissionListingAdapter();
      if (!adapter) {
        deps.logger.warn(
          `[${input.teamName}] OpenCode runtime permission signal observed for ${input.memberName}, but permission listing bridge is unavailable.`
        );
        return;
      }

      let listed: { permissions: TeamRuntimePendingPermission[]; diagnostics: string[] };
      try {
        listed = await adapter.listRuntimePermissions({
          teamName: input.teamName,
          laneId: input.laneId,
          cwd: input.cwd,
          memberName: input.memberName,
          sessionId: input.sessionId,
        });
      } catch (error) {
        deps.logger.warn(
          `[${input.teamName}] Failed to list OpenCode runtime permissions for ${input.memberName}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return;
      }

      if (deps.runs.aliveRunId(input.teamName) !== runId) return;

      const pendingPermissions = listed.permissions.filter((permission) =>
        isOpenCodeRuntimePermissionForDeliveryTarget(input, permission)
      );
      if (pendingPermissions.length === 0) {
        const listedDiagnostics = listed.diagnostics.length
          ? ` Diagnostics: ${listed.diagnostics.join(' | ')}`
          : '';
        deps.logger.warn(
          `[${input.teamName}] OpenCode runtime permission signal observed for ${input.memberName}, but bridge listed no matching pending permissions.${listedDiagnostics}`
        );
        return;
      }

      const previousLaunchState: PersistedTeamLaunchSnapshot | null = await deps.store
        .read(input.teamName)
        .catch(() => null);
      if (deps.runs.aliveRunId(input.teamName) !== runId) return;

      const trackedRun = await trackedRunFor(input.teamName, runId);
      const runtimeAdapterRun: OpenCodeRuntimePermissionRuntimeRunLike | null = null;
      const permissionsByMember = new Map<string, readonly TeamRuntimePendingPermission[]>([
        [input.memberName, pendingPermissions],
      ]);
      const expectedMembers = resolveOpenCodeRuntimePermissionExpectedMembers({
        runId,
        laneId: input.laneId,
        memberName: input.memberName,
        cwd: input.cwd,
        previousLaunchState,
        trackedRun,
        runtimeAdapterRun,
      });

      const persisted = await persistOpenCodeRuntimePendingPermissions(
        {
          teamName: input.teamName,
          runId,
          laneId: input.laneId,
          sessionId: input.sessionId,
          permissionsByMember,
          previousLaunchState,
        },
        persistencePorts
      );
      if (persisted === false || deps.runs.aliveRunId(input.teamName) !== runId) return;

      const members: Record<string, TeamRuntimePendingPermission[]> = {
        [input.memberName]: pendingPermissions as TeamRuntimePendingPermission[],
      };
      deps.syncToolApprovals({
        teamName: input.teamName,
        runId,
        laneId: input.laneId,
        cwd: input.cwd,
        members: members as never,
        expectedMembers,
        memberNames: [input.memberName],
        teamColor: input.teamColor,
        teamDisplayName: input.teamDisplayName,
      });
    },
  };
}
