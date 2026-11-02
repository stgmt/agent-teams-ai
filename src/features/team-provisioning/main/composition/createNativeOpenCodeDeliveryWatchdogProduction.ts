import { createTeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFromHost } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFactory';
import { createTeamProvisioningOpenCodeRuntimeRecoveryBoundary } from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimeRecoveryBoundaryFactory';
import { getErrorMessage } from '@shared/utils/errorHandling';

import { createNativeOpenCodeBootstrapEvidence } from '../adapters/output/NativeOpenCodeBootstrapEvidence';
import { createNativeOpenCodeLaneRecovery } from '../adapters/output/NativeOpenCodeLaneRecovery';
import { createNativeOpenCodeMemberIdentity } from '../adapters/output/NativeOpenCodeMemberIdentity';
import { createNativeOpenCodePromptDeliveryLedgerFactory } from '../adapters/output/NativeOpenCodePromptDeliveryLedgerFactory';
import { createNativeOpenCodeRuntimePermissionSync } from '../adapters/output/NativeOpenCodeRuntimePermissionSync';
import { createNativeOpenCodeRuntimePidMemory } from '../adapters/output/NativeOpenCodeRuntimePidMemory';
import { createNativeOpenCodeStoppedTeamLaneCleanup } from '../adapters/output/NativeOpenCodeStoppedTeamLaneCleanup';
import { createNativeOpenCodeVisibleReplyProof } from '../adapters/output/NativeOpenCodeVisibleReplyProof';

