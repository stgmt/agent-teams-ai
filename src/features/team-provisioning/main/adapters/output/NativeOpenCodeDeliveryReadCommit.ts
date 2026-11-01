import {
  getOpenCodeDeliveryPendingReason,
  isOpenCodeDeliveryResponseReadCommitAllowed as decideReadCommitAllowed,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryReadCommitPolicy';
import { openCodeTaskRefsIncludeAll } from '@main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofMatching';

import type { OpenCodeDeliveryResponseState } from '@main/services/team/opencode/bridge/OpenCodeBridgeCommandContract';
import type { OpenCodeGroupAcknowledgementReader } from '@main/services/team/opencode/delivery/OpenCodeGroupAcknowledgement';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import type { OpenCodeVisibleReplyProof } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog';
import type { AgentActionMode, TaskRef } from '@shared/types/team';

/**
 * Whether a delivered prompt's answer may be marked read, and why it is not.
 *
 * Marking an inbox row read is the moment the app declares the work done, so it
 * waits for one of three proofs: a visible reply that satisfies the delivery's
 * own requirements, an explicit acknowledgement in a group chat, or a work-sync
 * report the board accepted. The policy is a pure decision over those proofs;
 * only the work-sync one is a board lookup, which is supplied as a port.
 */
export interface NativeOpenCodeDeliveryReadCommitDependencies {
  hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  hasAcknowledgedInbound?: OpenCodeGroupAcknowledgementReader;
}

export interface OpenCodeDeliveryReadCommitInput {
  teamName?: string;
  memberName?: string;
  responseState?: OpenCodeDeliveryResponseState;
  actionMode?: AgentActionMode;
  taskRefs?: TaskRef[];
  visibleReply?: OpenCodeVisibleReplyProof | null;
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
}

export interface NativeOpenCodeDeliveryReadCommitPolicy {
  isOpenCodeDeliveryResponseReadCommitAllowed(
    input: OpenCodeDeliveryReadCommitInput
  ): Promise<boolean>;
  getOpenCodeDeliveryPendingReason(
    input: Omit<OpenCodeDeliveryReadCommitInput, 'teamName' | 'memberName'>
  ): string;
}

export function createNativeOpenCodeDeliveryReadCommitPolicy(
  deps: NativeOpenCodeDeliveryReadCommitDependencies
): NativeOpenCodeDeliveryReadCommitPolicy {
  return {
    async isOpenCodeDeliveryResponseReadCommitAllowed(input) {
      const teamName = input.teamName?.trim();
      const memberName = input.memberName?.trim();
      if (!teamName || !memberName) {
        // A work-sync report is proven per member; without both names there is
        // no member to prove anything about, so that proof is simply absent.
        return decideReadCommitAllowed({
          ...input,
          hasAcceptedMemberWorkSyncReport: async () => false,
          taskRefsIncludeAll: openCodeTaskRefsIncludeAll,
          ...(deps.hasAcknowledgedInbound
            ? { hasAcknowledgedInbound: deps.hasAcknowledgedInbound }
            : {}),
        });
      }
      return decideReadCommitAllowed({
        ...input,
        hasAcceptedMemberWorkSyncReport: deps.hasAcceptedMemberWorkSyncReport,
        taskRefsIncludeAll: openCodeTaskRefsIncludeAll,
        ...(deps.hasAcknowledgedInbound
          ? { hasAcknowledgedInbound: deps.hasAcknowledgedInbound }
          : {}),
      });
    },

    getOpenCodeDeliveryPendingReason(input) {
      return getOpenCodeDeliveryPendingReason({
        ...input,
        taskRefsIncludeAll: openCodeTaskRefsIncludeAll,
      });
    },
  };
}
