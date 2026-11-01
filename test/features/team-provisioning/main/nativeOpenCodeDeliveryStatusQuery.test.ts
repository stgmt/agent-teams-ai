// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createNativeOpenCodeDeliveryStatusQuery } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeDeliveryStatusQuery';
import { createOpenCodePromptDeliveryLedgerStore } from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  writeOpenCodeRuntimeLaneIndex,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import type { InboxMessage, TeamConfig } from '../../../../src/shared/types';

const teamsBasePath = mkdtempSync(join(tmpdir(), 'agts-status-'));
const teamName = 'alpha';
const laneId = 'primary';

afterAll(() => rmSync(teamsBasePath, { recursive: true, force: true }));

function ledger() {
  return createOpenCodePromptDeliveryLedgerStore({
    filePath: getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath,
      teamName,
      laneId,
      fileName: 'opencode-prompt-delivery-ledger.json',
    }),
  });
}

async function seed(messageId: string, now: string) {
  await writeOpenCodeRuntimeLaneIndex(teamsBasePath, teamName, {
    version: 1,
    updatedAt: now,
    lanes: { [laneId]: { laneId, state: 'active', updatedAt: now } },
  });
  return await ledger().ensurePending({
    teamName,
    memberName: 'builder',
    laneId,
    runId: 'run-alpha',
    inboxMessageId: messageId,
    inboxTimestamp: now,
    source: 'watchdog',
    replyRecipient: 'user',
    payloadHash: 'hash-1',
    now,
  });
}

const config: TeamConfig = {
  name: 'Alpha',
  members: [{ name: 'team-lead', agentType: 'team-lead' }],
} as never;

function query(inbox: readonly InboxMessage[] = []) {
  return createNativeOpenCodeDeliveryStatusQuery({
    teamsBasePath,
    readInbox: async () => inbox,
    readTasks: async () => [],
    readConfig: async () => config,
  });
}

describe('native delivery status query', () => {
  it('answers from the retained ledger without any runtime', async () => {
    await seed('msg-1', '2026-11-01T10:00:00.000Z');

    const status = await query().getOpenCodeRuntimeDeliveryStatus(teamName, 'msg-1');

    expect(status).not.toBeNull();
    expect(status?.messageId).toBe('msg-1');
    expect(status?.laneId).toBe(laneId);
    // The retained row never proved an accepted prompt, so the answer is "still pending".
    expect(status?.ledgerStatus).toBe('pending');
    expect(status?.responsePending).toBe(true);
  });

  it('reports nothing for a message the ledger never saw', async () => {
    await expect(
      query().getOpenCodeRuntimeDeliveryStatus(teamName, 'msg-unknown')
    ).resolves.toBeNull();
  });

  it('reflects a ledger state change on the next read instead of caching the first answer', async () => {
    const record = await seed('msg-3', '2026-11-01T12:00:00.000Z');
    const before = await query().getOpenCodeRuntimeDeliveryStatus(teamName, 'msg-3');
    await ledger().markFailedTerminal({
      id: record.id,
      reason: 'TEST runtime rejected the prompt',
      failedAt: '2026-11-01T12:00:05.000Z',
    });

    const after = await query().getOpenCodeRuntimeDeliveryStatus(teamName, 'msg-3');

    expect(before?.ledgerStatus).toBe('pending');
    expect(after?.ledgerStatus).not.toBe(before?.ledgerStatus);
  });
});
