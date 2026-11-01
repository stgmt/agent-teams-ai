// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createNativeOpenCodeLedgerTransitions } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeLedgerTransitions';
import { createOpenCodePromptDeliveryLedger } from '../../../../src/main/services/team/provisioning/OpenCodePromptDeliveryQueries';

const teamName = 'alpha';
const laneId = 'primary';
const created: string[] = [];

async function teamsBasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'native-ledger-'));
  created.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seedDelivery(base: string, inboxMessageId: string) {
  const ledger = createOpenCodePromptDeliveryLedger(teamName, laneId, { teamsBasePath: base });
  const record = await ledger.ensurePending({
    teamName,
    memberName: 'builder',
    laneId,
    runId: 'run-1',
    inboxMessageId,
    inboxTimestamp: '2026-11-01T00:00:00.000Z',
    source: 'watcher',
    replyRecipient: 'team-lead',
    payloadHash: 'hash-' + inboxMessageId,
    now: '2026-11-01T00:00:00.000Z',
  });
  return { ledger, record };
}

function transitions(events: string[], idle: string[]) {
  return createNativeOpenCodeLedgerTransitions({
    nowIso: () => '2026-11-01T00:05:00.000Z',
    logging: {
      info: (message) => events.push(message),
      logPromptDeliveryEvent: (event, record) => events.push(`${event}:${record.status}`),
      notifyLeadTurnIdle: (record) => idle.push(`${record.memberName}:${record.laneId}`),
    },
  });
}

describe('native OpenCode ledger transitions', () => {
  it('writes a terminal failure, reports it, and ends the lead turn on the primary lane', async () => {
    const base = await teamsBasePath();
    const { ledger, record } = await seedDelivery(base, 'msg-1');
    const events: string[] = [];
    const idle: string[] = [];

    const failed = await transitions(events, idle).markLedgerFailedTerminal({
      ledger,
      id: record.id,
      reason: 'opencode_prompt_delivery_timeout',
      diagnostics: ['no assistant response'],
      failedAt: '2026-11-01T00:03:00.000Z',
    });

    expect(failed.status).toBe('failed_terminal');
    expect(failed.lastReason).toBe('opencode_prompt_delivery_timeout');
    await expect(
      ledger.getActiveForMember({ teamName, memberName: 'builder', laneId })
    ).resolves.toBeNull();
    expect(events).toContain('opencode_prompt_delivery_terminal_failure:failed_terminal');
    expect(idle).toEqual(['builder:primary']);

    // The transition is on disk, not only in the returned object.
    const persisted = (await ledger.list()).find((row) => row.id === record.id);
    expect(persisted?.status).toBe('failed_terminal');
  });

  it('leaves the lead turn alone for a secondary lane', async () => {
    const base = await teamsBasePath();
    const secondaryLane = 'secondary:opencode:builder';
    const ledger = createOpenCodePromptDeliveryLedger(teamName, secondaryLane, {
      teamsBasePath: base,
    });
    const record = await ledger.ensurePending({
      teamName,
      memberName: 'builder',
      laneId: secondaryLane,
      runId: 'run-2',
      inboxMessageId: 'msg-2',
      inboxTimestamp: '2026-11-01T00:00:00.000Z',
      source: 'watcher',
      replyRecipient: 'team-lead',
      payloadHash: 'hash-msg-2',
      now: '2026-11-01T00:00:00.000Z',
    });
    const idle: string[] = [];

    await transitions([], idle).markLedgerFailedTerminal({
      ledger,
      id: record.id,
      reason: 'opencode_prompt_delivery_timeout',
      failedAt: '2026-11-01T00:03:00.000Z',
    });

    expect(idle).toEqual([]);
  });

  it('re-queues a terminal delivery that produced no assistant response at all', async () => {
    const base = await teamsBasePath();
    const { ledger, record } = await seedDelivery(base, 'msg-3');
    const subject = transitions([], []);
    const failed = await subject.markLedgerFailedTerminal({
      ledger,
      id: record.id,
      reason: 'accepted the prompt, but no assistant turn was recorded',
      failedAt: '2026-11-01T00:03:00.000Z',
    });
    expect(failed.status).toBe('failed_terminal');

    const requeued = await subject.requeueNoAssistantTerminalDeliveryIfNeeded({
      ledger,
      ledgerRecord: failed,
    });

    expect(requeued.status).toBe('retry_scheduled');
    expect(requeued.nextAttemptAt).toBe('2026-11-01T00:05:00.000Z');
  });

  it('does not touch a delivery that is already progressing', async () => {
    const base = await teamsBasePath();
    const { ledger, record } = await seedDelivery(base, 'msg-4');
    const events: string[] = [];

    const requeued = await transitions(events, []).requeueNoAssistantTerminalDeliveryIfNeeded({
      ledger,
      ledgerRecord: record,
    });

    expect(requeued).toBe(record);
    expect(events).toEqual([]);
    expect((await ledger.list())[0]?.status).toBe(record.status);
  });
});
