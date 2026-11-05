import { OpenCodeVisibleReplyProofService } from '@main/services/team/opencode/delivery/OpenCodeVisibleReplyProofService';
import { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { isLeadMember } from '@shared/utils/leadDetection';

import type { OpenCodeGroupAcknowledgementReader } from '@main/services/team/opencode/delivery/OpenCodeGroupAcknowledgement';
import type { OpenCodeGroupReplySender } from '@main/services/team/opencode/delivery/OpenCodeGroupVisibleReply';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import type { OpenCodeVisibleReplyProof } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog';
import type { InboxMessage, TeamConfig } from '@shared/types';

/**
 * Proof that a delivered prompt actually produced a visible reply.
 *
 * A prompt counts as answered only when the recipient's inbox holds a row that
 * points back at the delivered message — the ledger alone cannot prove it, and
 * the runtime's own "accepted" flag cannot either. That proof is a pure read of
 * the inbox plus two derived writes (correlating the reply and merging task
 * refs), so the native owner performs it over the inbox stores it already
 * reads, and the ledger records the correlation it found.
 */
export interface NativeOpenCodeVisibleReplyProofDependencies {
  readConfig(teamName: string): Promise<TeamConfig | null>;
  /** Advisory state changed because a reply appeared; the UI re-reads it. */
  emitRuntimeDeliveryReplyAdvisoryRefresh(teamName: string, message: InboxMessage): void;
  warn(message: string): void;
  getErrorMessage(error: unknown): string;
  hasAcknowledgedInbound?: OpenCodeGroupAcknowledgementReader;
  sendGroupChatReply?: OpenCodeGroupReplySender;
  nowIso?(): string;
}

export interface NativeOpenCodeVisibleReplyProof {
  /** The reply a relayed prompt produced, found by the message it relays. */
  findByRelayOfMessageId(input: Parameters<
    OpenCodeVisibleReplyProofService['findByRelayOfMessageId']
  >[0]): ReturnType<OpenCodeVisibleReplyProofService['findByRelayOfMessageId']>;
  applyDestinationProof(input: {
    checkpoint?: () => void | Promise<void>;
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    replyRecipient?: string | null;
    memberName: string;
  }): Promise<{
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof | null;
  }>;
  /**
   * Turns a recorded reply into the row the recipient actually sees, when the
   * ledger proves the member answered but nothing was written to the inbox yet.
   */
  materializePlainTextReplyIfNeeded(input: {
    checkpoint?: () => void | Promise<void>;
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    memberName: string;
    visibleReply?: OpenCodeVisibleReplyProof | null;
  }): Promise<{
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof | null;
  }>;
}

export function createNativeOpenCodeVisibleReplyProof(
  deps: NativeOpenCodeVisibleReplyProofDependencies
): NativeOpenCodeVisibleReplyProof {
  const service = new OpenCodeVisibleReplyProofService({
    inboxReader: new TeamInboxReader(),
    inboxWriter: new TeamInboxWriter(),
    getConfiguredLeadName: (teamName) =>
      deps
        .readConfig(teamName)
        .then(
          (config) => config?.members?.find((member) => isLeadMember(member))?.name?.trim() || null
        )
        .catch(() => null),
    emitRuntimeDeliveryReplyAdvisoryRefresh: deps.emitRuntimeDeliveryReplyAdvisoryRefresh,
    warn: deps.warn,
    getErrorMessage: deps.getErrorMessage,
    ...(deps.nowIso ? { nowIso: deps.nowIso } : {}),
    ...(deps.hasAcknowledgedInbound ? { hasAcknowledgedInbound: deps.hasAcknowledgedInbound } : {}),
    ...(deps.sendGroupChatReply ? { sendGroupChatReply: deps.sendGroupChatReply } : {}),
  });

  return {
    findByRelayOfMessageId: (input) => service.findByRelayOfMessageId(input),
    applyDestinationProof: (input) => service.applyDestinationProof(input),
    materializePlainTextReplyIfNeeded: (input) => service.materializePlainTextReplyIfNeeded(input),
  };
}
