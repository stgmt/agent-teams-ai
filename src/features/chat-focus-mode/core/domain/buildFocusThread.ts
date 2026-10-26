import {
  isLeadConversationParticipant,
  normalizeConversationParticipant,
} from '@features/team-direct-chats';
import { getUserReplyRequestIds } from '@shared/utils/userReplyLink';

import {
  classifyFocusMessage,
  type FocusClassificationContext,
  type FocusMessageRole,
} from './classifyFocusMessage';

import type { InboxMessage } from '@shared/types';

export type FocusRequestStatus = 'answered' | 'pending';

export type FocusItem =
  | {
      kind: 'pair';
      request: InboxMessage;
      replies: InboxMessage[];
      status: FocusRequestStatus;
    }
  /** A reply no request asked for, e.g. a task report. */
  | { kind: 'unsolicited-reply'; reply: InboxMessage }
  /** Hidden service messages between two visible items. */
  | { kind: 'service-gap'; messages: InboxMessage[] };

export type FocusPairItem = Extract<FocusItem, { kind: 'pair' }>;

/** Two copies of one reply (inbox row + captured SendMessage) land within this window. */
const DUPLICATE_REPLY_WINDOW_MS = 10_000;

function toTime(message: InboxMessage): number {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : 0;
}

function sortChronologically(messages: readonly InboxMessage[]): InboxMessage[] {
  return messages
    .map((message, index) => ({ message, index, time: toTime(message) }))
    .sort((left, right) => left.time - right.time || left.index - right.index)
    .map((entry) => entry.message);
}

function replyFingerprint(message: InboxMessage): string {
  const text = (message.text ?? '').replace(/\s+/g, ' ').trim();
  return `${normalizeConversationParticipant(message.from)}\0${text}`;
}

function sameRequestLinks(left: InboxMessage, right: InboxMessage): boolean {
  const leftIds = getUserReplyRequestIds(left);
  const rightIds = getUserReplyRequestIds(right);
  if (leftIds.length === 0 || rightIds.length === 0) return true;
  return leftIds.length === rightIds.length && leftIds.every((id) => rightIds.includes(id));
}

function isLinkedReply(message: InboxMessage): boolean {
  return getUserReplyRequestIds(message).length > 0 || message.replyChannel !== undefined;
}

interface ClassifiedMessage {
  message: InboxMessage;
  role: FocusMessageRole;
}

/**
 * The lead's SendMessage to "user" is stored twice: as a row in the user's inbox and as the
 * captured copy main links to the request. Keeps one copy per reply, preferring the linked one.
 * Equal replies linked to different requests are separate answers and both stay.
 */
function dropDuplicateReplies(entries: readonly ClassifiedMessage[]): ClassifiedMessage[] {
  const dropped = new Set<ClassifiedMessage>();
  const latest = new Map<string, ClassifiedMessage>();
  for (const entry of entries) {
    if (entry.role !== 'reply') continue;
    const fingerprint = replyFingerprint(entry.message);
    const previous = latest.get(fingerprint);
    if (
      previous &&
      toTime(entry.message) - toTime(previous.message) <= DUPLICATE_REPLY_WINDOW_MS &&
      sameRequestLinks(previous.message, entry.message)
    ) {
      const keepNew = isLinkedReply(entry.message) && !isLinkedReply(previous.message);
      dropped.add(keepNew ? previous : entry);
      if (!keepNew) continue;
    }
    latest.set(fingerprint, entry);
  }
  return dropped.size === 0 ? [...entries] : entries.filter((entry) => !dropped.has(entry));
}

function isSameCounterpart(
  request: InboxMessage,
  reply: InboxMessage,
  context: FocusClassificationContext
): boolean {
  if (context.scope.kind !== 'team-feed') return true;
  const target = normalizeConversationParticipant(request.to);
  const speaker = normalizeConversationParticipant(reply.from);
  if (!target || target === speaker) return true;
  return (
    isLeadConversationParticipant(target, context.leadNames) &&
    isLeadConversationParticipant(speaker, context.leadNames)
  );
}

