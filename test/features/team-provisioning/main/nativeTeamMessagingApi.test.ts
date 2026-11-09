// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NativeTeamMessagingApi } from '../../../../src/features/team-provisioning/main/adapters/input/NativeTeamMessagingApi';
import { NativeLeadLiveMessageStore } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadLiveMessageStore';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'test-team',
  runId: 'TEST-run',
};

const snapshot = {
  identity: run,
  members: {
    'team-lead': {
      memberName: 'team-lead',
      role: 'lead',
      lane: { laneId: 'primary', sessionId: 'TEST-session' },
    },
  },
} as unknown as TeamLifecycleSnapshot;

function setup(delivery?: {
  relayOpenCodeMemberInboxMessages: ReturnType<typeof vi.fn>;
  getOpenCodeRuntimeDeliveryStatus: ReturnType<typeof vi.fn>;
  scheduleDeliveryVerification?: ReturnType<typeof vi.fn>;
}) {
  let currentSnapshot: typeof snapshot | null = snapshot;
  let live = true;
  const sendLeadMessage = vi.fn(async () => undefined);
  const liveLeadMessages = new NativeLeadLiveMessageStore();
  const relayLeadInboxMessages = vi.fn(async () => 0);
  const readConfigSnapshot = vi.fn(async () => ({
    name: 'test-team',
    members: [
      { name: 'team-lead', providerId: 'anthropic' },
      { name: 'Builder', providerId: 'opencode' },
      { name: 'Coder', providerId: 'codex' },
    ],
  }) as never);
  const readMembersMeta = vi.fn(async () => []);
  const api = new NativeTeamMessagingApi({
    runs: {
      find: (teamName) => (teamName === run.teamName ? currentSnapshot : null),
      isLive: () => live,
    },
    recipientSources: { readConfigSnapshot, readMembersMeta },
    liveLeadMessages,
    sendLeadMessage,
    relayLeadInboxMessages,
    ...(delivery ? { openCodeMemberDelivery: delivery as never } : {}),
    ...(delivery?.scheduleDeliveryVerification
      ? { scheduleDeliveryVerification: delivery.scheduleDeliveryVerification as never }
      : {}),
  });
  return {
    api,
    sendLeadMessage,
    relayLeadInboxMessages,
    readConfigSnapshot,
    setSnapshot: (next: typeof snapshot | null) => {
      currentSnapshot = next;
    },
    setLive: (next: boolean) => {
      live = next;
    },
  };
}

