// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { NativeCrossTeamMessagingApi } from '../../../../src/features/team-provisioning/main/adapters/input/NativeCrossTeamMessagingApi';
import { NativeCrossTeamReplyLedger } from '../../../../src/features/team-provisioning/main/adapters/output/NativeCrossTeamReplyLedger';
import { NativeLeadInboxRelay } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadInboxRelay';
import { createNativeTeamCrossTeamApi } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamProvisioningApis';

import type { TeamLifecycleSnapshot } from '../../../../src/features/team-provisioning/contracts';
import type { InboxMessage } from '../../../../src/shared/types';

const NOW = Date.parse('2026-11-01T10:00:00.000Z');

const run = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'alpha',
  runId: 'TEST-run',
};

const snapshot = {
  identity: run,
  members: {
    'team-lead': { memberName: 'team-lead', role: 'lead', membership: 'configured' },
    worker: { memberName: 'worker', role: 'member', membership: 'configured' },
    rider: { memberName: 'rider', role: 'member', membership: 'configured' },
  },
} as unknown as TeamLifecycleSnapshot;

function crossTeamInboxMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageId: 'inbox-1',
    from: 'beta.worker',
    to: 'worker',
    text: 'TEST cross-team body',
    timestamp: '2026-11-01T09:59:00.000Z',
    source: 'cross_team',
    ...overrides,
  } as InboxMessage;
}

function setup(
  options: {
    providers?: Record<string, string | undefined>;
    inbox?: InboxMessage[];
    delivery?: {
      relayOpenCodeMemberInboxMessages: ReturnType<typeof vi.fn>;
      getOpenCodeRuntimeDeliveryStatus: ReturnType<typeof vi.fn>;
    };
    providerFailureFor?: string;
  } = {}
) {
  let live = true;
  let currentSnapshot: TeamLifecycleSnapshot | null = snapshot;
  const replyLedger = new NativeCrossTeamReplyLedger();
  const relayLeadInboxMessages = vi.fn(async (_teamName: string) => 1);
  const inboxMessages = new Map<string, InboxMessage[]>(Object.entries({ worker: options.inbox ?? [] }));
  const findConfiguredMember = vi.fn(async (_identity: unknown, memberName: string) => {
    if (memberName === options.providerFailureFor) throw new Error('provider settings unavailable');
    const providerId = options.providers?.[memberName];
    return providerId ? { providerId } : undefined;
  });

  const api = new NativeCrossTeamMessagingApi({
    runs: {
      find: (teamName) => (teamName === run.teamName ? currentSnapshot : null),
      isLive: () => live,
    },
    replyLedger,
    settings: { findConfiguredMember } as never,
    inbox: {
      getMessagesFor: async (_teamName: string, member: string) => inboxMessages.get(member) ?? [],
    },
    relayLeadInboxMessages,
    ...(options.delivery ? { openCodeMemberDelivery: options.delivery as never } : {}),
    now: () => NOW,
  });

  return {
    api,
    replyLedger,
    relayLeadInboxMessages,
    findConfiguredMember,
    setLive: (next: boolean) => {
      live = next;
    },
    setSnapshot: (next: TeamLifecycleSnapshot | null) => {
      currentSnapshot = next;
    },
  };
}

