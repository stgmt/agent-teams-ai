// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeMemberInboxRelay } from '../../../../src/features/team-provisioning/main/adapters/output/NativeMemberInboxRelay';

import type {
  TeamLifecycleSnapshot,
  TeamRunIdentity,
} from '../../../../src/features/team-provisioning/contracts';
import type { InboxMessage } from '../../../../src/shared/types';

const run: TeamRunIdentity = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-fingerprint',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};

const startedAt = '2026-10-31T00:00:00.000Z';

function member(
  memberName: string,
  role: 'lead' | 'member',
  phase: 'ready' | 'connecting' = 'ready'
) {
  return {
    memberName,
    role,
    membership: 'configured' as const,
    desired: 'running' as const,
    phase,
    resources: 'held' as const,
    generation: 1,
    operationId: `TEST-op-${memberName}`,
    process: { pid: role === 'lead' ? 100 : 101, birthId: `TEST-birth-${memberName}` },
    lane: null,
    everConnected: true,
    skippedForLaunch: false,
    error: null,
    exit: null,
  };
}

function snapshot(overrides: Partial<TeamLifecycleSnapshot> = {}): TeamLifecycleSnapshot {
  return {
    identity: run,
    desired: 'running',
    resources: 'held',
    state: 'ready',
    error: null,
    version: 1,
    startedAt,
    members: {
      'team-lead': member('team-lead', 'lead'),
      builder: member('builder', 'member'),
    },
    ...overrides,
  };
}

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'team-lead',
    to: 'builder',
    text: 'TEST message',
    timestamp: startedAt,
    read: false,
    messageId: 'TEST-message-1',
    source: 'inbox',
    ...overrides,
  };
}

function setup(
  options: {
    messages?: InboxMessage[];
    live?: boolean;
    current?: TeamLifecycleSnapshot;
    hasAcceptedMemberWorkSyncReport?: () => Promise<boolean>;
    now?: () => number;
  } = {}
) {
  const current = options.current ?? snapshot();
  const send = vi.fn(async (_run: TeamRunIdentity, _text: string) => undefined);
  const markRead = vi.fn(
    async (_teamName: string, _memberName: string, _ids: readonly string[]) => undefined
  );
  const getMessagesFor = vi.fn(async () => options.messages ?? [message()]);
  const relay = new NativeMemberInboxRelay({
    runs: {
      find: (teamName) => (teamName === run.teamName ? current : null),
      isLive: () => options.live ?? true,
    },
    snapshot: () => current,
    inbox: { getMessagesFor },
    send,
    teamsRoot: 'TEST-teams-root',
    markRead,
    ...(options.hasAcceptedMemberWorkSyncReport
      ? { hasAcceptedMemberWorkSyncReport: options.hasAcceptedMemberWorkSyncReport }
      : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return { relay, send, markRead, getMessagesFor };
}

describe('native member inbox relay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one forward prompt to the lead and commits the member inbox', async () => {
    const messages = [
      message({ messageId: 'TEST-1', text: 'first' }),
      message({ messageId: 'TEST-2', text: 'second' }),
    ];
    const { relay, send, markRead } = setup({ messages });
    await expect(relay.relay(run.teamName, 'builder')).resolves.toBe(2);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toContain('forward to "builder"');
    expect(send.mock.calls[0]![1]).toContain('first');
    expect(send.mock.calls[0]![1]).toContain('second');
    expect(markRead).toHaveBeenCalledWith(run.teamName, 'builder', ['TEST-1', 'TEST-2']);
  });

  it('skips read rows, group envelopes and the lead', async () => {
    const messages = [
      message({ messageId: 'TEST-read', read: true }),
      { ...message({ messageId: 'TEST-group' }), groupChatProtocolVersion: 1 } as InboxMessage,
    ];
    const { relay, send } = setup({ messages });
    await expect(relay.relay(run.teamName, 'builder')).resolves.toBe(0);
    await expect(relay.relay(run.teamName, 'team-lead')).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('does not relay for a stopped run or a member that is not ready', async () => {
    const stopped = setup({ live: false });
    await expect(stopped.relay.relay(run.teamName, 'builder')).resolves.toBe(0);

    const connecting = setup({
      current: snapshot({
        members: {
          'team-lead': member('team-lead', 'lead'),
          builder: member('builder', 'member', 'connecting'),
        },
      }),
    });
    await expect(connecting.relay.relay(run.teamName, 'builder')).resolves.toBe(0);
    expect(connecting.send).not.toHaveBeenCalled();
  });

  it('leaves the batch unread when the lead write fails', async () => {
    const { relay, send, markRead } = setup();
    send.mockRejectedValueOnce(new Error('TEST stdin closed'));
    await expect(relay.relay(run.teamName, 'builder')).resolves.toBe(0);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('keeps a work-sync nudge unread until the member report is accepted', async () => {
    const nudge = message({ messageId: 'TEST-nudge', messageKind: 'member_work_sync_nudge' });
    const rejected = setup({ messages: [nudge] });
    await expect(rejected.relay.relay(run.teamName, 'builder')).resolves.toBe(1);
    expect(rejected.markRead).not.toHaveBeenCalled();

    const accepted = setup({
      messages: [nudge],
      hasAcceptedMemberWorkSyncReport: async () => true,
    });
    await expect(accepted.relay.relay(run.teamName, 'builder')).resolves.toBe(1);
    expect(accepted.markRead).toHaveBeenCalledWith(run.teamName, 'builder', ['TEST-nudge']);
  });

  it('re-relays an unaccepted work-sync nudge after the cooldown', async () => {
    let clock = Date.parse(startedAt) + 60_000;
    const nudge = message({ messageId: 'TEST-nudge', messageKind: 'member_work_sync_nudge' });
    const { relay, send } = setup({ messages: [nudge], now: () => clock });
    await expect(relay.relay(run.teamName, 'builder')).resolves.toBe(1);
    await expect(relay.relay(run.teamName, 'builder')).resolves.toBe(0);
    clock += 60_001;
    await expect(relay.relay(run.teamName, 'builder')).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    relay.dispose();
  });

  it('clears a scheduled work-sync retry on release', async () => {
    vi.useFakeTimers();
    const nudge = message({ messageId: 'TEST-nudge', messageKind: 'member_work_sync_nudge' });
    const { relay, send } = setup({ messages: [nudge] });
    await expect(relay.relay(run.teamName, 'builder')).resolves.toBe(1);
    relay.reset(run.teamName);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(send).toHaveBeenCalledTimes(1);
    relay.dispose();
  });

  it('polls every configured member on an interval', async () => {
    vi.useFakeTimers();
    const { relay, getMessagesFor } = setup();
    relay.startPolling(run.teamName, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getMessagesFor).toHaveBeenCalledWith(run.teamName, 'builder');
    expect(getMessagesFor).not.toHaveBeenCalledWith(run.teamName, 'team-lead');
    relay.dispose();
  });
});
