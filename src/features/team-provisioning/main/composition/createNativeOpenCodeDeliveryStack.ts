import { OpenCodePromptDeliveryWatchdogCoordinator } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { OpenCodePromptDeliveryWatchdogScheduler } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import { openCodeTaskRefsIncludeAll } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofMatching';
import { readOpenCodeRuntimeLaneIndex } from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { hasStableInboxMessageId } from '@main/services/team/provisioning/TeamProvisioningInboxRelayPolicy';
import { createOpenCodeMemberMessageDeliveryServiceFromHost } from '@main/services/team/provisioning/TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory';
import { getErrorMessage } from '@shared/utils/errorHandling';

import { createNativeOpenCodeBootstrapEvidence } from '../adapters/output/NativeOpenCodeBootstrapEvidence';
import { NativeOpenCodeDeliveryBusyStatus } from '../adapters/output/NativeOpenCodeDeliveryBusyStatus';
import { createNativeOpenCodeLaneRecovery } from '../adapters/output/NativeOpenCodeLaneRecovery';
import { createNativeOpenCodePromptDeliveryLedgerFactory } from '../adapters/output/NativeOpenCodePromptDeliveryLedgerFactory';
import { createNativeOpenCodeRuntimePermissionSync } from '../adapters/output/NativeOpenCodeRuntimePermissionSync';
import { createNativeOpenCodeRuntimePidMemory } from '../adapters/output/NativeOpenCodeRuntimePidMemory';
import { createNativeOpenCodeStoppedTeamLaneCleanup } from '../adapters/output/NativeOpenCodeStoppedTeamLaneCleanup';
import { createNativeOpenCodeVisibleReplyProof } from '../adapters/output/NativeOpenCodeVisibleReplyProof';

import { createNativeOpenCodeDeliveryHost } from './createNativeOpenCodeDeliveryHost';
import { createNativeOpenCodeMemberDeliveryPort } from './createNativeOpenCodeMemberDeliveryPort';
import { createNativeOpenCodeRecoveryHost } from './createNativeOpenCodeRecoveryHost';

