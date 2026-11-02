import {
  OpenCodePromptDeliveryWatchdogCoordinator,
  type OpenCodePromptDeliveryWatchdogCoordinatorPorts,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { openCodeTaskRefsIncludeAll } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofMatching';
import { readOpenCodeRuntimeLaneIndex } from '@main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { hasStableInboxMessageId } from '@main/services/team/provisioning/TeamProvisioningInboxRelayPolicy';

import type { NativeOpenCodeBootstrapEvidence } from '../adapters/output/NativeOpenCodeBootstrapEvidence';
import type { NativeOpenCodeLaneRecovery } from '../adapters/output/NativeOpenCodeLaneRecovery';
import type { NativeOpenCodeMemberIdentity } from '../adapters/output/NativeOpenCodeMemberIdentity';
import type { NativePromptLedgerAccess } from '../adapters/output/NativeOpenCodePromptDeliverySupervisor';
import type { NativeOpenCodeRuntimePermissionSync } from '../adapters/output/NativeOpenCodeRuntimePermissionSync';
import type { NativeOpenCodeRuntimePidMemory } from '../adapters/output/NativeOpenCodeRuntimePidMemory';
import type { NativeOpenCodeStoppedTeamLaneCleanup } from '../adapters/output/NativeOpenCodeStoppedTeamLaneCleanup';
import type { NativeOpenCodeVisibleReplyProof } from '../adapters/output/NativeOpenCodeVisibleReplyProof';
import type { OpenCodeGroupAcknowledgementReader } from '@main/services/team/opencode/delivery/OpenCodeGroupAcknowledgement';
import type { OpenCodePromptDeliveryLedgerRecord } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import type { OpenCodePromptDeliveryWatchdogScheduler } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import type { InboxMessage } from '@shared/types';

/**
 * The pass that finds deliveries nobody is watching any more.
 *
 * Two of them exist and they are different questions. At startup every team is
 * swept: records are rebuilt from the inbox, dead lanes are brought back, and
 * teams that are gone are cleaned away. While the app runs, the same sweep is
 * wrong - a row without a record was left that way on purpose (queued behind a
 * live delivery, or a rider waiting for its anchor), and rebuilding its record
 * would overwrite the relay's own decision. So the running pass only wakes what
 * lost its trigger and lets the relay record it.
 *
 * The coordinator that holds those policies is reused as is; what the native
 * owner supplies is every fact it reads, so the answer comes from the same
 * files the delivery path writes.
 */
export interface NativeOpenCodeDeliveryWatchdogDependencies {
  teamsBasePath: string;
  /** The one wake scheduler of the app; two would double every retry. */
  scheduler: Pick<OpenCodePromptDeliveryWatchdogScheduler, 'isEnabled' | 'schedule' | 'isStaleError'>;
  identity: Pick<
    NativeOpenCodeMemberIdentity,
    'resolveMembersForRuntimeLane' | 'resolveCurrentOpenCodeRuntimeRunId'
  >;
  ledgers: NativePromptLedgerAccess;
  proof: Pick<
    NativeOpenCodeVisibleReplyProof,
    'applyDestinationProof' | 'materializePlainTextReplyIfNeeded'
  >;
  permissions: Pick<NativeOpenCodeRuntimePermissionSync, 'syncAfterDelivery'>;
  pidMemory: Pick<NativeOpenCodeRuntimePidMemory, 'rememberRuntimePidFromBridge'>;
  bootstrap: Pick<
    NativeOpenCodeBootstrapEvidence,
    'resolveTrackedBootstrapRunId' | 'hasCommittedBootstrapSession'
  >;
  lanes: Pick<NativeOpenCodeLaneRecovery, 'recoverLanesForWatchdog'>;
  stoppedLanes: Pick<NativeOpenCodeStoppedTeamLaneCleanup, 'stopLanesForStoppedTeam'>;
  readInboxMessages(teamName: string, memberName: string): Promise<InboxMessage[]>;
  canDeliverToTeamRuntime(teamName: string): boolean;
  hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  hasAcknowledgedInbound: OpenCodeGroupAcknowledgementReader;
  logPromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  info(message: string, context?: string): void;
  warn(message: string): void;
  nowIso(): string;
  sleep(ms: number): Promise<void>;
  getErrorMessage(error: unknown): string;
}

export interface NativeOpenCodeDeliveryWatchdog {
  /** Startup recovery: rebuild what an interrupted session left behind. */
  scan(teamName: string): Promise<number>;
  /** Periodic pass for a running app: wake what lost its trigger, rebuild nothing. */
  scanContinuity(teamName: string): Promise<number>;
  /** The same pass over lanes the caller already resolved. */
  scanActiveLanes(teamName: string, laneIds: string[]): Promise<number>;
  /**
   * The one coordinator behind the passes. The delivery service reads its policies
   * from here, so a record judged pending by a scan and by a send uses one rule set.
   */
  coordinator: OpenCodePromptDeliveryWatchdogCoordinator;
}

export function createNativeOpenCodeDeliveryWatchdog(
  deps: NativeOpenCodeDeliveryWatchdogDependencies
): NativeOpenCodeDeliveryWatchdog {
  /**
   * Which run each lane is on. The coordinator asks this synchronously, per
   * delivery record, while the honest answer needs a disk read - so the answer
   * is captured right before each pass, and again after recovery has revived a
   * lane, because a revived lane is on the run its evidence proved.
   */
  const runByLane = new Map<string, string | null>();
  const laneKey = (teamName: string, laneId: string): string => `${teamName}\u0000${laneId}`;
  const readActiveLaneIds = async (teamName: string): Promise<string[] | null> => {
    const laneIndex = await readOpenCodeRuntimeLaneIndex(deps.teamsBasePath, teamName).catch(
      () => null
    );
    if (!laneIndex) return null;
    return Object.values(laneIndex.lanes)
      .filter((lane) => lane.state === 'active')
      .map((lane) => lane.laneId);
  };
  const captureLanes = async (teamName: string, laneIds: readonly string[]): Promise<void> => {
    await Promise.all(
      laneIds.map(async (laneId) => {
        runByLane.set(
          laneKey(teamName, laneId),
          await deps.identity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId).catch(() => null)
        );
      })
    );
  };
  const captureTeam = async (teamName: string): Promise<void> => {
    await captureLanes(teamName, (await readActiveLaneIds(teamName)) ?? []);
  };

  const ports: OpenCodePromptDeliveryWatchdogCoordinatorPorts = {
    hasAcknowledgedInbound: deps.hasAcknowledgedInbound,
    hasAcceptedMemberWorkSyncReport: (input) => deps.hasAcceptedMemberWorkSyncReport(input),
    taskRefsIncludeAll: openCodeTaskRefsIncludeAll,
    visibleReplyProofService: deps.proof,
    maybeSyncRuntimePermissionsAfterDelivery: (input) => deps.permissions.syncAfterDelivery(input),
    rememberRuntimePidFromBridge: (input) => deps.pidMemory.rememberRuntimePidFromBridge(input),
    watchdogScheduler: deps.scheduler,
    canDeliverToTeamRuntime: (teamName) => deps.canDeliverToTeamRuntime(teamName),
    recoverRuntimeLanesForWatchdog: async (teamName, options) => {
      const recovered = await deps.lanes.recoverLanesForWatchdog(teamName, options);
      await captureTeam(teamName);
      return recovered;
    },
    stopRuntimeLanesForStoppedTeam: (teamName) => deps.stoppedLanes.stopLanesForStoppedTeam(teamName),
    readActiveRuntimeLaneIds: (teamName) => readActiveLaneIds(teamName),
    createLedger: (teamName, laneId) => deps.ledgers.open(teamName, laneId),
    resolveMembersForRuntimeLane: (teamName, laneId) =>
      deps.identity.resolveMembersForRuntimeLane(teamName, laneId),
    getInboxMessages: (teamName, memberName) => deps.readInboxMessages(teamName, memberName),
    resolveCurrentRuntimeRunId: (teamName, laneId) =>
      deps.identity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
    resolveTrackedBootstrapRunId: (input) => {
      const current = runByLane.get(laneKey(input.teamName, input.laneId)) ?? null;
      return current === input.runId ? input.runId : null;
    },
    hasCommittedBootstrapSession: (input) => deps.bootstrap.hasCommittedBootstrapSession(input),
    hasStableInboxMessageId,
    logPromptDeliveryEvent: (event, record, extra) =>
      deps.logPromptDeliveryEvent(event, record, extra),
    info: (message, context) => deps.info(message, context),
    warn: (message) => deps.warn(message),
    nowIso: () => deps.nowIso(),
    sleep: (ms) => deps.sleep(ms),
    getErrorMessage: (error) => deps.getErrorMessage(error),
  };

  const coordinator = new OpenCodePromptDeliveryWatchdogCoordinator(ports);

  return {
    coordinator,
    scan: async (teamName) => {
      await captureTeam(teamName);
      return await coordinator.scan(teamName);
    },
    scanContinuity: async (teamName) => {
      await captureTeam(teamName);
      return await coordinator.scanContinuity(teamName);
    },
    scanActiveLanes: async (teamName, laneIds) => {
      await captureLanes(teamName, laneIds);
      return await coordinator.scanActiveLanes(teamName, laneIds);
    },
  };
}
