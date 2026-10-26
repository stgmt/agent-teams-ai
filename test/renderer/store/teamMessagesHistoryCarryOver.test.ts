import { carryOverLoadedPages } from '@renderer/store/team/teamMessagesHistoryCarryOver';
import { describe, expect, it } from 'vitest';

import type { TeamMessagesLoadedPage } from '@renderer/store/team/teamMessagesCache';
import type { InboxMessage } from '@shared/types';

function at(id: string, seconds: number): InboxMessage {
  return {
    from: 'alice',
    to: 'user',
    text: id,
    read: true,
    timestamp: new Date(seconds * 1000).toISOString(),
    messageId: id,
  };
}

const scope = { contextId: 'ctx', contextEpoch: 1, teamStateEpoch: 1 };
const olderPage: TeamMessagesLoadedPage = {
  messages: [at('m2', 2), at('m1', 1)],
  inputCursor: 'old-head-cursor',
  outputCursor: null,
  hasMore: false,
  sourceRevision: 'rev-1',
  requestScope: scope,
};

describe('carryOverLoadedPages', () => {
  it('moves rows that slid out of the head into a new older page', () => {
    const pages = carryOverLoadedPages({
      previousHead: [at('m4', 4), at('m3', 3)],
      previousPages: [olderPage],
      head: { messages: [at('m5', 5), at('m4', 4)], nextCursor: 'new-head-cursor', hasMore: true },
      feedRevision: 'rev-2',
    });
    expect(pages?.map((page) => page.messages.map((message) => message.messageId))).toEqual([
      ['m3'],
      ['m2', 'm1'],
    ]);
    expect(pages?.[0]).toMatchObject({
      inputCursor: 'new-head-cursor',
      outputCursor: 'old-head-cursor',
    });
    expect(pages?.every((page) => page.sourceRevision === 'rev-2')).toBe(true);
  });

  it('does not bring back a head row the new head replaced', () => {
    const pages = carryOverLoadedPages({
      previousHead: [at('live-copy', 5), at('m4', 4), at('m3', 3)],
      previousPages: [olderPage],
      head: {
        messages: [at('durable-copy', 5), at('m4', 4)],
        nextCursor: 'new-head-cursor',
        hasMore: true,
      },
      feedRevision: 'rev-2',
    });
    expect(pages?.flatMap((page) => page.messages.map((message) => message.messageId))).toEqual([
      'm3',
      'm2',
      'm1',
    ]);
  });

  it('gives up when the new head no longer overlaps the old one', () => {
    expect(
      carryOverLoadedPages({
        previousHead: [at('m4', 4), at('m3', 3)],
        previousPages: [olderPage],
        head: { messages: [at('m6', 6), at('m5', 5)], nextCursor: 'c', hasMore: true },
        feedRevision: 'rev-2',
      })
    ).toBeNull();
  });
});
