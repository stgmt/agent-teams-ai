import {
  buildFocusReplyIndex,
  buildFocusThread,
  type FocusItem,
  hasFocusRequest,
  summarizeFocusThread,
} from '@features/chat-focus-mode/core/domain/buildFocusThread';
import { classifyFocusMessage } from '@features/chat-focus-mode/core/domain/classifyFocusMessage';
import { TEAM_FEED_SCOPE } from '@features/team-direct-chats';
import { describe, expect, it } from 'vitest';

import type { InboxMessage } from '@shared/types';

let seq = 0;
function msg(partial: Partial<InboxMessage> & { from: string }): InboxMessage {
  seq += 1;
  return {
    text: `text ${seq}`,
    timestamp: new Date(Date.UTC(2026, 9, 25, 10, 0, seq)).toISOString(),
    read: true,
    messageId: `m${seq}`,
    ...partial,
  };
}

const leadNames = ['team-lead'];
const leadChat = { scope: { kind: 'direct' as const, participant: 'team-lead' }, leadNames };
const aliceChat = { scope: { kind: 'direct' as const, participant: 'alice' }, leadNames };
const feed = { scope: TEAM_FEED_SCOPE, leadNames };
const group = { scope: { kind: 'group' as const, groupChatId: 'g1' }, leadNames };

function kinds(items: FocusItem[]): string[] {
  return items.map((item) =>
    item.kind === 'pair' ? `pair:${item.status}:${item.replies.length}` : item.kind
  );
}

describe('classifyFocusMessage', () => {
  it('lead chat: user→lead is a request, lead→user a reply, the rest service', () => {
    expect(classifyFocusMessage(msg({ from: 'user', to: 'team-lead' }), leadChat)).toBe('request');
    expect(classifyFocusMessage(msg({ from: 'team-lead', to: 'user' }), leadChat)).toBe('reply');
    const thought = msg({ from: 'team-lead', source: 'lead_process' });
    expect(classifyFocusMessage(thought, leadChat)).toBe('service');
    expect(classifyFocusMessage(msg({ from: 'team-lead', to: 'alice' }), leadChat)).toBe('service');
    expect(classifyFocusMessage(msg({ from: 'alice', to: 'team-lead' }), leadChat)).toBe('service');
    expect(classifyFocusMessage(msg({ from: 'system', to: 'team-lead' }), leadChat)).toBe(
      'service'
    );
    const nudge = msg({ from: 'team-lead', to: 'user', messageKind: 'member_work_sync_nudge' });
    expect(classifyFocusMessage(nudge, leadChat)).toBe('service');
  });

  it('treats a lead fallback reply as a reply even though it comes from the lead process', () => {
    const fallback = msg({
      from: 'team-lead',
      to: 'user',
      source: 'lead_process',
      replyChannel: 'fallback',
      focusOnly: true,
    });
    expect(classifyFocusMessage(fallback, leadChat)).toBe('reply');
  });

  it('teammate chat: lead bootstrap and comment notifications are service', () => {
    expect(classifyFocusMessage(msg({ from: 'user', to: 'alice' }), aliceChat)).toBe('request');
    expect(classifyFocusMessage(msg({ from: 'alice', to: 'user' }), aliceChat)).toBe('reply');
    expect(classifyFocusMessage(msg({ from: 'team-lead', to: 'alice' }), aliceChat)).toBe(
      'service'
    );
    const comment = msg({ from: 'alice', to: 'user', messageKind: 'task_comment_notification' });
    expect(classifyFocusMessage(comment, aliceChat)).toBe('service');
    const noise = msg({ from: 'alice', to: 'user', text: '{"type":"idle_notification"}' });
    expect(classifyFocusMessage(noise, aliceChat)).toBe('service');
  });

  it('team feed: any user message is a request and anything to user a reply', () => {
    expect(classifyFocusMessage(msg({ from: 'user', to: 'bob' }), feed)).toBe('request');
    expect(classifyFocusMessage(msg({ from: 'bob', to: 'user' }), feed)).toBe('reply');
    expect(classifyFocusMessage(msg({ from: 'bob', to: 'alice' }), feed)).toBe('service');
  });

  it('slash commands are service', () => {
    const slash = msg({
      from: 'user',
      to: 'team-lead',
      text: '/compact',
      messageKind: 'slash_command',
    });
    expect(classifyFocusMessage(slash, leadChat)).toBe('service');
  });

  it('group: user messages are requests, participant messages replies, system service', () => {
    const base = { groupChatId: 'g1' };
    expect(classifyFocusMessage(msg({ ...base, from: 'user', to: 'alice' }), group)).toBe(
      'request'
    );
    expect(classifyFocusMessage(msg({ ...base, from: 'alice', to: 'bob' }), group)).toBe('reply');
    expect(classifyFocusMessage(msg({ ...base, from: 'system', to: 'user' }), group)).toBe(
      'service'
    );
  });
});

