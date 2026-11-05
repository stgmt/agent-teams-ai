// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNativeOpenCodeVisibleReplyProof } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeVisibleReplyProof';
import { createOpenCodePromptDeliveryLedger } from '../../../../src/main/services/team/provisioning/OpenCodePromptDeliveryQueries';
import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { TeamConfig } from '../../../../src/shared/types';

const teamName = 'alpha';
const created: string[] = [];
let claudeBase = '';

const config: TeamConfig = {
  name: 'Alpha',
  projectPath: '/TEST/alpha',
  members: [
    { name: 'team-lead', agentType: 'team-lead', providerId: 'opencode' } as never,
    { name: 'builder', agentType: 'general-purpose', providerId: 'opencode' } as never,
  ],
} as never;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-proof-'));
  created.push(root);
  claudeBase = root;
  setClaudeBasePathOverride(root);
});

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seedLedger(inboxMessageId: string) {
  const ledger = createOpenCodePromptDeliveryLedger(teamName, 'primary', {
    teamsBasePath: join(claudeBase, 'teams'),
  });
  const record = await ledger.ensurePending({
    teamName,
    memberName: 'builder',
    laneId: 'primary',
    runId: 'run-1',
    inboxMessageId,
    inboxTimestamp: '2026-11-01T00:00:00.000Z',
    source: 'watcher',
    replyRecipient: 'team-lead',
    payloadHash: `hash-${inboxMessageId}`,
    now: '2026-11-01T00:00:00.000Z',
  });
  return { ledger, record };
}

function proof(emitted: string[]) {
  return createNativeOpenCodeVisibleReplyProof({
    readConfig: async () => config,
    emitRuntimeDeliveryReplyAdvisoryRefresh: (_team, message) =>
      emitted.push(message.messageId ?? ''),
    warn: () => undefined,
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    nowIso: () => '2026-11-01T00:02:00.000Z',
  });
}

describe('native OpenCode visible reply proof', () => {
  it('finds the reply that points back at the delivered message and records it on the ledger', async () => {
    const { ledger, record } = await seedLedger('msg-1');
    await new TeamInboxWriter().sendMessage(teamName, {
      member: 'team-lead',
      from: 'builder',
      text: 'Finished the parser change and the tests covering the empty-input branch now pass.',
      messageId: 'reply-1',
      relayOfMessageId: 'msg-1',
      source: 'runtime_delivery',
      timestamp: '2026-11-01T00:01:00.000Z',
    });
    const emitted: string[] = [];

    const result = await proof(emitted).applyDestinationProof({
      ledger,
      ledgerRecord: record,
      teamName,
      replyRecipient: 'team-lead',
      memberName: 'builder',
    });

    expect(result.visibleReply?.message.messageId).toBe('reply-1');
    expect(result.ledgerRecord.visibleReplyMessageId).toBe('reply-1');
    expect(result.ledgerRecord.visibleReplyCorrelation).toBe('relayOfMessageId');
    expect(emitted).toContain('reply-1');
  });

  it('reports no proof when the inbox holds nothing that answers the delivery', async () => {
    const { ledger, record } = await seedLedger('msg-2');
    await new TeamInboxWriter().sendMessage(teamName, {
      member: 'team-lead',
      from: 'builder',
      text: 'Finished the parser change and the tests covering the empty-input branch now pass.',
      messageId: 'unrelated-reply',
      relayOfMessageId: 'some-other-message',
      source: 'runtime_delivery',
      timestamp: '2026-11-01T00:01:00.000Z',
    });

    const result = await proof([]).applyDestinationProof({
      ledger,
      ledgerRecord: record,
      teamName,
      replyRecipient: 'team-lead',
      memberName: 'builder',
    });

    expect(result.visibleReply).toBeNull();
    expect(result.ledgerRecord.visibleReplyMessageId).toBeNull();
  });
});
