// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NativeTeamMessagingApi } from '../../../../src/features/team-provisioning/main/adapters/input/NativeTeamMessagingApi';

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
}) {
  const sendLeadMessage = vi.fn(async () => undefined);
  const relayLeadInboxMessages = vi.fn(async () => 0);
  const findConfiguredMember = vi.fn(async () => ({
    providerId: 'opencode',
  }));
  const api = new NativeTeamMessagingApi({
    runs: { find: (teamName) => (teamName === run.teamName ? snapshot : null) },
    settings: { findConfiguredMember } as never,
    sendLeadMessage,
    relayLeadInboxMessages,
    ...(delivery ? { openCodeMemberDelivery: delivery as never } : {}),
  });
  return { api, sendLeadMessage, relayLeadInboxMessages, findConfiguredMember };
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
    const { api, findConfiguredMember } = setup();
    await expect(api.resolveRuntimeRecipientProviderId('test-team', 'builder')).resolves.toBe(
      'opencode'
    );
    expect(findConfiguredMember).toHaveBeenCalledWith(run, 'builder');
    expect(api.getCurrentLeadSessionId('test-team')).toBe('TEST-session');
    expect(api.getCurrentLeadSessionId('absent')).toBeNull();
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

  it('fails closed when no OpenCode member delivery ledger is configured', async () => {
    const { api } = setup();
    await expect(api.relayOpenCodeMemberInboxMessages('test-team', 'builder')).rejects.toThrow(
      'not configured'
    );
    await expect(api.getOpenCodeRuntimeDeliveryStatus('test-team', 'message')).rejects.toThrow(
      'not configured'
    );
  });

  it('keeps unmigrated live lead message APIs explicit', () => {
    const { api } = setup();
    expect(api.getLiveLeadProcessMessages('test-team')).toEqual([]);
    expect(() =>
      api.pushLiveLeadProcessMessage('test-team', {
        from: 'team-lead',
        to: 'user',
        text: 'TEST',
        timestamp: '2026-10-31T00:00:00.000Z',
        read: true,
      })
    ).toThrow('not migrated');
  });
});
