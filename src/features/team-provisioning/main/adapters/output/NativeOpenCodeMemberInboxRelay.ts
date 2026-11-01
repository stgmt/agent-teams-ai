import { createOpenCodePromptDeliveryLedger } from '@main/services/team/provisioning/OpenCodePromptDeliveryQueries';
import { markTeamInboxMessagesReadWithDefaults } from '@main/services/team/provisioning/TeamProvisioningInboxPersistence';
import {
  type OpenCodeMemberInboxRelayOptions,
  type RelayOpenCodeMemberInboxMessagesPorts,
  relayOpenCodeMemberInboxMessagesWithPorts,
} from '@main/services/team/provisioning/TeamProvisioningOpenCodeMemberInboxRelay';
import { TeamInboxReader } from '@main/services/team/TeamInboxReader';

import type { NativeOpenCodeDeliveryReadCommitPolicy } from './NativeOpenCodeDeliveryReadCommit';
import type { NativeOpenCodeLedgerTransitions } from './NativeOpenCodeLedgerTransitions';
import type { NativeOpenCodeMemberIdentity } from './NativeOpenCodeMemberIdentity';
import type { NativeOpenCodeVisibleReplyProof } from './NativeOpenCodeVisibleReplyProof';
import type {
  OpenCodeMemberInboxDelivery,
  OpenCodeMemberMessageDeliveryInput,
} from '@main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodePromptDeliveryLedgerRecord } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import type { RelayInboxMessage } from '@main/services/team/provisioning/TeamProvisioningInboxRelayPolicy';
import type { OpenCodeInboxAttachmentPayloadsResult } from '@main/services/team/provisioning/TeamProvisioningOpenCodeAttachmentPayloads';
import type { OpenCodeMemberInboxRelayResult } from '@main/services/team/provisioning/TeamProvisioningOpenCodeMemberInboxRelayResults';
import type { InboxMessage, TeamTask } from '@shared/types';

/**
 * Passing a member's unread inbox rows to their lane.
 *
 * The relay itself is a fixed policy — pick the unread rows that belong to an
 * OpenCode member, deliver them in order, and only then mark them read. What it
 * needs is a set of questions about state: who the member is, which lane they
 * live on, what the ledger says, and whether an answer appeared. The native owner
 * answers those from its own stores; the two things it cannot answer are the
 * runtime send and the watchdog wake, which belong to the running lane and are
 * supplied as ports.
 */
export interface NativeOpenCodeMemberInboxRelayDependencies {
  teamsBasePath: string;
  identity: NativeOpenCodeMemberIdentity;
  ledgerTransitions: NativeOpenCodeLedgerTransitions;
  visibleReplyProof: NativeOpenCodeVisibleReplyProof;
  readCommitPolicy: NativeOpenCodeDeliveryReadCommitPolicy;
  /** The runtime accepts (or refuses) one prompt on one lane. */
  deliverOpenCodeMemberMessage(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery>;
  /** Arms the watchdog that later proves or retries this prompt. */
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
  readTaskRefInferenceTasks(teamName: string): Promise<readonly TeamTask[]>;
  logOpenCodePromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra?: Record<string, unknown>
  ): void;
  suppressRuntimeInactiveWarning(teamName: string): boolean;
  logWarning(message: string): void;
  nowIso(): string;
  getErrorMessage(error: unknown): string;
}

export interface NativeOpenCodeMemberInboxRelay {
  relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options?: OpenCodeMemberInboxRelayOptions
  ): Promise<OpenCodeMemberInboxRelayResult>;
}

export function createNativeOpenCodeMemberInboxRelay(
  deps: NativeOpenCodeMemberInboxRelayDependencies
): NativeOpenCodeMemberInboxRelay {
  const inboxReader = new TeamInboxReader();
  const inFlight = new Map<string, Promise<OpenCodeMemberInboxRelayResult>>();

  const ports: RelayOpenCodeMemberInboxMessagesPorts = {
    inFlight,
    readInboxMessages: (teamName, memberName) =>
      inboxReader.getMessagesFor(teamName, memberName) as Promise<readonly InboxMessage[]>,
    scheduleOpenCodeMemberInboxDeliveryWake: (input) =>
      deps.scheduleOpenCodeMemberInboxDeliveryWake(input),
    isOpenCodeRuntimeRecipient: (teamName, memberName) =>
      deps.identity.isOpenCodeRuntimeRecipient(teamName, memberName),
    resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
      deps.identity.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName),
    createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
      createOpenCodePromptDeliveryLedger(teamName, laneId, {
        teamsBasePath: deps.teamsBasePath,
      }),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: (input) =>
      deps.ledgerTransitions.requeueRuntimeManifestWatermarkDeliveryIfNeeded(input),
    requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded: (input) =>
      deps.ledgerTransitions.requeueNoAssistantTerminalDeliveryIfNeeded(input),
    applyDestinationProof: (input) => deps.visibleReplyProof.applyDestinationProof(input),
    isOpenCodeDeliveryResponseReadCommitAllowed: (input) =>
      deps.readCommitPolicy.isOpenCodeDeliveryResponseReadCommitAllowed(input),
    markInboxMessagesRead: (teamName, memberName, messages) =>
      markTeamInboxMessagesReadWithDefaults({
        teamName,
        member: memberName,
        messages,
        teamsBasePath: deps.teamsBasePath,
      }),
    logOpenCodePromptDeliveryEvent: (event, record, extra) =>
      deps.logOpenCodePromptDeliveryEvent(event, record, extra),
    readTaskRefInferenceTasks: (teamName) => deps.readTaskRefInferenceTasks(teamName),
    resolveOpenCodeInboxAttachmentPayloads: (input) =>
      deps.resolveOpenCodeInboxAttachmentPayloads(input),
    resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      deps.identity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
    markOpenCodePromptLedgerFailedTerminal: (input) =>
      deps.ledgerTransitions.markLedgerFailedTerminal(input),
    deliverOpenCodeMemberMessage: (teamName, input) =>
      deps.deliverOpenCodeMemberMessage(teamName, input),
    suppressRuntimeInactiveWarning: (teamName) => deps.suppressRuntimeInactiveWarning(teamName),
    logWarning: (message) => deps.logWarning(message),
    nowIso: () => deps.nowIso(),
    getErrorMessage: (error) => deps.getErrorMessage(error),
  };

  return {
    relayOpenCodeMemberInboxMessages: (teamName, memberName, options) =>
      relayOpenCodeMemberInboxMessagesWithPorts(
        { teamName, memberName, relayKey: `${teamName}:${memberName}`, ...(options ? { options } : {}) },
        ports
      ),
  };
}
