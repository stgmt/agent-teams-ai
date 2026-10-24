import { noteOwnerMessageSent } from '@features/team-downtime-notice/renderer';
import { shouldClearPendingReplyForOpenCodeRuntimeDelivery } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';

import type { SendMessageRequest, SendMessageResult } from '@shared/types';

export interface SendOwnerMessageDeps {
  readonly sendTeamMessage: (
    teamName: string,
    request: SendMessageRequest
  ) => Promise<SendMessageResult>;
  readonly onPendingReplyChange: (
    updater: (previous: Record<string, number>) => Record<string, number>
  ) => void;
}

/** Sends the owner's message to a member, tracking the pending reply and any downtime notice. */
export async function sendOwnerMessage(
  teamName: string,
  request: SendMessageRequest,
  { sendTeamMessage, onPendingReplyChange }: SendOwnerMessageDeps
): Promise<SendMessageResult> {
  const member = request.member;
  const sentAtMs = Date.now();
  const clearPendingReply = (previous: Record<string, number>): Record<string, number> => {
    if (previous[member] !== sentAtMs) return previous;
    const next = { ...previous };
    delete next[member];
    return next;
  };
  onPendingReplyChange((previous) => ({ ...previous, [member]: sentAtMs }));
  try {
    const result = await sendTeamMessage(teamName, request);
    if (shouldClearPendingReplyForOpenCodeRuntimeDelivery(result.runtimeDelivery)) {
      onPendingReplyChange(clearPendingReply);
    }
    noteOwnerMessageSent(teamName);
    return result;
  } catch (error) {
    onPendingReplyChange(clearPendingReply);
    throw error;
  }
}
