import {
  type ConversationScope,
  isAddressedToUser,
  isLeadConversationParticipant,
  isOutboundUserMessage,
  normalizeConversationParticipant,
} from '@features/team-direct-chats';
import { isInboxNoiseMessage, isThoughtProtocolNoise } from '@shared/utils/inboxNoise';
import { isLeadThoughtSourceMessage } from '@shared/utils/leadDetection';
import {
  isTeamInternalControlMessageEnvelope,
  isTeamInternalControlMessageText,
} from '@shared/utils/teamInternalControlMessages';

import type { InboxMessage } from '@shared/types';

/** Role of a conversation message in focus mode. */
export type FocusMessageRole = 'request' | 'reply' | 'service';

export interface FocusClassificationContext {
  scope: ConversationScope;
  leadNames: Iterable<string>;
}

function isProtocolNoise(message: InboxMessage): boolean {
  const text = message.text ?? '';
  return (
    isInboxNoiseMessage(text) ||
    isThoughtProtocolNoise(text) ||
    isTeamInternalControlMessageText(text) ||
    isTeamInternalControlMessageEnvelope(message)
  );
}

function isReplyKind(message: InboxMessage): boolean {
  return message.messageKind === undefined || message.messageKind === 'default';
}

function isConversationSpeaker(
  message: InboxMessage,
  scope: ConversationScope,
  leadNames: Iterable<string>
): boolean {
  if (scope.kind !== 'direct') return true;
  const participant = normalizeConversationParticipant(scope.participant);
  const from = normalizeConversationParticipant(message.from);
  if (from === participant) return true;
  return (
    isLeadConversationParticipant(participant, leadNames) &&
    isLeadConversationParticipant(from, leadNames)
  );
}

function isGroupReply(message: InboxMessage): boolean {
  return (
    Boolean(message.groupChatId) && normalizeConversationParticipant(message.from) !== 'system'
  );
}

/**
 * Classifies a message that already belongs to the conversation (see `belongsToConversation`).
 * Requests are the user's own messages, replies are what the chat's counterpart said to the
 * user, everything else (lead thoughts, team traffic, system rows, nudges) is service.
 */
export function classifyFocusMessage(
  message: InboxMessage,
  context: FocusClassificationContext
): FocusMessageRole {
  if (isOutboundUserMessage(message)) {
    return message.messageKind === 'slash_command' || isProtocolNoise(message)
      ? 'service'
      : 'request';
  }
  if (isLeadThoughtSourceMessage(message)) return 'service';
  if (!isReplyKind(message) || isProtocolNoise(message)) return 'service';
  const addressed =
    context.scope.kind === 'group' ? isGroupReply(message) : isAddressedToUser(message);
  if (!addressed) return 'service';
  return isConversationSpeaker(message, context.scope, context.leadNames) ? 'reply' : 'service';
}