describe('buildFocusThread', () => {
  it('pairs a request with its explicit reply and folds the noise in between', () => {
    const request = msg({ from: 'user', to: 'team-lead', text: 'отчёт для менеджера' });
    const thought = msg({ from: 'team-lead', source: 'lead_process', text: 'ищу транскрибацию' });
    const delegation = msg({ from: 'team-lead', to: 'alice', text: 'найди транскриб' });
    const reply = msg({
      from: 'team-lead',
      to: 'user',
      text: 'вот отчёт',
      replyChannel: 'explicit',
      replyToMessageIds: [request.messageId!],
    });
    const items = buildFocusThread([reply, delegation, thought, request], leadChat);
    expect(kinds(items)).toEqual(['pair:answered:1', 'service-gap']);
    expect(items[1]).toMatchObject({ messages: [thought, delegation] });
  });

  it('keeps a late reply with the early request it names, after a newer request', () => {
    const first = msg({ from: 'user', to: 'team-lead', text: 'первое' });
    const ack = msg({
      from: 'team-lead',
      to: 'user',
      replyChannel: 'explicit',
      replyToMessageIds: [first.messageId!],
    });
    const second = msg({ from: 'user', to: 'team-lead', text: 'второе' });
    const result = msg({
      from: 'team-lead',
      to: 'user',
      replyChannel: 'explicit',
      replyToMessageIds: [first.messageId!],
    });
    const items = buildFocusThread([first, ack, second, result], leadChat);
    expect(kinds(items)).toEqual(['pair:answered:2', 'pair:pending:0']);
    expect(summarizeFocusThread(items)).toEqual({
      pendingCount: 1,
      earliestPendingRequest: second,
    });
  });

  it('links OpenCode runtime-delivery replies via relayOfMessageId', () => {
    const request = msg({ from: 'user', to: 'team-lead' });
    const other = msg({ from: 'user', to: 'team-lead' });
    const reply = msg({
      from: 'team-lead',
      to: 'user',
      source: 'runtime_delivery',
      relayOfMessageId: request.messageId,
    });
    const items = buildFocusThread([request, other, reply], leadChat);
    expect(kinds(items)).toEqual(['pair:answered:1', 'pair:pending:0']);
  });

  it('links legacy history without reply fields by time', () => {
    const request = msg({ from: 'user', to: 'alice' });
    const ack = msg({ from: 'alice', to: 'user', text: 'принял' });
    const done = msg({ from: 'alice', to: 'user', text: 'готово' });
    const items = buildFocusThread([request, ack, done], aliceChat);
    expect(kinds(items)).toEqual(['pair:answered:2']);
  });

  it('shows a channel reply naming no request as unsolicited once the request is answered', () => {
    const request = msg({ from: 'user', to: 'team-lead' });
    const reply = msg({
      from: 'team-lead',
      to: 'user',
      replyChannel: 'explicit',
      replyToMessageIds: [request.messageId!],
    });
    const report = msg({
      from: 'team-lead',
      to: 'user',
      replyChannel: 'explicit',
      text: 'задача 3 готова',
    });
    const items = buildFocusThread([request, reply, report], leadChat);
    expect(kinds(items)).toEqual(['pair:answered:1', 'unsolicited-reply']);
  });

  it('a channel reply without ids still answers a pending request (e.g. after restart)', () => {
    const request = msg({ from: 'user', to: 'team-lead' });
    const reply = msg({ from: 'team-lead', to: 'user', replyChannel: 'explicit' });
    expect(kinds(buildFocusThread([request, reply], leadChat))).toEqual(['pair:answered:1']);
  });

  it('a reply before any request is unsolicited', () => {
    const report = msg({ from: 'alice', to: 'user' });
    expect(kinds(buildFocusThread([report], aliceChat))).toEqual(['unsolicited-reply']);
  });

  it('team feed links by time only to a request to the same counterpart', () => {
    const toBob = msg({ from: 'user', to: 'bob' });
    const toLead = msg({ from: 'user', to: 'lead' });
    const bobReply = msg({ from: 'bob', to: 'user' });
    const leadReply = msg({ from: 'team-lead', to: 'user' });
    const items = buildFocusThread([toBob, toLead, bobReply, leadReply], feed);
    expect(items).toMatchObject([
      { kind: 'pair', request: toBob, replies: [bobReply] },
      { kind: 'pair', request: toLead, replies: [leadReply] },
    ]);
  });

  it('group pairs replies with the latest user message', () => {
    const base = { groupChatId: 'g1' };
    const first = msg({ ...base, from: 'user', to: 'alice' });
    const a = msg({ ...base, from: 'alice', to: 'user' });
    const second = msg({ ...base, from: 'user', to: 'alice' });
    const b = msg({ ...base, from: 'bob', to: 'user' });
    const items = buildFocusThread([first, a, second, b], group);
    expect(items).toMatchObject([
      { kind: 'pair', request: first, replies: [a] },
      { kind: 'pair', request: second, replies: [b] },
    ]);
  });

  it('builds the reply index for answered requests only', () => {
    const answered = msg({ from: 'user', to: 'alice' });
    const reply = msg({ from: 'alice', to: 'user' });
    const pending = msg({ from: 'user', to: 'alice' });
    const index = buildFocusReplyIndex(buildFocusThread([answered, reply, pending], aliceChat));
    expect([...index.keys()]).toEqual([answered.messageId]);
    expect(index.get(answered.messageId!)).toEqual([reply]);
  });

  it('keeps one copy of a lead reply stored in the inbox and as the captured SendMessage', () => {
    const request = msg({ from: 'user', to: 'team-lead', timestamp: '2026-10-25T07:51:42.414Z' });
    const inboxCopy = msg({
      from: 'team-lead',
      to: 'user',
      text: 'Деплой закончил проверку прода',
      timestamp: '2026-10-25T07:57:16.867Z',
    });
    const captured = msg({
      from: 'team-lead',
      to: 'user',
      text: 'Деплой  закончил проверку прода\n',
      source: 'lead_process',
      replyChannel: 'explicit',
      replyToMessageIds: [request.messageId!],
      timestamp: '2026-10-25T07:57:16.882Z',
    });
    const items = buildFocusThread([request, inboxCopy, captured], leadChat);
    expect(items).toMatchObject([{ kind: 'pair', replies: [captured] }]);
  });

  it('keeps identical replies that are far apart in time', () => {
    const request = msg({ from: 'user', to: 'alice' });
    const first = msg({ from: 'alice', to: 'user', text: 'ok' });
    const later = msg({
      from: 'alice',
      to: 'user',
      text: 'ok',
      timestamp: new Date(Date.parse(first.timestamp) + 60_000).toISOString(),
    });
    expect(buildFocusThread([request, first, later], aliceChat)).toMatchObject([
      { kind: 'pair', replies: [first, later] },
    ]);
  });

  it('keeps equal replies a few seconds apart that answer different requests', () => {
    const first = msg({ from: 'user', to: 'team-lead' });
    const second = msg({ from: 'user', to: 'team-lead' });
    const ackFirst = msg({
      from: 'team-lead',
      to: 'user',
      text: 'Принял',
      replyChannel: 'explicit',
      replyToMessageIds: [first.messageId!],
    });
    const ackSecond = msg({
      from: 'team-lead',
      to: 'user',
      text: 'Принял',
      replyChannel: 'explicit',
      replyToMessageIds: [second.messageId!],
    });
    const items = buildFocusThread([first, second, ackFirst, ackSecond], leadChat);
    expect(kinds(items)).toEqual(['pair:answered:1', 'pair:answered:1']);
  });

  it('keeps the result after an acknowledgement in the request card', () => {
    const request = msg({ from: 'user', to: 'team-lead' });
    const link = { replyChannel: 'explicit' as const, replyToMessageIds: [request.messageId!] };
    const ack = msg({ from: 'team-lead', to: 'user', text: 'Принял, собираю', ...link });
    const result = msg({ from: 'team-lead', to: 'user', text: 'Вот отчёт', ...link });
    expect(kinds(buildFocusThread([request, ack, result], leadChat))).toEqual(['pair:answered:2']);
  });

  it('reports whether the thread already shows a request', () => {
    const report = msg({ from: 'alice', to: 'user' });
    expect(hasFocusRequest(buildFocusThread([report], aliceChat))).toBe(false);
    const request = msg({ from: 'user', to: 'alice' });
    expect(hasFocusRequest(buildFocusThread([report, request], aliceChat))).toBe(true);
  });
});
