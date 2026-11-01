import { createNativeOpenCodeDeliveryReadCommitPolicy } from '../adapters/output/NativeOpenCodeDeliveryReadCommit';
import { createNativeOpenCodeDeliveryStatusQuery } from '../adapters/output/NativeOpenCodeDeliveryStatusQuery';
import { createNativeOpenCodeLedgerTransitions } from '../adapters/output/NativeOpenCodeLedgerTransitions';
import { createNativeOpenCodeMemberIdentity } from '../adapters/output/NativeOpenCodeMemberIdentity';
import { createNativeOpenCodeMemberInboxRelay } from '../adapters/output/NativeOpenCodeMemberInboxRelay';
import { createNativeOpenCodeVisibleReplyProof } from '../adapters/output/NativeOpenCodeVisibleReplyProof';

import type { NativeOpenCodeMemberDeliveryPort } from '../adapters/input/NativeTeamMessagingApi';
import type { OpenCodeMemberMessageDeliveryInput } from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodeMemberInboxDelivery } from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodePromptDeliveryLedgerRecord } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import type { RelayInboxMessage } from '@main/services/team/provisioning/TeamProvisioningInboxRelayPolicy';
import type { OpenCodeInboxAttachmentPayloadsResult } from '@main/services/team/provisioning/TeamProvisioningOpenCodeAttachmentPayloads';
import type { TeamRuntimeMemberLaunchEvidence } from '@main/services/team/runtime';
import type {
  InboxMessage,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
  TeamConfig,
  TeamMember,
  TeamTask,
} from '@shared/types';

/**
 * The one thing the app root has to hand to the native messaging surface for
 * OpenCode delivery: how to relay a member's inbox, and what happened to a
 * delivery it already made.
 *
 * Everything that is a question about stored state — identity, lane, run, ledger
 * and reply proof — the native owner answers itself from the team directory. What
 * it cannot answer is what only a running lane can: accepting a prompt, being
 * woken later, and being started again after it died. Those arrive as ports, so
 * the root switch supplies a runtime rather than a second copy of the ledger.
 */
export interface NativeOpenCodeMemberDeliveryPortDependencies {
  teamsBasePath: string;
  readConfig(teamName: string): Promise<TeamConfig | null>;
  readTeamMeta?(teamName: string): Promise<{
    launchIdentity?: {
      providerId?: unknown;
      selectedModel?: unknown;
      resolvedLaunchModel?: unknown;
    } | null;
    providerId?: unknown;
    model?: unknown;
    cwd?: unknown;
  } | null>;
  readSecondaryRuntimeRuns?(
    teamName: string
  ): Promise<readonly { laneId: string; memberName: string; cwd?: string }[]>;
  getCurrentOpenCodeRuntimeRunId?(teamName: string, laneId: string): string | null;
  readInbox(teamName: string, inboxName: string): Promise<readonly unknown[]>;
  readTasks(teamName: string): Promise<readonly TeamTask[]>;

  deliverOpenCodeMemberMessage(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery>;
  scheduleOpenCodeMemberInboxDeliveryWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs: number;
    isCurrent?: () => boolean;
  }): void;
  resolveOpenCodeInboxAttachmentPayloads(input: {
    teamName: string;
    message: RelayInboxMessage;
  }): Promise<OpenCodeInboxAttachmentPayloadsResult>;

  logPromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  emitRuntimeDeliveryReplyAdvisoryRefresh(teamName: string, message: InboxMessage): void;
  suppressRuntimeInactiveWarning(teamName: string): boolean;
  hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;

  canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean;
  canAttemptCommittedOpenCodeSessionRecovery(teamName: string): boolean;
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName: string): void;
  tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    persistedMember: PersistedTeamLaunchMemberState;
  }): Promise<TeamRuntimeMemberLaunchEvidence | null>;
  tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<TeamRuntimeMemberLaunchEvidence | null>;

  logger: { info(message: string): void; warn(message: string): void };
  now(): string;
  getErrorMessage(error: unknown): string;
}

export function createNativeOpenCodeMemberDeliveryPort(
  deps: NativeOpenCodeMemberDeliveryPortDependencies
): NativeOpenCodeMemberDeliveryPort {
  const identity = createNativeOpenCodeMemberIdentity({
    teamsBasePath: deps.teamsBasePath,
    readConfig: deps.readConfig,
    ...(deps.readTeamMeta ? { readTeamMeta: deps.readTeamMeta } : {}),
    ...(deps.readSecondaryRuntimeRuns
      ? { readSecondaryRuntimeRuns: deps.readSecondaryRuntimeRuns }
      : {}),
    ...(deps.getCurrentOpenCodeRuntimeRunId
      ? { getCurrentOpenCodeRuntimeRunId: deps.getCurrentOpenCodeRuntimeRunId }
      : {}),
  });
  const ledgerTransitions = createNativeOpenCodeLedgerTransitions({
    logging: {
      info: (message, context) => deps.logger.info(context ? `${message} ${context}` : message),
      logPromptDeliveryEvent: (event, record, extra) =>
        deps.logPromptDeliveryEvent(event, record, extra),
    },
    nowIso: () => deps.now(),
  });
  const visibleReplyProof = createNativeOpenCodeVisibleReplyProof({
    readConfig: deps.readConfig,
    emitRuntimeDeliveryReplyAdvisoryRefresh: deps.emitRuntimeDeliveryReplyAdvisoryRefresh,
    warn: deps.logger.warn,
    getErrorMessage: deps.getErrorMessage,
    nowIso: () => deps.now(),
  });
  const readCommitPolicy = createNativeOpenCodeDeliveryReadCommitPolicy({
    hasAcceptedMemberWorkSyncReport: deps.hasAcceptedMemberWorkSyncReport,
  });
  const relay = createNativeOpenCodeMemberInboxRelay({
    teamsBasePath: deps.teamsBasePath,
    identity,
    ledgerTransitions,
    visibleReplyProof,
    readCommitPolicy,
    deliverOpenCodeMemberMessage: deps.deliverOpenCodeMemberMessage,
    scheduleOpenCodeMemberInboxDeliveryWake: deps.scheduleOpenCodeMemberInboxDeliveryWake,
    resolveOpenCodeInboxAttachmentPayloads: deps.resolveOpenCodeInboxAttachmentPayloads,
    readTaskRefInferenceTasks: deps.readTasks,
    logOpenCodePromptDeliveryEvent: deps.logPromptDeliveryEvent,
    suppressRuntimeInactiveWarning: deps.suppressRuntimeInactiveWarning,
    logWarning: deps.logger.warn,
    nowIso: () => deps.now(),
    getErrorMessage: deps.getErrorMessage,
  });
  const statusQuery = createNativeOpenCodeDeliveryStatusQuery({
    teamsBasePath: deps.teamsBasePath,
    readInbox: deps.readInbox,
    readTasks: deps.readTasks,
    readConfig: deps.readConfig,
  });

  return {
    relayOpenCodeMemberInboxMessages: (teamName, memberName, options) =>
      relay.relayOpenCodeMemberInboxMessages(teamName, memberName, options),
    getOpenCodeRuntimeDeliveryStatus: (teamName, messageId) =>
      statusQuery.getOpenCodeRuntimeDeliveryStatus(teamName, messageId),
  };
}
