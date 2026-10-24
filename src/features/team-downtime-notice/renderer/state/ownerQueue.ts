import { countQueuedUserMessages } from '@renderer/components/team/messages/messagesPanelLogic';

import type { InboxMessage } from '@shared/types';

/** Owner messages not yet delivered, across all recipients; same definition as the per-member queue. */
export function countOwnerQueuedMessages(messages: readonly InboxMessage[]): number {
  const recipients = new Set<string>();
  for (const message of messages) {
    if (message.read === false && message.to) recipients.add(message.to);
  }
  let total = 0;
  for (const recipient of recipients) total += countQueuedUserMessages(messages, recipient);
  return total;
}