describe('native team messaging', () => {
  it('sends a system message to the exact lead run', async () => {
    const { api, sendLeadMessage } = setup();
    await api.sendMessageToTeam('test-team', 'TEST message');
    expect(sendLeadMessage).toHaveBeenCalledWith(snapshot.identity, 'TEST message');
    await expect(api.sendMessageToTeam('test-team', '   ')).rejects.toThrow('non-empty message');
    await expect(
      api.sendMessageToTeam('test-team', 'TEST message', [
        { data: 'TEST', mimeType: 'text/plain' as never },
      ])
    ).rejects.toThrow('does not accept attachments');
  });

  it('rejects an unknown team', async () => {
    const { api } = setup();
    await expect(api.sendMessageToTeam('absent', 'TEST message')).rejects.toThrow('Unknown team');
  });

  it('resolves the recipient provider and lane lead session', async () => {
    const { api, readConfigSnapshot } = setup();
    await expect(api.resolveRuntimeRecipientProviderId('test-team', 'builder')).resolves.toBe(
      'opencode'
    );
    expect(readConfigSnapshot).toHaveBeenCalledWith('test-team');
    expect(api.getCurrentLeadSessionId('test-team')).toBe('TEST-session');
    expect(api.getCurrentLeadSessionId('absent')).toBeNull();
  });

  it('resolves Claude and Codex from persisted members while the team is stopped', async () => {
    const { api, setSnapshot } = setup();
    setSnapshot(null);
    await expect(api.resolveRuntimeRecipientProviderId('test-team', 'TEAM-LEAD')).resolves.toBe('anthropic');
    await expect(api.resolveRuntimeRecipientProviderId('test-team', 'cOdEr')).resolves.toBe('codex');
    await expect(api.resolveRuntimeRecipientProviderId('test-team', 'missing')).resolves.toBeUndefined();
  });

  it('relays the lead inbox through the native relay', async () => {
    const { api, relayLeadInboxMessages } = setup();
    await expect(api.relayLeadInboxMessages('test-team')).resolves.toBe(0);
    expect(relayLeadInboxMessages).toHaveBeenCalledWith('test-team');
    await expect(api.relayLeadInboxMessages('absent')).rejects.toThrow('Unknown team');
  });

  it('delegates OpenCode member delivery to the configured ledger', async () => {
    const relayOpenCodeMemberInboxMessages = vi.fn(async () => ({ attempted: [] }) as never);
    const getOpenCodeRuntimeDeliveryStatus = vi.fn(
      async () => ({ responsePending: true }) as never
    );
    const { api } = setup({
      relayOpenCodeMemberInboxMessages,
      getOpenCodeRuntimeDeliveryStatus,
    });
    await expect(
      api.relayOpenCodeMemberInboxMessages('test-team', 'builder', { onlyMessageId: 'message' })
    ).resolves.toMatchObject({ attempted: [] });
    expect(relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith('test-team', 'builder', {
      onlyMessageId: 'message',
    });
    await expect(
      api.getOpenCodeRuntimeDeliveryStatus('test-team', 'message')
    ).resolves.toMatchObject({ responsePending: true });
    expect(getOpenCodeRuntimeDeliveryStatus).toHaveBeenCalledWith('test-team', 'message');
    await expect(api.relayOpenCodeMemberInboxMessages('absent', 'builder')).rejects.toThrow(
      'Unknown team'
    );
  });

  it('arms the retained retry ladder when a targeted relay is not proven delivered', async () => {
    const relayOpenCodeMemberInboxMessages = vi.fn(async () => ({
      relayed: 1,
      attempted: 1,
      delivered: 0,
      failed: 0,
      lastDelivery: { delivered: false, ledgerRecordId: 'record-1' },
    }) as never);
    const scheduleDeliveryVerification = vi.fn();
    const { api } = setup({
      relayOpenCodeMemberInboxMessages,
      getOpenCodeRuntimeDeliveryStatus: vi.fn(async () => null),
      scheduleDeliveryVerification,
    });

    await api.relayOpenCodeMemberInboxMessages('test-team', 'builder', { onlyMessageId: 'message' });

    expect(scheduleDeliveryVerification).toHaveBeenCalledWith({
      teamName: 'test-team',
      memberName: 'builder',
      messageId: 'message',
    });
  });

  it('does not arm a wake for a relay the ledger already proved', async () => {
    const relayOpenCodeMemberInboxMessages = vi.fn(async () => ({
      relayed: 1,
      attempted: 1,
      delivered: 1,
      failed: 0,
      lastDelivery: { delivered: true, ledgerRecordId: 'record-1' },
    }) as never);
    const scheduleDeliveryVerification = vi.fn();
    const { api } = setup({
      relayOpenCodeMemberInboxMessages,
      getOpenCodeRuntimeDeliveryStatus: vi.fn(async () => null),
      scheduleDeliveryVerification,
    });

    await api.relayOpenCodeMemberInboxMessages('test-team', 'builder', { onlyMessageId: 'message' });

    expect(scheduleDeliveryVerification).not.toHaveBeenCalled();
  });

  it('fails closed when no OpenCode member delivery ledger is configured', async () => {
    const { api } = setup();
    await expect(api.relayOpenCodeMemberInboxMessages('test-team', 'builder')).rejects.toThrow(
      'not configured'
    );
    await expect(api.getOpenCodeRuntimeDeliveryStatus('test-team', 'message')).rejects.toThrow(
      'not configured'
    );
  });

  it('keeps live lead messages bounded, deduplicated, and scoped to the current live run', () => {
    const { api, setSnapshot, setLive } = setup();
    expect(api.getLiveLeadProcessMessages('test-team')).toEqual([]);

    api.pushLiveLeadProcessMessage('test-team', {
      messageId: 'message-1',
      from: 'team-lead',
      to: 'user',
      text: 'first',
      timestamp: '2026-10-31T00:00:00.000Z',
      read: true,
    });
    api.pushLiveLeadProcessMessage('test-team', {
      messageId: 'message-1',
      from: 'team-lead',
      to: 'user',
      text: 'updated',
      timestamp: '2026-10-31T00:00:01.000Z',
      read: true,
    });
    expect(api.getLiveLeadProcessMessages('test-team')).toEqual([
      expect.objectContaining({
        messageId: 'message-1',
        text: 'updated',
        leadSessionId: 'TEST-session',
      }),
    ]);

    for (let index = 0; index < 100; index += 1) {
      api.pushLiveLeadProcessMessage('test-team', {
        messageId: `message-${index + 2}`,
        from: 'team-lead',
        to: 'user',
        text: `message ${index}`,
        timestamp: '2026-10-31T00:00:01.000Z',
        read: true,
      });
    }
    const boundedMessages = api.getLiveLeadProcessMessages('test-team');
    expect(boundedMessages).toHaveLength(100);
    expect(boundedMessages.some((message) => message.messageId === 'message-1')).toBe(false);

    setSnapshot({
      ...snapshot,
      identity: { ...run, runId: 'TEST-next-run' },
    } as unknown as TeamLifecycleSnapshot);
    expect(api.getLiveLeadProcessMessages('test-team')).toEqual([]);
    api.pushLiveLeadProcessMessage('test-team', {
      messageId: 'message-2',
      from: 'team-lead',
      to: 'user',
      text: 'next run',
      timestamp: '2026-10-31T00:00:02.000Z',
      read: true,
    });
    setLive(false);
    expect(api.getLiveLeadProcessMessages('test-team')).toEqual([]);
    // The caller runs after delivery and persistence, so a stale run must never
    // turn a delivered message into an IPC error.
    expect(() =>
      api.pushLiveLeadProcessMessage('test-team', {
        from: 'team-lead',
        to: 'user',
        text: 'stale',
        timestamp: '2026-10-31T00:00:03.000Z',
        read: true,
      })
    ).not.toThrow();
    expect(api.getLiveLeadProcessMessages('test-team')).toEqual([]);
  });
});
