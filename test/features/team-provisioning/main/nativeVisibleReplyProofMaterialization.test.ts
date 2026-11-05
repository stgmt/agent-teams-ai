// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNativeOpenCodePromptDeliveryLedgerFactory } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodePromptDeliveryLedgerFactory';
import { createNativeOpenCodeVisibleReplyProof } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeVisibleReplyProof';
import { TeamInboxReader } from '../../../../src/main/services/team/TeamInboxReader';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

const TEAM = 'alpha';
const MEMBER = 'dev';
const LANE = 'primary';
const PROMPT_ID = 'inbox-prompt-1';
const NOW = '2026-11-02T10:00:00.000Z';

let claudeBase = '';
let proof: ReturnType<typeof createNativeOpenCodeVisibleReplyProof>;
let ledger: ReturnType<ReturnType<typeof createNativeOpenCodePromptDeliveryLedgerFactory>>;

beforeEach(async () => {
  claudeBase = await mkdtemp(join(tmpdir(), 'native-proof-'));
  setClaudeBasePathOverride(claudeBase);
  const teamsBasePath = join(claudeBase, 'teams');
  ledger = createNativeOpenCodePromptDeliveryLedgerFactory(teamsBasePath)(TEAM, LANE);
  proof = createNativeOpenCodeVisibleReplyProof({
    readConfig: async () => null,
    emitRuntimeDeliveryReplyAdvisoryRefresh: () => undefined,
    warn: () => undefined,
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    nowIso: () => NOW,
  });
});

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await rm(claudeBase, { recursive: true, force: true });
});

async function answeredRecord(preview: string) {
  const pending = await ledger.ensurePending({
    teamName: TEAM,
    memberName: MEMBER,
    laneId: LANE,
    inboxMessageId: PROMPT_ID,
    inboxTimestamp: NOW,
    source: 'ui-send',
    replyRecipient: 'user',
    actionMode: 'do',
    taskRefs: [],
    payloadHash: 'payload-hash-1',
    now: NOW,
  });
  await ledger.applyObservation({
    id: pending.id,
    responseObservation: {
      state: 'responded_plain_text',
      deliveredUserMessageId: 'runtime-user-1',
      assistantMessageId: 'runtime-assistant-1',
      toolCallNames: [],
      visibleMessageToolCallId: null,
      visibleReplyMessageId: null,
      visibleReplyCorrelation: null,
      latestAssistantPreview: preview,
      reason: 'turn_ended',
    },
    observedAt: NOW,
  });
  const reloaded = await ledger.getByInboxMessage({
    teamName: TEAM,
    memberName: MEMBER,
    laneId: LANE,
    inboxMessageId: PROMPT_ID,
  });
  if (!reloaded) throw new Error('ledger record missing after observation');
  return reloaded;
}

describe('native visible reply materialization', () => {
  it('writes the answer the user never saw, pointing back at the prompt', async () => {
    const record = await answeredRecord('Переписал обработчик и проверил сборку');

    const result = await proof.materializePlainTextReplyIfNeeded({
      ledger,
      ledgerRecord: record,
      teamName: TEAM,
      memberName: MEMBER,
    });

    expect(result.visibleReply?.message.text).toContain('Переписал обработчик');
    expect(result.visibleReply?.message.relayOfMessageId).toBe(PROMPT_ID);
    expect(result.ledgerRecord.visibleReplyMessageId).toBe(result.visibleReply?.message.messageId);

    const userInbox = await new TeamInboxReader().getMessagesFor(TEAM, 'user');
    expect(userInbox.some((message) => message.relayOfMessageId === PROMPT_ID)).toBe(true);
  });

  it('leaves a bare acknowledgement out of the inbox', async () => {
    const record = await answeredRecord('Понял');

    const result = await proof.materializePlainTextReplyIfNeeded({
      ledger,
      ledgerRecord: record,
      teamName: TEAM,
      memberName: MEMBER,
    });

    expect(result.visibleReply).toBeNull();
    const userInbox = await new TeamInboxReader().getMessagesFor(TEAM, 'user');
    expect(userInbox).toHaveLength(0);
  });

  it('does not write a second copy when the answer is already materialized', async () => {
    const record = await answeredRecord('Переписал обработчик и проверил сборку');
    const first = await proof.materializePlainTextReplyIfNeeded({
      ledger,
      ledgerRecord: record,
      teamName: TEAM,
      memberName: MEMBER,
    });

    const second = await proof.materializePlainTextReplyIfNeeded({
      ledger,
      ledgerRecord: first.ledgerRecord,
      teamName: TEAM,
      memberName: MEMBER,
      visibleReply: first.visibleReply,
    });

    expect(second.visibleReply?.message.messageId).toBe(first.visibleReply?.message.messageId);
    const userInbox = await new TeamInboxReader().getMessagesFor(TEAM, 'user');
    expect(userInbox.filter((message) => message.relayOfMessageId === PROMPT_ID)).toHaveLength(1);
  });
});