describe('native cross-team messaging', () => {
  it('answers reply metadata only from a live run', () => {
    const { api, setLive } = setup();
    expect(api.resolveCrossTeamReplyMetadata('alpha', 'beta')).toBeNull();

    api.registerPendingCrossTeamReplyExpectation('alpha', 'beta', 'conversation-1');
    expect(api.resolveCrossTeamReplyMetadata('alpha', 'beta')).toEqual({
      conversationId: 'conversation-1',
      replyToConversationId: 'conversation-1',
    });

    setLive(false);
    expect(api.resolveCrossTeamReplyMetadata('alpha', 'beta')).toBeNull();
  });

  it('refuses to infer metadata when two conversations are open', () => {
    const { api } = setup();
    api.registerPendingCrossTeamReplyExpectation('alpha', 'beta', 'conversation-1');
    api.registerPendingCrossTeamReplyExpectation('alpha', 'beta', 'conversation-2');
    expect(api.resolveCrossTeamReplyMetadata('alpha', 'beta')).toBeNull();
    expect(api.resolveCrossTeamReplyMetadata('alpha', 'gamma')).toBeNull();
  });

  it('clears an expectation and shares one ledger with the lead relay', () => {
    const { api, replyLedger } = setup();
    const relay = new NativeLeadInboxRelay({
      runs: { find: () => snapshot, isLive: () => true },
      snapshot: () => snapshot,
      inbox: { getMessagesFor: async () => [] },
      send: async () => undefined,
      teamsRoot: 'C:/TEST/teams',
      controlUrl: async () => null,
      crossTeamState: replyLedger.state,
      now: () => NOW,
    });

    api.registerPendingCrossTeamReplyExpectation('alpha', 'beta', 'conversation-1');
    expect(api.resolveCrossTeamReplyMetadata('alpha', 'beta')).not.toBeNull();

    // The relay's reset is the run boundary; the API must not keep a second copy.
    relay.reset('alpha');
    expect(api.resolveCrossTeamReplyMetadata('alpha', 'beta')).toBeNull();

    api.registerPendingCrossTeamReplyExpectation('alpha', 'beta', 'conversation-2');
    api.clearPendingCrossTeamReplyExpectation('alpha', 'beta', 'conversation-2');
    expect(api.resolveCrossTeamReplyMetadata('alpha', 'beta')).toBeNull();
  });

  it('reports liveness and relays the lead inbox only for a live run', async () => {
    const { api, relayLeadInboxMessages, setLive } = setup();
    expect(api.isTeamAlive('alpha')).toBe(true);
    expect(api.isTeamAlive('beta')).toBe(false);

    await expect(api.relayLeadInboxMessages('alpha')).resolves.toBe(1);
    expect(relayLeadInboxMessages).toHaveBeenCalledWith('alpha');

    setLive(false);
    await expect(api.relayLeadInboxMessages('alpha')).resolves.toBe(0);
    expect(relayLeadInboxMessages).toHaveBeenCalledTimes(1);
  });

  it('ignores app-owned inboxes without relaying', async () => {
    const { api, relayLeadInboxMessages } = setup();
    await expect(api.relayInboxFileToLiveRecipient('alpha', 'user')).resolves.toEqual({
      kind: 'ignored',
      relayed: 0,
    });
    expect(relayLeadInboxMessages).not.toHaveBeenCalled();
  });

  it('relays a lead recipient and confirms it from the shared delivery ledger', async () => {
    const { api, replyLedger } = setup();
    await expect(api.relayInboxFileToLiveRecipient('alpha', 'team-lead')).resolves.toEqual({
      kind: 'native_lead',
      relayed: 1,
    });

    await expect(
      api.relayInboxFileToLiveRecipient('alpha', 'team-lead', { onlyMessageId: 'cross-1' })
    ).resolves.toEqual({
      kind: 'native_lead',
      relayed: 1,
      recentlyDeliveredMessageId: 'cross-1',
    });

    // A relay that wrote nothing is still proof when the lead ledger already saw the id.
    replyLedger.rememberLeadDelivery('alpha', ['cross-1'], NOW);
    const replay = await api.relayInboxFileToLiveRecipient('alpha', 'team-lead', {
      onlyMessageId: 'cross-1',
    });
    expect(replay.recentlyDeliveredMessageId).toBe('cross-1');
  });

  it('proves a native member delivery from its durable inbox row', async () => {
    const { api } = setup({ inbox: [crossTeamInboxMessage()] });
    await expect(
      api.relayInboxFileToLiveRecipient('alpha', 'worker', { onlyMessageId: 'inbox-1' })
    ).resolves.toEqual({
      kind: 'native_member_noop',
      relayed: 0,
      durablyStoredMessageId: 'inbox-1',
    });

    const missing = await api.relayInboxFileToLiveRecipient('alpha', 'worker', {
      onlyMessageId: 'inbox-2',
    });
    expect(missing.kind).toBe('native_member_noop');
    expect(missing.durablyStoredMessageId).toBeUndefined();
    expect(missing.diagnostics).toEqual(['durable inbox message not found: inbox-2']);
  });

  it('rejects an unknown recipient instead of relaying to the lead', async () => {
    const { api, relayLeadInboxMessages } = setup();
    const result = await api.relayInboxFileToLiveRecipient('alpha', 'ghost', {
      onlyMessageId: 'inbox-1',
    });
    expect(result.kind).toBe('ignored');
    expect(result.relayed).toBe(0);
    expect(result.diagnostics?.[0]).toContain('Unknown toMember');
    expect(relayLeadInboxMessages).not.toHaveBeenCalled();
  });

  it('delegates OpenCode recipients to the delivery ledger', async () => {
    const relayOpenCodeMemberInboxMessages = vi.fn(async () => ({
      relayed: 2,
      lastDelivery: { delivered: true, accepted: true, responsePending: false },
    }));
    const { api } = setup({
      providers: { rider: 'opencode' },
      delivery: { relayOpenCodeMemberInboxMessages, getOpenCodeRuntimeDeliveryStatus: vi.fn() },
    });

    await expect(
      api.relayInboxFileToLiveRecipient('alpha', 'rider', { onlyMessageId: 'inbox-9' })
    ).resolves.toEqual({
      kind: 'opencode_member',
      relayed: 2,
      diagnostics: undefined,
      lastDelivery: { delivered: true, accepted: true, responsePending: false },
    });
    expect(relayOpenCodeMemberInboxMessages).toHaveBeenCalledWith('alpha', 'rider', {
      source: 'watcher',
      onlyMessageId: 'inbox-9',
    });
  });

  it('fails closed when an OpenCode recipient has no delivery ledger', async () => {
    const { api } = setup({ providers: { rider: 'opencode' } });
    const result = await api.relayInboxFileToLiveRecipient('alpha', 'rider', {
      onlyMessageId: 'inbox-9',
    });
    expect(result.kind).toBe('opencode_member');
    expect(result.relayed).toBe(0);
    expect(result.diagnostics).toEqual(['OpenCode member delivery ledger is not configured']);
  });

  it('fails closed when provider identity cannot be read', async () => {
    const { api, relayLeadInboxMessages } = setup({ providerFailureFor: 'team-lead' });
    const result = await api.relayInboxFileToLiveRecipient('alpha', 'team-lead', {
      onlyMessageId: 'inbox-1',
    });
    expect(result.kind).toBe('ignored');
    expect(result.diagnostics?.[0]).toContain('runtime identity resolution failed');
    expect(relayLeadInboxMessages).not.toHaveBeenCalled();
  });

  it('resolves only the requested recipient and ignores an unrelated member failure', async () => {
    const { api, findConfiguredMember } = setup({ providerFailureFor: 'rider' });
    await expect(api.relayInboxFileToLiveRecipient('alpha', 'team-lead')).resolves.toEqual({
      kind: 'native_lead',
      relayed: 1,
    });
    expect(findConfiguredMember).toHaveBeenCalledTimes(1);
    expect(findConfiguredMember).toHaveBeenCalledWith(snapshot.identity, 'team-lead');

    // A member target resolves that member, never the roster lead.
    await api.relayInboxFileToLiveRecipient('alpha', 'worker');
    expect(findConfiguredMember).toHaveBeenLastCalledWith(snapshot.identity, 'worker');
  });

  it('resolves an OpenCode lead by its canonical name and rejects lead aliases', async () => {
    const { api, findConfiguredMember, relayLeadInboxMessages } = setup({
      providers: { 'team-lead': 'opencode' },
    });
    const lead = await api.relayInboxFileToLiveRecipient('alpha', 'team-lead', {
      onlyMessageId: 'inbox-1',
    });
    expect(findConfiguredMember).toHaveBeenCalledWith(snapshot.identity, 'team-lead');
    expect(lead.kind).toBe('opencode_member');
    expect(lead.diagnostics).toEqual(['OpenCode member delivery ledger is not configured']);

    // The routing helper refuses a non-canonical inbox name before relaying.
    const alias = await api.relayInboxFileToLiveRecipient('alpha', 'lead', {
      onlyMessageId: 'inbox-1',
    });
    expect(alias.kind).toBe('ignored');
    expect(alias.diagnostics?.[0]).toContain('canonicalizes to a different inbox');
    expect(relayLeadInboxMessages).not.toHaveBeenCalled();
  });
});

describe('native cross-team composition', () => {
  it('shares the lifecycle ledger and relay instead of building a second copy', async () => {
    const replyLedger = new NativeCrossTeamReplyLedger();
    const relay = { relay: vi.fn(async () => 3) };
    const lifecycle = {
      runs: { find: () => null, isLive: () => false },
      crossTeamReplies: replyLedger,
      settings: { findConfiguredMember: async () => null },
      inbox: { getMessagesFor: async () => [] },
      relay,
    };
    const api = createNativeTeamCrossTeamApi({
      runtime: { lifecycle } as never,
      now: () => '2026-11-01T10:00:00.000Z',
    });

    api.registerPendingCrossTeamReplyExpectation('alpha', 'beta', 'conversation-1');
    expect(replyLedger.state.pendingReplies.get('alpha')?.size).toBe(1);

    // No live run in this stub, so liveness gates both the read and the relay.
    expect(api.isTeamAlive('alpha')).toBe(false);
    await expect(api.relayLeadInboxMessages('alpha')).resolves.toBe(0);
    expect(relay.relay).not.toHaveBeenCalled();
  });
});
