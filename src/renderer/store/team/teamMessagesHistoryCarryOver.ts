import { toMessageKey } from '@renderer/utils/teamMessageKey';

import type { TeamMessagesLoadedPage } from './teamMessagesCache';
import type { InboxMessage } from '@shared/types';

function toTimeMs(message: InboxMessage): number {
  const time = Date.parse(message.timestamp);
  return Number.isFinite(time) ? time : Number.NaN;
}

/**
 * Keeps explicitly loaded older pages across a head refresh whose feed revision changed.
 *
 * Busy teams change the feed with every new message, so dropping loaded history on any
 * revision change would throw it away every few seconds. History stays only when the new head
 * overlaps the previous head: then the messages that slid out of the head are still loaded and
 * become the newest older page, so no message between the new head and the old pages is left
 * unseen. Without overlap (more new messages than the head holds) a gap is possible and the
 * caller must ask for an explicit reload.
 *
 * Older messages rewritten in place are not detected; they refresh on the next full reload.
 */
export function carryOverLoadedPages(input: {
  previousHead: readonly InboxMessage[];
  previousPages: readonly TeamMessagesLoadedPage[];
  head: { messages: readonly InboxMessage[]; nextCursor: string | null; hasMore: boolean };
  feedRevision: string;
}): TeamMessagesLoadedPage[] | null {
  const { previousHead, previousPages, head } = input;
  if (previousPages.length === 0 || !head.hasMore || !head.nextCursor) return null;
  const headKeys = new Set(head.messages.map(toMessageKey));
  if (!previousHead.some((message) => headKeys.has(toMessageKey(message)))) return null;

  const headTimes = head.messages.map(toTimeMs).filter((time) => !Number.isNaN(time));
  if (headTimes.length === 0) return null;
  const oldestHeadMs = Math.min(...headTimes);
  // Old head rows newer than the new head's tail but missing from it were replaced (e.g. a live
  // lead overlay became durable) and must not come back.
  const slidOut = previousHead.filter(
    (message) => !headKeys.has(toMessageKey(message)) && toTimeMs(message) <= oldestHeadMs
  );

  const [newestPage] = previousPages;
  const relabeled = previousPages.map((page) => ({
    ...page,
    sourceRevision: input.feedRevision,
  }));
  if (slidOut.length === 0) {
    return [{ ...relabeled[0], inputCursor: head.nextCursor }, ...relabeled.slice(1)];
  }
  return [
    {
      messages: slidOut,
      inputCursor: head.nextCursor,
      outputCursor: newestPage.inputCursor,
      hasMore: true,
      sourceRevision: input.feedRevision,
      requestScope: newestPage.requestScope,
    },
    ...relabeled,
  ];
}