function findLinkedPair(
  reply: InboxMessage,
  pairsById: ReadonlyMap<string, FocusPairItem>
): FocusPairItem | null {
  for (const requestId of getUserReplyRequestIds(reply)) {
    const pair = pairsById.get(requestId);
    if (pair) return pair;
  }
  return null;
}

/**
 * Falls back to time: the latest earlier request to the same counterpart. A reply that went
 * through the reply channel (`replyChannel` set) but names no request is unsolicited when that
 * request is already answered; legacy and teammate replies keep joining it.
 */
function findPairByTime(
  reply: InboxMessage,
  pairs: readonly FocusPairItem[],
  context: FocusClassificationContext
): FocusPairItem | null {
  for (let index = pairs.length - 1; index >= 0; index -= 1) {
    const pair = pairs[index];
    if (!isSameCounterpart(pair.request, reply, context)) continue;
    if (pair.replies.length === 0 || reply.replyChannel === undefined) return pair;
    return null;
  }
  return null;
}

/**
 * Groups a conversation into request → reply cards for focus mode.
 * Input is the conversation's messages in any order; output is chronological.
 */
export function buildFocusThread(
  messages: readonly InboxMessage[],
  context: FocusClassificationContext
): FocusItem[] {
  const items: FocusItem[] = [];
  const pairs: FocusPairItem[] = [];
  const pairsById = new Map<string, FocusPairItem>();

  const classified = sortChronologically(messages).map((message) => ({
    message,
    role: classifyFocusMessage(message, context),
  }));
  for (const { message, role } of dropDuplicateReplies(classified)) {
    if (role === 'request') {
      const pair: FocusPairItem = {
        kind: 'pair',
        request: message,
        replies: [],
        status: 'pending',
      };
      items.push(pair);
      pairs.push(pair);
      if (message.messageId) pairsById.set(message.messageId, pair);
      continue;
    }
    if (role === 'reply') {
      const pair = findLinkedPair(message, pairsById) ?? findPairByTime(message, pairs, context);
      if (pair) {
        pair.replies.push(message);
        pair.status = 'answered';
      } else {
        items.push({ kind: 'unsolicited-reply', reply: message });
      }
      continue;
    }
    const last = items.at(-1);
    if (last?.kind === 'service-gap') {
      last.messages.push(message);
    } else {
      items.push({ kind: 'service-gap', messages: [message] });
    }
  }
  return items;
}

export interface FocusThreadSummary {
  pendingCount: number;
  /** Earliest request still waiting for a reply. */
  earliestPendingRequest: InboxMessage | null;
}

export function summarizeFocusThread(items: readonly FocusItem[]): FocusThreadSummary {
  let pendingCount = 0;
  let earliestPendingRequest: InboxMessage | null = null;
  for (const item of items) {
    if (item.kind !== 'pair' || item.status !== 'pending') continue;
    pendingCount += 1;
    earliestPendingRequest ??= item.request;
  }
  return { pendingCount, earliestPendingRequest };
}

/** Request messageId → its replies, for the "↳ reply" link in the normal view. */
export function buildFocusReplyIndex(items: readonly FocusItem[]): Map<string, InboxMessage[]> {
  const index = new Map<string, InboxMessage[]>();
  for (const item of items) {
    if (item.kind === 'pair' && item.request.messageId && item.replies.length > 0) {
      index.set(item.request.messageId, item.replies);
    }
  }
  return index;
}

/** Whether the thread already shows a request; focus mode loads older history until it does. */
export function hasFocusRequest(items: readonly FocusItem[]): boolean {
  return items.some((item) => item.kind === 'pair');
}

/** Fallback replies duplicate a lead thought, so only focus mode shows them. */
export function isFocusOnlyMessage(message: InboxMessage): boolean {
  return message.focusOnly === true;
}