import type { TeamOperationQueue } from '../../core/application/TeamOperationQueue';
import type { NativeOpenCodeMemberDeliveryPort } from '../adapters/input/NativeTeamMessagingApi';
import type { NativeOpenCodeBootstrapEvidence } from '../adapters/output/NativeOpenCodeBootstrapEvidence';
import type { NativePromptLedgerAccess } from '../adapters/output/NativeOpenCodePromptDeliverySupervisor';
import type { NativeSecondaryRuntimeRunStore } from '../adapters/output/NativeSecondaryRuntimeRunStore';
import type { NativeOpenCodeDeliveryWatchdogDependencies } from './createNativeOpenCodeDeliveryWatchdog';
import type {
  DeliverableTrackedRun,
  OpenCodeMemberMessageDeliveryInput,
} from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodeMemberInboxDelivery } from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodeRuntimeMessageAdapter } from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodePromptDeliveryLedgerRecord } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import type { RelayInboxMessage } from '@main/services/team/provisioning/TeamProvisioningInboxRelayPolicy';
import type { OpenCodeInboxAttachmentPayloadsResult } from '@main/services/team/provisioning/TeamProvisioningOpenCodeAttachmentPayloads';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime/TeamRuntimeAdapter';
import type { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import type { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import type { TeamMembersMetaStore } from '@main/services/team/TeamMembersMetaStore';
import type { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import type { InboxMessage, TeamChangeEvent, TeamConfig, TeamTask } from '@shared/types';

/**
 * Everything the OpenCode delivery path needs from the shell: paths, stores, the
 * runtime's own bridges, and the readers. Nothing here is the service being retired.
 */
export interface NativeOpenCodeDeliveryStackSources {
  teamsBasePath: string;
  launchState: Pick<TeamLaunchStateStore, 'read' | 'write'>;
  /** Team liveness as the runtime owner reports it, by team name. */
  isTeamAlive(teamName: string): boolean;
  isManagedByThisProfile(teamName: string): Promise<boolean>;
  runs: NativeSecondaryRuntimeRunStore;
  openCodeAdapter(): TeamLaunchRuntimeAdapter | null;
  /** The lane's message bridge; the only thing that can accept a prompt. */
  messageAdapter(): OpenCodeRuntimeMessageAdapter | null;
  config: { read(teamName: string): Promise<TeamConfig | null> };
  teamMeta: Pick<TeamMetaStore, 'getMeta'>;
  membersMeta: Pick<TeamMembersMetaStore, 'getMeta'>;
  inbox: Pick<TeamInboxReader, 'getMessagesFor'>;
  readInbox(teamName: string, inboxName: string): Promise<readonly unknown[]>;
  readTasks(teamName: string): Promise<readonly TeamTask[]>;
  queue: Pick<TeamOperationQueue, 'run'>;
  controlUrlResolver(): (() => Promise<string | null>) | null;
  stoppingTeams: { has(teamName: string): boolean };
  isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean;
  readPersistedTeamProjectPath(teamName: string): string | null;
  /**
   * Launch metadata for a run, projected from the persisted launch state. The delivery
   * service reads it synchronously, so the shell keeps a cache that is refreshed when a
   * team's launch state changes; an unknown run answers undefined and the delivery falls
   * back to the configured identity rather than inventing a model.
   */
  readRun(runId: string): DeliverableTrackedRun | undefined;
  resolveOpenCodeInboxAttachmentPayloads(input: {
    teamName: string;
    message: RelayInboxMessage;
  }): Promise<OpenCodeInboxAttachmentPayloadsResult>;
  hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  hasAcknowledgedInbound: NonNullable<
    Parameters<typeof createNativeOpenCodeVisibleReplyProof>[0]['hasAcknowledgedInbound']
  >;
  permissionListingAdapter: Parameters<
    typeof createNativeOpenCodeRuntimePermissionSync
  >[0]['getPermissionListingAdapter'];
  syncToolApprovals: Parameters<
    typeof createNativeOpenCodeRuntimePermissionSync
  >[0]['syncToolApprovals'];
  emitRuntimeDeliveryReplyAdvisoryRefresh(teamName: string, message: InboxMessage): void;
  emitTeamChange(event: TeamChangeEvent): void;
  emitMemberSpawnChange(input: {
    teamName: string;
    runId?: string | null;
    memberName: string;
  }): void;
  emitPromptDeliveryTaskLogChange(record: OpenCodePromptDeliveryLedgerRecord, detail: string): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  logPromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  logger: {
    info(message: string, context?: string): void;
    warn(message: string): void;
    debug(message: string): void;
  };
  now?(): string;
}

export interface NativeOpenCodeDeliveryStack {
  /** Whether a member is mid-turn, for the UI that asks before it sends. */
  busyStatus: NativeOpenCodeDeliveryBusyStatus;
  /**
   * The lane a runtime names for a member. The host speaks in members; ledgers, evidence
   * and approvals are keyed by lane, so this is the one translation between them.
   */
  resolveRuntimeLaneId(input: {
    teamName: string;
    runId: string;
    memberName?: string;
  }): Promise<string>;
  /** Bootstrapped session evidence; the runtime-control checkin commits into it. */
  bootstrap: NativeOpenCodeBootstrapEvidence;
  /** Whether a member is delivered to through an OpenCode lane at all. */
  isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean>;
  /** The messaging surface the root binds: relay a member's inbox, and status. */
  deliveryPort: NativeOpenCodeMemberDeliveryPort;
  /** One wake scheduler for the whole app; two would double every retry. */
  clearStoppedLaneStopBackoff(teamName: string): void;
  scheduler: OpenCodePromptDeliveryWatchdogScheduler;
  /** The delivery service itself, for the paths that send directly. */
  deliver(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery>;
  /** Everything the scan passes need, over the same adapters as the delivery path. */
  watchdogDeps: NativeOpenCodeDeliveryWatchdogDependencies;
}

/**
 * One delivery path: the service, the relay over it, the scheduler that wakes it, and
 * the scan passes that recover what it lost.
 *
 * The scheduler and the coordinator reference each other - a wake arms the scheduler,
 * and the scheduler's answer is judged by the coordinator - so the scheduler is bound
 * late. Every other edge is a plain dependency, which is what keeps a scan and a send
 * reading the same ledger, lanes and proofs.
 */
export function createNativeOpenCodeDeliveryStack(
  sources: NativeOpenCodeDeliveryStackSources
): NativeOpenCodeDeliveryStack {
  const nowIso = sources.now ?? (() => new Date().toISOString());
  const isLive = (teamName: string) =>
    sources.openCodeAdapter() !== null && sources.isTeamAlive(teamName);
  const getOpenCodeRuntimeAdapter = () => sources.openCodeAdapter();
  const stoppedLanes = createNativeOpenCodeStoppedTeamLaneCleanup({
    teamsBasePath: sources.teamsBasePath,
    isManagedByThisProfile: (teamName) => sources.isManagedByThisProfile(teamName),
    queue: sources.queue,
    readConfig: (teamName) => sources.config.read(teamName),
    readMembersMeta: async (teamName) =>
      (await sources.membersMeta.getMeta(teamName))?.members ?? [],
    canDeliverToOpenCodeRuntimeForTeam: (teamName) => isLive(teamName),
    getOpenCodeRuntimeAdapter,
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      sources.runs.deleteSecondaryRuntimeRun(teamName, laneId),
    clearPrimaryRuntimeRun: (teamName) => sources.runs.clearPrimaryRuntimeRun(teamName),
    logger: { info: (m) => sources.logger.info(m), warn: (m) => sources.logger.warn(m) },
  });
  const recovery = createNativeOpenCodeRecoveryHost({
    teamsBasePath: sources.teamsBasePath,
    launchState: sources.launchState,
    runs: sources.runs,
    config: sources.config,
    teamMeta: sources.teamMeta,
    membersMeta: sources.membersMeta,
    isDeliverable: (teamName) => isLive(teamName),
    cleanupStoppedLanesInBackground: (teamName) =>
      stoppedLanes.stopLanesForStoppedTeamInBackground(teamName),
    readPersistedTeamProjectPath: (teamName) => sources.readPersistedTeamProjectPath(teamName),
    openCodeAdapter: () => sources.openCodeAdapter(),
    logger: sources.logger,
  });
  const { identity } = recovery;
  const pidMemory = createNativeOpenCodeRuntimePidMemory({
    store: sources.launchState,
    invalidateRuntimeSnapshotCaches: (teamName) =>
      sources.invalidateRuntimeSnapshotCaches(teamName),
    emitTeamChange: (event) => sources.emitTeamChange(event),
    logDebug: (message) => sources.logger.debug(message),
    now: nowIso,
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
    runs: { aliveRunId: (teamName) => sources.runs.getPrimaryRuntimeRun(teamName)?.runId ?? null },
    readConfig: (teamName) => sources.config.read(teamName),
    getPermissionListingAdapter: () => sources.permissionListingAdapter(),
    store: sources.launchState,
    syncToolApprovals: (input) => sources.syncToolApprovals(input),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      sources.invalidateRuntimeSnapshotCaches(teamName),
    emitMemberSpawnChange: (input) => sources.emitMemberSpawnChange(input),
    logger: { warn: (m) => sources.logger.warn(m), debug: (m) => sources.logger.debug(m) },
    now: nowIso,
    serializeLaunchStateUpdate: (teamName, operation) => sources.queue.run(teamName, operation),
  });
  const lanes = createNativeOpenCodeLaneRecovery({
    teamsBasePath: sources.teamsBasePath,
    identity,
    readConfig: (teamName) => sources.config.read(teamName),
    logger: { info: (m) => sources.logger.info(m), warn: (m) => sources.logger.warn(m) },
    canDeliverToOpenCodeRuntimeForTeam: recovery.ports.canDeliverToOpenCodeRuntimeForTeam,
    canAttemptCommittedOpenCodeSessionRecovery:
      recovery.ports.canAttemptCommittedOpenCodeSessionRecovery,
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground:
      recovery.ports.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground,
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime:
      recovery.ports.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime,
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime:
      recovery.ports.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime,
  });
  const bootstrap = createNativeOpenCodeBootstrapEvidence({
    teamsBasePath: sources.teamsBasePath,
    resolveCurrentOpenCodeRuntimeRunId: async (teamName, laneId) =>
      sources.runs.getSecondaryRuntimeRuns(teamName).find((entry) => entry.laneId === laneId)
        ?.runId ?? null,
    warn: (message) => sources.logger.warn(message),
  });
  const openLedger = createNativeOpenCodePromptDeliveryLedgerFactory(sources.teamsBasePath);
  const ledgers: NativePromptLedgerAccess = {
    open: (teamName, laneId) => openLedger(teamName, laneId),
  };

  /**
   * The scheduler is bound after the service exists, because a wake is a delivery and
   * the delivery needs the host that asks the scheduler what to do next.
   */
  let schedulerRef: OpenCodePromptDeliveryWatchdogScheduler | null = null;
  const schedulerPort = {
    isEnabled: () => schedulerRef?.isEnabled() ?? false,
    schedule: (input: Parameters<OpenCodePromptDeliveryWatchdogScheduler['schedule']>[0]) =>
      schedulerRef?.schedule(input),
    isStaleError: async (
      input: Parameters<OpenCodePromptDeliveryWatchdogScheduler['isStaleError']>[0]
    ) => (await schedulerRef?.isStaleError(input)) ?? false,
  };

  const coordinator = new OpenCodePromptDeliveryWatchdogCoordinator({
    hasAcknowledgedInbound: sources.hasAcknowledgedInbound,
    hasAcceptedMemberWorkSyncReport: (input) => sources.hasAcceptedMemberWorkSyncReport(input),
    taskRefsIncludeAll: openCodeTaskRefsIncludeAll,
    visibleReplyProofService: proof,
    maybeSyncRuntimePermissionsAfterDelivery: (input) => permissions.syncAfterDelivery(input),
    rememberRuntimePidFromBridge: (input) => pidMemory.rememberRuntimePidFromBridge(input),
    watchdogScheduler: schedulerPort,
    canDeliverToTeamRuntime: (teamName) => isLive(teamName),
    recoverRuntimeLanesForWatchdog: (teamName, options) =>
      lanes.recoverLanesForWatchdog(teamName, options),
    stopRuntimeLanesForStoppedTeam: (teamName) => stoppedLanes.stopLanesForStoppedTeam(teamName),
    readActiveRuntimeLaneIds: async (teamName) => {
      const laneIndex = await readOpenCodeRuntimeLaneIndex(sources.teamsBasePath, teamName).catch(
        () => null
      );
      if (!laneIndex) return null;
      return Object.values(laneIndex.lanes)
        .filter((lane) => lane.state === 'active')
        .map((lane) => lane.laneId);
    },
    createLedger: (teamName, laneId) => ledgers.open(teamName, laneId),
    resolveMembersForRuntimeLane: (teamName, laneId) =>
      identity.resolveMembersForRuntimeLane(teamName, laneId),
    getInboxMessages: async (teamName, memberName) =>
      (await sources.inbox.getMessagesFor(teamName, memberName)) as InboxMessage[],
    resolveCurrentRuntimeRunId: (teamName, laneId) =>
      identity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
    resolveTrackedBootstrapRunId: (input) =>
      sources.runs
        .getSecondaryRuntimeRuns(input.teamName)
        .find((entry) => entry.laneId === input.laneId)?.runId === input.runId
        ? input.runId
        : null,
    hasCommittedBootstrapSession: (input) => bootstrap.hasCommittedBootstrapSession(input),
    hasStableInboxMessageId,
    logPromptDeliveryEvent: (event, record, extra) =>
      sources.logPromptDeliveryEvent(event, record, extra),
    info: (message, context) => sources.logger.info(message, context),
    warn: (message) => sources.logger.warn(message),
    nowIso,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    getErrorMessage,
  });

  const host = createNativeOpenCodeDeliveryHost({
    teamsBasePath: sources.teamsBasePath,
    recovery,
    runs: sources.runs,
    scheduler: schedulerPort,
    ledgers,
    proof,
    permissions,
    pidMemory,
    stoppedLanes,
    coordinator,
    inbox: sources.inbox,
    queue: sources.queue,
    config: sources.config,
    controlUrlResolver: () => sources.controlUrlResolver(),
    messageAdapter: () => sources.messageAdapter(),
    stoppingTeams: sources.stoppingTeams,
    isMemberLifecycleOperationActive: (teamName, memberName) =>
      sources.isMemberLifecycleOperationActive(teamName, memberName),
    readPersistedTeamProjectPath: (teamName) => sources.readPersistedTeamProjectPath(teamName),
    readRun: (runId) => sources.readRun(runId),
    emitPromptDeliveryTaskLogChange: (record, detail) =>
      sources.emitPromptDeliveryTaskLogChange(record, detail),
    logPromptDeliveryEvent: (event, record, extra) =>
      sources.logPromptDeliveryEvent(event, record, extra),
    logger: sources.logger,
    now: nowIso,
  });
  const service = createOpenCodeMemberMessageDeliveryServiceFromHost(host);

  const deliveryPort = createNativeOpenCodeMemberDeliveryPort({
    teamsBasePath: sources.teamsBasePath,
    isManagedByThisProfile: (teamName) => sources.isManagedByThisProfile(teamName),
    readConfig: (teamName) => sources.config.read(teamName),
    readTeamMeta: (teamName) => sources.teamMeta.getMeta(teamName),
    readMetaMembers: async (teamName) =>
      (await sources.membersMeta.getMeta(teamName))?.members ?? [],
    readSecondaryRuntimeRuns: async (teamName) => sources.runs.getSecondaryRuntimeRuns(teamName),
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      sources.runs.getSecondaryRuntimeRuns(teamName).find((entry) => entry.laneId === laneId)
        ?.runId ?? null,
    readInbox: (teamName, inboxName) => sources.readInbox(teamName, inboxName),
    readTasks: (teamName) => sources.readTasks(teamName),
    deliverOpenCodeMemberMessage: (teamName, input) => service.deliver(teamName, input),
    scheduleOpenCodeMemberInboxDeliveryWake: (input) => schedulerPort.schedule(input as never),
    resolveOpenCodeInboxAttachmentPayloads: (input) =>
      sources.resolveOpenCodeInboxAttachmentPayloads(input),
    logPromptDeliveryEvent: (event, record, extra) =>
      sources.logPromptDeliveryEvent(event, record, extra),
    emitRuntimeDeliveryReplyAdvisoryRefresh: (teamName, message) =>
      sources.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message),
    suppressRuntimeInactiveWarning: () => false,
    hasAcceptedMemberWorkSyncReport: (input) => sources.hasAcceptedMemberWorkSyncReport(input),
    canDeliverToOpenCodeRuntimeForTeam: (teamName) => isLive(teamName),
    canAttemptCommittedOpenCodeSessionRecovery: (teamName) => isLive(teamName),
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
      stoppedLanes.stopLanesForStoppedTeamInBackground(teamName),
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime:
      recovery.ports.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime,
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime:
      recovery.ports.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime,
    logger: { info: (m) => sources.logger.info(m), warn: (m) => sources.logger.warn(m) },
    now: nowIso,
    getErrorMessage,
  });

  const busyStatus = new NativeOpenCodeDeliveryBusyStatus({
    teamsBasePath: sources.teamsBasePath,
    identity,
    inbox: sources.inbox,
    recoverLaneForConfiguredMemberBeforeDelivery: (input) =>
      recovery.facade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input),
    recoverLaneAndVerifyActive: (input) =>
      recovery.facade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input),
    createLedger: (teamName, laneId) => ledgers.open(teamName, laneId),
    scheduleWake: (input) => schedulerPort.schedule(input as never),
  });

  const scheduler = new OpenCodePromptDeliveryWatchdogScheduler({
    canDeliverToTeamRuntime: (teamName) => isLive(teamName),
    recoverBeforeDelivery: async ({ teamName, memberName }) => {
      if (!(await sources.isManagedByThisProfile(teamName))) return false;
      return recovery.facade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery({
        teamName,
        memberName,
      });
    },
    relay: async ({ teamName, memberName, messageId, isCurrent }) => {
      const result = await deliveryPort.relayOpenCodeMemberInboxMessages(teamName, memberName, {
        onlyMessageId: messageId,
        source: 'watchdog',
        ...(isCurrent ? { isCurrent } : {}),
      });
      return { diagnostics: result.diagnostics };
    },
    getInboxMessages: async ({ teamName, memberName }) =>
      (await sources.inbox.getMessagesFor(teamName, memberName)) as never,
    resolveIdentity: async ({ teamName, memberName }) => {
      const resolved = await identity.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName);
      return resolved.ok
        ? { ok: true, ...(resolved.laneId ? { laneId: resolved.laneId } : {}) }
        : { ok: false };
    },
    isLaneActive: ({ teamName, laneId }) =>
      identity.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
    isRecordNotFoundError: (error) => /ENOENT|not found|no such file/i.test(getErrorMessage(error)),
    info: (message) => sources.logger.info(message),
    warn: (message) => sources.logger.warn(message),
    debug: (message) => sources.logger.debug(message),
    diagnostic: (message) => sources.logger.debug(message),
    getErrorMessage,
  });
  schedulerRef = scheduler;

  return {
    busyStatus,
    bootstrap,
    resolveRuntimeLaneId: async ({ teamName, memberName }) => {
      const resolved = await identity.resolveOpenCodeMemberDeliveryIdentity(
        teamName,
        memberName ?? ''
      );
      if (!resolved.ok || !resolved.laneId) {
        // Payload-shaped message: the control route maps it to a 400, not a 500, because
        // the caller named a member this team has no lane for.
        throw new Error(
          `OpenCode runtime payload names no lane for ${memberName ?? 'the named member'} of ${teamName}`
        );
      }
      return resolved.laneId;
    },
    isOpenCodeRuntimeRecipient: (teamName, memberName) =>
      identity.isOpenCodeRuntimeRecipient(teamName, memberName),
    deliveryPort,
    scheduler,
    clearStoppedLaneStopBackoff: (teamName) => stoppedLanes.clearStopBackoff(teamName),
    deliver: (teamName, input) => service.deliver(teamName, input),
    watchdogDeps: {
      teamsBasePath: sources.teamsBasePath,
      scheduler,
      identity,
      ledgers,
      proof,
      permissions,
      pidMemory,
      bootstrap,
      lanes,
      stoppedLanes,
      readInboxMessages: async (teamName, memberName) =>
        (await sources.inbox.getMessagesFor(teamName, memberName)) as InboxMessage[],
      canDeliverToTeamRuntime: (teamName) => isLive(teamName),
      hasAcceptedMemberWorkSyncReport: (input) => sources.hasAcceptedMemberWorkSyncReport(input),
      hasAcknowledgedInbound: sources.hasAcknowledgedInbound,
      logPromptDeliveryEvent: sources.logPromptDeliveryEvent,
      info: (message, context) => sources.logger.info(message, context),
      warn: (message) => sources.logger.warn(message),
      nowIso,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      getErrorMessage,
    },
  };
}

export { getErrorMessage };
