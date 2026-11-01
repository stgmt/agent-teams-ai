// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createNativeOpenCodeDeliveryReadCommitPolicy } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeDeliveryReadCommit';

import type { OpenCodePromptDeliveryLedgerRecord } from '../../../../src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger';

function record(
  overrides: Partial<OpenCodePromptDeliveryLedgerRecord> = {}
): OpenCodePromptDeliveryLedgerRecord {
  return {
    id: 'record-1',
    teamName: 'alpha',
    memberName: 'builder',
    laneId: 'primary',
    runId: 'run-1',
    inboxMessageId: 'msg-1',
    inboxTimestamp: '2026-11-01T00:00:00.000Z',
    source: 'watcher',
    replyRecipient: 'team-lead',
    payloadHash: 'hash-1',
    status: 'accepted',
    attempts: 1,
    maxAttempts: 3,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    diagnostics: [],
    taskRefs: [],
    ...overrides,
  } as never;
}

function policy(workSyncAccepted: boolean) {
  const calls: { teamName: string; memberName: string }[] = [];
  const subject = createNativeOpenCodeDeliveryReadCommitPolicy({
    hasAcceptedMemberWorkSyncReport: async (input) => {
      calls.push(input);
      return workSyncAccepted;
    },
  });
  return { subject, calls };
}

describe('native OpenCode delivery read commit', () => {
  it('refuses to mark read while nothing has answered the prompt', async () => {
    const { subject, calls } = policy(true);

    await expect(
      subject.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: 'alpha',
        memberName: 'builder',
        responseState: 'not_observed',
        ledgerRecord: record(),
      })
    ).resolves.toBe(false);
    expect(calls).toEqual([]);
  });

  it('asks the board before accepting a work-sync nudge as done', async () => {
    const accepted = policy(true);
    await expect(
      accepted.subject.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: 'alpha',
        memberName: 'builder',
        responseState: 'responded_tool_call',
        ledgerRecord: record({
          messageKind: 'member_work_sync_nudge',
          observedToolCallNames: ['mcp__agent_teams__member_work_sync_report'],
        }),
      })
    ).resolves.toBe(true);
    expect(accepted.calls).toEqual([{ teamName: 'alpha', memberName: 'builder' }]);

    const rejected = policy(false);
    await expect(
      rejected.subject.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: 'alpha',
        memberName: 'builder',
        responseState: 'responded_tool_call',
        ledgerRecord: record({
          messageKind: 'member_work_sync_nudge',
          observedToolCallNames: ['mcp__agent_teams__member_work_sync_report'],
        }),
      })
    ).resolves.toBe(false);
  });

  it('accepts a visible reply that points back at the delivered message', async () => {
    const { subject } = policy(false);
    const message = {
      from: 'builder',
      to: 'team-lead',
      text: 'Refactor finished; the empty-input branch now has coverage.',
      timestamp: '2026-11-01T00:01:00.000Z',
      read: false,
      messageId: 'reply-1',
      relayOfMessageId: 'msg-1',
      source: 'runtime_delivery' as const,
    };

    await expect(
      subject.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: 'alpha',
        memberName: 'builder',
        responseState: 'responded_visible_message',
        actionMode: 'do',
        ledgerRecord: record({ status: 'accepted' }),
        visibleReply: {
          inboxName: 'team-lead',
          message,
          missingRuntimeDeliverySource: false,
        },
      })
    ).resolves.toBe(true);
  });

  it('keeps a delivery pending when a cancelled record is presented', async () => {
    const { subject } = policy(true);

    await expect(
      subject.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: 'alpha',
        memberName: 'builder',
        responseState: 'responded_tool_call',
        ledgerRecord: record({ cancelledAt: '2026-11-01T00:02:00.000Z' }),
      })
    ).resolves.toBe(false);
  });

  it('explains why an unanswered delivery cannot be marked read', () => {
    const { subject } = policy(false);

    const reason = subject.getOpenCodeDeliveryPendingReason({
      responseState: 'not_observed',
      actionMode: 'do',
      ledgerRecord: record(),
    });

    expect(reason.length).toBeGreaterThan(0);
    expect(reason).not.toBe('not_pending');
  });
});
