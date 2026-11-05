import { OpenCodePromptDeliveryFollowUpPolicy } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryFollowUpPolicy';
import { OPENCODE_STALE_PENDING_POLICY_CONFIG } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryStalePendingPolicy';
import { resolveControlApiBaseUrlForProvisioning } from '@main/services/team/provisioning/TeamProvisioningEnvRuntimePorts';
import { createOpenCodeRuntimeBootstrapEvidencePorts } from '@main/services/team/provisioning/TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory';
import { getErrorMessage } from '@shared/utils/errorHandling';

import type { TeamOperationQueue } from '../../core/application/TeamOperationQueue';
import type { NativePromptLedgerAccess } from '../adapters/output/NativeOpenCodePromptDeliverySupervisor';
import type { NativeOpenCodeRuntimePermissionSync } from '../adapters/output/NativeOpenCodeRuntimePermissionSync';
import type { NativeOpenCodeRuntimePidMemory } from '../adapters/output/NativeOpenCodeRuntimePidMemory';
import type { NativeOpenCodeStoppedTeamLaneCleanup } from '../adapters/output/NativeOpenCodeStoppedTeamLaneCleanup';
import type { NativeOpenCodeVisibleReplyProof } from '../adapters/output/NativeOpenCodeVisibleReplyProof';
import type { NativeSecondaryRuntimeRunStore } from '../adapters/output/NativeSecondaryRuntimeRunStore';
import type { NativeOpenCodeRecoveryHost } from './createNativeOpenCodeRecoveryHost';
import type { OpenCodeRuntimeMessageAdapter } from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { DeliverableTrackedRun } from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodePromptDeliveryLedgerRecord } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import type { OpenCodePromptDeliveryWatchdogCoordinator } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import type { OpenCodePromptDeliveryWatchdogScheduler } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import type { TeamProvisioningOpenCodeMemberMessageDeliveryHost } from '@main/services/team/provisioning/TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory';
import type { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import type { TeamConfig } from '@shared/types';

/**
 * Everything the delivery service needs from the shell, given as the pieces that are
 * already built for the watchdog. The service itself is reused: what changes is who
 * owns its ports.
 */
export interface NativeOpenCodeDeliveryHostSources {
  teamsBasePath: string;
  recovery: NativeOpenCodeRecoveryHost;
  runs: NativeSecondaryRuntimeRunStore;
  scheduler: Pick<OpenCodePromptDeliveryWatchdogScheduler, 'isEnabled' | 'schedule' | 'isStaleError'>;
  ledgers: NativePromptLedgerAccess;
  proof: Pick<
    NativeOpenCodeVisibleReplyProof,
    'applyDestinationProof' | 'materializePlainTextReplyIfNeeded' | 'findByRelayOfMessageId'
  >;
  permissions: Pick<NativeOpenCodeRuntimePermissionSync, 'syncAfterDelivery'>;
  pidMemory: Pick<NativeOpenCodeRuntimePidMemory, 'rememberRuntimePidFromBridge'>;
  stoppedLanes: Pick<NativeOpenCodeStoppedTeamLaneCleanup, 'stopLanesForStoppedTeamInBackground'>;
  coordinator: OpenCodePromptDeliveryWatchdogCoordinator;
  inbox: Pick<TeamInboxReader, 'getMessagesFor'>;
  queue: Pick<TeamOperationQueue, 'run'>;
  config: { read(teamName: string): Promise<TeamConfig | null> };
  controlUrlResolver(): (() => Promise<string | null>) | null;
  /** The lane's message bridge; the only place that knows the runtime session. */
  messageAdapter(): OpenCodeRuntimeMessageAdapter | null;
  /** Teams whose secondary lanes are being stopped; delivery must not race a stop. */
  stoppingTeams: { has(teamName: string): boolean };
  isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean;
  readPersistedTeamProjectPath(teamName: string): string | null;
  /** Run snapshot the delivery service asks for by id. */
  readRun(runId: string): DeliverableTrackedRun | undefined;
  emitPromptDeliveryTaskLogChange(record: OpenCodePromptDeliveryLedgerRecord, detail: string): void;
  logPromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  logger: {
    info(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
  };
  now?(): string;
}

/**
 * The delivery service's ports, assembled from the native adapters.
 *
 * Every policy question is answered by the coordinator the watchdog also uses, so a
 * record judged pending here and by a scan cannot disagree. The two pieces that are
 * genuinely new are the lane's message bridge and the serialization of sends; the
 * rest is the adapters that already own ledgers, proofs, permissions and pids.
 */
export function createNativeOpenCodeDeliveryHost(
  sources: NativeOpenCodeDeliveryHostSources
): TeamProvisioningOpenCodeMemberMessageDeliveryHost {
  const nowIso = sources.now ?? (() => new Date().toISOString());
  const followUpPolicy = new OpenCodePromptDeliveryFollowUpPolicy({
    markFailedTerminal: (input) => sources.coordinator.markLedgerFailedTerminal(input),
    logEvent: (event, record, extra) => sources.logPromptDeliveryEvent(event, record, extra),
    scheduleWatchdog: (input) => sources.scheduler.schedule(input as never),
    nowIso,
  });
  return {
    getOpenCodeRuntimeMessageAdapter: () => sources.messageAdapter(),
    openCodeRuntimeRecoveryFacade: {
      readOpenCodeMemberDirectory: (teamName) =>
        sources.recovery.identity.readOpenCodeMemberDirectory(teamName),
      resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
        sources.recovery.identity.resolveOpenCodeMemberIdentityFromDirectory(
          teamName,
          memberName,
          directory
        ),
      tryRecoverOpenCodeRuntimeLaneBeforeDelivery: (input) =>
        sources.recovery.facade.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input),
      tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: (input) =>
        sources.recovery.facade.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
          input
        ),
      openCodeRuntimeRecoveryIdentity: {
        resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
          sources.recovery.identity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
        resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
          sources.recovery.identity.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
        resolveOpenCodeMembersForRuntimeLane: (teamName, laneId) =>
          sources.recovery.identity.resolveMembersForRuntimeLane(teamName, laneId),
        isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
          sources.recovery.identity.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
      },
    },
    tryRecoverOpenCodeRuntimeLaneBeforeDelivery: (input) =>
      sources.recovery.facade.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input),
    tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: (input) =>
      sources.recovery.facade.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input),
    isMemberLifecycleOperationActive: (teamName, memberName) =>
      sources.isMemberLifecycleOperationActive(teamName, memberName),
    stoppingSecondaryRuntimeTeams: sources.stoppingTeams,
    readPersistedTeamProjectPath: (teamName) => sources.readPersistedTeamProjectPath(teamName),
    runTracking: {
      resolveDeliverableTrackedRuntimeRunId: (teamName) =>
        sources.runs.getPrimaryRuntimeRun(teamName)?.runId ?? null,
    },
    runs: { get: (runId) => sources.readRun(runId) as never },
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      sources.runs.getSecondaryRuntimeRuns(teamName).find((entry) => entry.laneId === laneId)
        ?.runId ?? null,
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      sources.runs.deleteSecondaryRuntimeRun(teamName, laneId),
    openCodeStoppedLaneCleanup: {
      cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
        sources.stoppedLanes.stopLanesForStoppedTeamInBackground(teamName),
    },
    createOpenCodeRuntimeBootstrapEvidencePorts: () =>
      createOpenCodeRuntimeBootstrapEvidencePorts({
        teamsBasePath: sources.teamsBasePath,
        warn: (message) => sources.logger.warn(message),
      }),
    providerRuntime: {
      resolveControlApiBaseUrl: () =>
        resolveControlApiBaseUrlForProvisioning({
          getControlApiBaseUrlResolver: () => sources.controlUrlResolver(),
          logger: {
            warn: (...args: unknown[]) => sources.logger.warn(args.join(' ')),
            error: (...args: unknown[]) => sources.logger.warn(args.join(' ')),
          },
        }),
    },
    sendOpenCodeMemberMessageToRuntimeSerialized: (input) =>
      sources.queue.run(input.teamName, () => input.send()),
    rememberOpenCodeRuntimePidFromBridge: (input) =>
      sources.pidMemory.rememberRuntimePidFromBridge(input),
    maybeSyncOpenCodeRuntimePermissionsAfterDelivery: (input) =>
      sources.permissions.syncAfterDelivery(input),
    isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: (input) =>
      sources.coordinator.isLegacyMemberWorkSyncReadCommitAllowed(input),
    createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
      sources.ledgers.open(teamName, laneId),
    openCodeVisibleReplyProofService: sources.proof,
    openCodePromptDeliveryWatchdogScheduler: sources.scheduler,
    openCodePromptDeliveryFollowUpPolicy: followUpPolicy,
    openCodeStalePendingPolicyConfig: OPENCODE_STALE_PENDING_POLICY_CONFIG,
    isOpenCodeDeliveryResponseReadCommitAllowed: (input) =>
      sources.coordinator.isDeliveryResponseReadCommitAllowed(input),
    getOpenCodeDeliveryPendingReason: (input) =>
      sources.coordinator.getDeliveryPendingReason(input),
    markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: (input) =>
      sources.coordinator.markAcceptedDeliveryMissingPromptProofForRetry(input),
    scheduleOpenCodePromptDeliveryWatchdog: (input) =>
      sources.scheduler.schedule(input as never),
    logOpenCodePromptDeliveryEvent: (event, record, extra) =>
      sources.logPromptDeliveryEvent(event, record, extra),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: (input) =>
      sources.coordinator.requeueRuntimeManifestWatermarkDeliveryIfNeeded(input),
    emitOpenCodePromptDeliveryTaskLogChange: (record, detail) =>
      sources.emitPromptDeliveryTaskLogChange(record, detail),
    observeOpenCodeDirectUserDeliveryInlineIfNeeded: (input) =>
      sources.coordinator.observeDirectUserDeliveryInlineIfNeeded(input),
  };
}

export { getErrorMessage };