import type { TeamOperationQueue } from '../../core/application/TeamOperationQueue';
import type { OpenCodeSecondaryLaneRun } from '../adapters/output/NativeOpenCodeMemberIdentity';
import type { NativePromptLedgerAccess } from '../adapters/output/NativeOpenCodePromptDeliverySupervisor';
import type { NativeSecondaryRuntimeRunStore } from '../adapters/output/NativeSecondaryRuntimeRunStore';
import type { NativeOpenCodeDeliveryWatchdogDependencies } from './createNativeOpenCodeDeliveryWatchdog';
import type { OpenCodeGroupAcknowledgementReader } from '@main/services/team/opencode/delivery/OpenCodeGroupAcknowledgement';
import type { OpenCodeMemberDirectory } from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodePromptDeliveryWatchdogScheduler } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import type {
  OpenCodeRuntimePermissionListingAdapter,
  OpenCodeRuntimePermissionToolApprovalSyncInput,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeRuntimePermissions';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime/TeamRuntimeAdapter';
import type { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import type { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import type { InboxMessage, TeamChangeEvent, TeamConfig } from '@shared/types';

/**
 * Everything the delivery supervisor needs that is owned by the application shell
 * rather than by the provisioning feature: paths, stores, the runtime registry and
 * the readers. No member of this object is a legacy service.
 */
export interface NativeOpenCodeDeliveryWatchdogProductionSources {
  teamsBasePath: string;
  launchState: Pick<TeamLaunchStateStore, 'read' | 'write'>;
  /** Team liveness as the runtime owner reports it, by team name. */
  isTeamAlive(teamName: string): boolean;
  /** Lanes and their runs; the supervisor reads and cleans the same store. */
  runs: NativeSecondaryRuntimeRunStore;
  openCodeAdapter(): TeamLaunchRuntimeAdapter | null;
  config: { read(teamName: string): Promise<TeamConfig | null> };
  teamMeta: Pick<TeamMetaStore, 'getMeta'>;
  membersMeta: Pick<TeamMembersMetaStore, 'getMeta'>;
  inbox: Pick<TeamInboxReader, 'getMessagesFor'>;
  queue: Pick<TeamOperationQueue, 'run'>;
  scheduler: Pick<OpenCodePromptDeliveryWatchdogScheduler, 'isEnabled' | 'schedule' | 'isStaleError'>;
  hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  hasAcknowledgedInbound: OpenCodeGroupAcknowledgementReader;
  emitRuntimeDeliveryReplyAdvisoryRefresh(teamName: string, message: InboxMessage): void;
  emitTeamChange(event: TeamChangeEvent): void;
  emitMemberSpawnChange(input: {
    teamName: string;
    runId?: string | null;
    memberName: string;
  }): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  syncToolApprovals(input: OpenCodeRuntimePermissionToolApprovalSyncInput): void;
  permissionListingAdapter(): OpenCodeRuntimePermissionListingAdapter | null;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  clearPrimaryRuntimeRun(teamName: string): void;
  readPersistedTeamProjectPath(teamName: string): string | null;
  logPromptDeliveryEvent: NativeOpenCodeDeliveryWatchdogDependencies['logPromptDeliveryEvent'];
  logger: {
    info(message: string, context?: string): void;
    warn(message: string): void;
    debug(message: string): void;
  };
  now?(): string;
}

/**
 * One delivery supervisor, assembled from the native adapters that already exist.
 *
 * The lane-recovery adapter needs the runtime's own recovery boundary; that boundary
 * is built here from the registry, not taken from the service being retired, so the
 * supervisor and the legacy chain never share a mutable owner.
 */
export function createNativeOpenCodeDeliveryWatchdogProductionDeps(
  sources: NativeOpenCodeDeliveryWatchdogProductionSources
): NativeOpenCodeDeliveryWatchdogDependencies {
  const nowIso = sources.now ?? (() => new Date().toISOString());
  const getOpenCodeRuntimeAdapter = () => sources.openCodeAdapter();
  // One answer to "can this team be delivered to": the OpenCode adapter exists and
  // the runtime says the team is alive. Every port below reads this, never its own copy.
  const isLive = (teamName: string) =>
    sources.openCodeAdapter() !== null && sources.isTeamAlive(teamName);
  /**
   * The directory wants the launch-relevant slice of the team meta file, not the file.
   * The slice is named explicitly so a new field cannot silently become part of it.
   */
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
  const identity = createNativeOpenCodeMemberIdentity({
    teamsBasePath: sources.teamsBasePath,
    readConfig: (teamName) => sources.config.read(teamName),
    readTeamMeta: (teamName) => readTeamMetaForDirectory(teamName),
    readMetaMembers: async (teamName) => (await sources.membersMeta.getMeta(teamName))?.members ?? [],
    readSecondaryRuntimeRuns: async (teamName) =>
      sources.runs.getSecondaryRuntimeRuns(teamName) as readonly OpenCodeSecondaryLaneRun[],
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      sources.runs.getSecondaryRuntimeRuns(teamName).find((entry) => entry.laneId === laneId)
        ?.runId ?? null,
  });
  const recoveryBoundary = createTeamProvisioningOpenCodeRuntimeRecoveryBoundary({
    teamsBasePath: sources.teamsBasePath,
    logger: { warn: (message: string) => sources.logger.warn(message) },
    getOpenCodeRuntimeAdapter,
    getErrorMessage,
  });
  const recoveryPorts = createTeamProvisioningOpenCodeRuntimeLaneRecoveryPortsFromHost(
    {
      runTracking: {
        canDeliverToOpenCodeRuntimeForTeam: (teamName) => isLive(teamName),
        canAttemptCommittedOpenCodeSessionRecovery: (teamName) => isLive(teamName),
      },
      cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
        stoppedLanes.stopLanesForStoppedTeamInBackground(teamName),
      launchStateStore: { read: (teamName) => sources.launchState.read(teamName) },
      openCodeRuntimeRecoveryBoundary: recoveryBoundary,
      readOpenCodeMemberDirectory: (teamName) => identity.readOpenCodeMemberDirectory(teamName),
      resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
        identity.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
      readConfigForObservation: (teamName) => sources.config.read(teamName),
      teamMetaStore: { getMeta: (teamName) => readTeamMetaForDirectory(teamName) },
      membersMetaStore: {
        getMembers: async (teamName) => (await sources.membersMeta.getMeta(teamName))?.members ?? [],
      },
      readPersistedTeamProjectPath: (teamName) => sources.readPersistedTeamProjectPath(teamName),
      openCodeRuntimeRecoveryIdentity: {
        isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
          identity.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
      },
    },
    { logger: sources.logger }
  );
  const pidMemory = createNativeOpenCodeRuntimePidMemory({
    store: sources.launchState,
    invalidateRuntimeSnapshotCaches: (teamName) => sources.invalidateRuntimeSnapshotCaches(teamName),
    emitTeamChange: (event) => sources.emitTeamChange(event),
    logDebug: (message) => sources.logger.debug(message),
    now: nowIso,
  });
  const stoppedLanes = createNativeOpenCodeStoppedTeamLaneCleanup({
    teamsBasePath: sources.teamsBasePath,
    queue: sources.queue,
    readConfig: (teamName) => sources.config.read(teamName),
    readMembersMeta: async (teamName) => (await sources.membersMeta.getMeta(teamName))?.members ?? [],
    canDeliverToOpenCodeRuntimeForTeam: (teamName) => isLive(teamName),
    getOpenCodeRuntimeAdapter,
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      sources.runs.deleteSecondaryRuntimeRun(teamName, laneId),
    clearPrimaryRuntimeRun: (teamName) => sources.runs.clearPrimaryRuntimeRun(teamName),
    logger: { info: (m) => sources.logger.info(m), warn: (m) => sources.logger.warn(m) },
  });
  const proof = createNativeOpenCodeVisibleReplyProof({
    readConfig: (teamName) => sources.config.read(teamName),
    emitRuntimeDeliveryReplyAdvisoryRefresh: (teamName, message) =>
      sources.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message),
    warn: (message) => sources.logger.warn(message),
    getErrorMessage,
    hasAcknowledgedInbound: sources.hasAcknowledgedInbound,
    nowIso,
  });
  const permissions = createNativeOpenCodeRuntimePermissionSync({
    teamsBasePath: sources.teamsBasePath,
    runs: {
      aliveRunId: (teamName) => sources.runs.getPrimaryRuntimeRun(teamName)?.runId ?? null,
    },
    readConfig: (teamName) => sources.config.read(teamName),
    getPermissionListingAdapter: () => sources.permissionListingAdapter(),
    store: sources.launchState,
    syncToolApprovals: (input) => sources.syncToolApprovals(input),
    invalidateRuntimeSnapshotCaches: (teamName) => sources.invalidateRuntimeSnapshotCaches(teamName),
    emitMemberSpawnChange: (input) => sources.emitMemberSpawnChange(input),
    logger: { warn: (m) => sources.logger.warn(m), debug: (m) => sources.logger.debug(m) },
    now: nowIso,
    serializeLaunchStateUpdate: (teamName, operation) =>
      sources.queue.run(teamName, operation),
  });
  const lanes = createNativeOpenCodeLaneRecovery({
    teamsBasePath: sources.teamsBasePath,
    identity,
    readConfig: (teamName) => sources.config.read(teamName),
    logger: { info: (m) => sources.logger.info(m), warn: (m) => sources.logger.warn(m) },
    canDeliverToOpenCodeRuntimeForTeam: recoveryPorts.canDeliverToOpenCodeRuntimeForTeam,
    canAttemptCommittedOpenCodeSessionRecovery:
      recoveryPorts.canAttemptCommittedOpenCodeSessionRecovery,
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground:
      recoveryPorts.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground,
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime:
      recoveryPorts.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime,
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime:
      recoveryPorts.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime,
  });
  const bootstrap = createNativeOpenCodeBootstrapEvidence({
    teamsBasePath: sources.teamsBasePath,
    resolveCurrentOpenCodeRuntimeRunId: async (teamName, laneId) =>
      sources.runs.getSecondaryRuntimeRuns(teamName).find((entry) => entry.laneId === laneId)
        ?.runId ?? null,
    warn: (message) => sources.logger.warn(message),
  });
  // One file per lane is the on-disk rule of the whole delivery path, so the
  // factory is built here from the teams root instead of being handed in.
  const openLedger = createNativeOpenCodePromptDeliveryLedgerFactory(sources.teamsBasePath);
  const ledgers: NativePromptLedgerAccess = {
    open: (teamName, laneId) => openLedger(teamName, laneId),
  };
  return {
    teamsBasePath: sources.teamsBasePath,
    scheduler: sources.scheduler,
    identity,
    ledgers,
    proof,
    permissions,
    pidMemory,
    bootstrap,
    lanes,
    stoppedLanes,
    readInboxMessages: (teamName, memberName) => sources.inbox.getMessagesFor(teamName, memberName),
    canDeliverToTeamRuntime: (teamName) => isLive(teamName),
    hasAcceptedMemberWorkSyncReport: (input) => sources.hasAcceptedMemberWorkSyncReport(input),
    hasAcknowledgedInbound: sources.hasAcknowledgedInbound,
    logPromptDeliveryEvent: sources.logPromptDeliveryEvent,
    info: (message, context) => sources.logger.info(message, context),
    warn: (message) => sources.logger.warn(message),
    nowIso,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getErrorMessage,
  };
}

