// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeLeadInboxRelay } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadInboxRelay';

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
      'team-lead': {
        memberName: 'team-lead',
        role: 'lead',
        membership: 'configured',
        desired: 'running',
        phase: 'ready',
        resources: 'held',
        generation: 1,
        operationId: 'TEST-op-lead',
        process: { pid: 100, birthId: 'TEST-birth-lead' },
        lane: null,
        everConnected: true,
        skippedForLaunch: false,
        error: null,
        exit: null,
      },
      builder: {
        memberName: 'builder',
        role: 'member',
        membership: 'configured',
        desired: 'running',
        phase: 'ready',
        resources: 'held',
        generation: 1,
        operationId: 'TEST-op-builder',
        process: { pid: 101, birthId: 'TEST-birth-builder' },
        lane: null,
        everConnected: true,
        skippedForLaunch: false,
        error: null,
        exit: null,
      },
    },
    ...overrides,
  };
}

function message(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'builder',
    to: 'team-lead',
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
    lead?: boolean;
    leadPhase?: 'ready' | 'connecting';
    hasAcceptedLeadWorkSyncReport?: () => Promise<boolean>;
    now?: () => number;
    current?: TeamLifecycleSnapshot;
  } = {}
) {
  const current = options.current ?? snapshot();
  if (options.leadPhase) {
    const lead = current.members['team-lead'];
    if (lead) (lead as { phase: string }).phase = options.leadPhase;
  }
  const send = vi.fn(async (_run: TeamRunIdentity, _text: string) => undefined);
  const markRead = vi.fn(
    async (_teamName: string, _leadName: string, _ids: readonly string[]) => undefined
  );
  const getMessagesFor = vi.fn(async () => options.messages ?? [message()]);
  const relay = new NativeLeadInboxRelay({
    runs: {
      find: (teamName) => (teamName === run.teamName ? current : null),
      isLive: () => options.live ?? true,
    },
    snapshot: () => current,
    inbox: { getMessagesFor },
    send,
    teamsRoot: 'TEST-teams-root',
    markRead,
    controlUrl: async () => null,
    ...(options.hasAcceptedLeadWorkSyncReport
      ? { hasAcceptedLeadWorkSyncReport: options.hasAcceptedLeadWorkSyncReport }
      : {}),
    now: options.now ?? (() => Date.parse(startedAt) + 60_000),
  });
  return { relay, send, markRead, getMessagesFor };
}

describe('native lead inbox relay', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends one batched prompt and commits the batch read after delivery', async () => {
    const messages = [
      message({ messageId: 'TEST-1', text: 'first' }),
      message({ messageId: 'TEST-2', text: 'second' }),
    ];
    const { relay, send, markRead } = setup({ messages });
    await expect(relay.relay(run.teamName)).resolves.toBe(2);
    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.calls[0]![1]).toContain('first');
    expect(send.mock.calls[0]![1]).toContain('second');
    expect(markRead).toHaveBeenCalledWith(run.teamName, 'team-lead', ['TEST-1', 'TEST-2']);
  });

  it('skips read messages and group chat envelopes', async () => {
    const messages = [
      message({ messageId: 'TEST-read', read: true }),
      { ...message({ messageId: 'TEST-group' }), groupChatProtocolVersion: 1 } as InboxMessage,
    ];
    const { relay, send } = setup({ messages });
    await expect(relay.relay(run.teamName)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('relays a message once and never repeats it', async () => {
    const { relay, send } = setup();
    await expect(relay.relay(run.teamName)).resolves.toBe(1);
    await expect(relay.relay(run.teamName)).resolves.toBe(0);
    expect(send).toHaveBeenCalledOnce();
  });

  it('leaves the batch unread when the write fails', async () => {
    const { relay, send, markRead } = setup();
    send.mockRejectedValueOnce(new Error('TEST stdin closed'));
    await expect(relay.relay(run.teamName)).resolves.toBe(0);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('does not relay for a stopped run or a missing lead process', async () => {
    const stopped = setup({ live: false });
    await expect(stopped.relay.relay(run.teamName)).resolves.toBe(0);
    expect(stopped.send).not.toHaveBeenCalled();

    const noLead = setup({
      current: snapshot({
        members: {
          builder: snapshot().members.builder!,
        },
      }),
    });
    await expect(noLead.relay.relay(run.teamName)).resolves.toBe(0);
    expect(noLead.send).not.toHaveBeenCalled();
  });

  it('polls on an interval and stops on demand', async () => {
    vi.useFakeTimers();
    const { relay, getMessagesFor } = setup();
    relay.startPolling(run.teamName, 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(getMessagesFor).toHaveBeenCalled();
    relay.stopPolling(run.teamName);
    const calls = getMessagesFor.mock.calls.length;
    await vi.advanceTimersByTimeAsync(3_000);
    expect(getMessagesFor).toHaveBeenCalledTimes(calls);
    relay.dispose();
  });

  it('does not relay until the lead process is ready', async () => {
    const { relay, send } = setup({ leadPhase: 'connecting' });
    await expect(relay.relay(run.teamName)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it('schedules a deferred same-team retry instead of stranding it', async () => {
    vi.useFakeTimers();
    let clock = Date.parse(startedAt) + 60_000;
    const deferred = message({
      messageId: 'TEST-deferred',
      source: undefined,
      timestamp: new Date(clock).toISOString(),
    });
    const { relay, send } = setup({ messages: [deferred], now: () => clock });
    await expect(relay.relay(run.teamName)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    clock += 15_000;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(send).toHaveBeenCalledOnce();
    relay.dispose();
  });

  it('keeps a work-sync nudge unread until the lead report is accepted', async () => {
    const nudge = message({
      messageId: 'TEST-nudge',
      messageKind: 'member_work_sync_nudge',
    });
    const rejected = setup({ messages: [nudge] });
    await expect(rejected.relay.relay(run.teamName)).resolves.toBe(1);
    expect(rejected.markRead).not.toHaveBeenCalled();

    const accepted = setup({
      messages: [nudge],
      hasAcceptedLeadWorkSyncReport: async () => true,
    });
    await expect(accepted.relay.relay(run.teamName)).resolves.toBe(1);
    expect(accepted.markRead).toHaveBeenCalledWith(run.teamName, 'team-lead', ['TEST-nudge']);
  });

  it('clears per-run relay state on release', async () => {
    const { relay, send } = setup();
    await expect(relay.relay(run.teamName)).resolves.toBe(1);
    relay.reset(run.teamName);
    await expect(relay.relay(run.teamName)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('re-relays an unaccepted work-sync nudge after the cooldown', async () => {
    let clock = Date.parse(startedAt) + 60_000;
    const nudge = message({ messageId: 'TEST-nudge', messageKind: 'member_work_sync_nudge' });
    const { relay, send } = setup({ messages: [nudge], now: () => clock });
    await expect(relay.relay(run.teamName)).resolves.toBe(1);
    await expect(relay.relay(run.teamName)).resolves.toBe(0);
    clock += 60_001;
    await expect(relay.relay(run.teamName)).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
    relay.dispose();
  });

  it('marks permanently ignored cross-team echo rows read without sending', async () => {
    const messages = [
      message({ messageId: 'TEST-echo', source: 'cross_team_sent', text: 'own outbound' }),
    ];
    const { relay, send, markRead } = setup({ messages });
    await expect(relay.relay(run.teamName)).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(markRead).toHaveBeenCalledWith(run.teamName, 'team-lead', ['TEST-echo']);
  });
});
