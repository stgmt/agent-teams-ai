// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNativeOpenCodePromptDeliveryLedgerFactory } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodePromptDeliveryLedgerFactory';
import { createNativeOpenCodeDeliveryWatchdog } from '../../../../src/features/team-provisioning/main/composition/createNativeOpenCodeDeliveryWatchdog';
import {
  upsertOpenCodeRuntimeLaneIndexEntry,
} from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { InboxMessage } from '../../../../src/shared/types';

const TEAM = 'alpha';
const MEMBER = 'builder';
const LANE = 'primary';
const PROMPT_ID = 'inbox-prompt-1';

let claudeBase = '';
let teamsBasePath = '';
let scheduled: { teamName: string; memberName: string; messageId?: string | null }[] = [];
let inbox: InboxMessage[] = [];

beforeEach(async () => {
  claudeBase = await mkdtemp(join(tmpdir(), 'native-watchdog-'));
  setClaudeBasePathOverride(claudeBase);
  teamsBasePath = join(claudeBase, 'teams');
  await mkdir(join(teamsBasePath, TEAM), { recursive: true });
  await upsertOpenCodeRuntimeLaneIndexEntry({
    teamsBasePath,
    teamName: TEAM,
    laneId: LANE,
    state: 'active',
  });
  scheduled = [];
  inbox = [
    {
      messageId: PROMPT_ID,
      from: 'user',
      to: MEMBER,
      text: 'Проверь сборку и почини тесты',
      timestamp: '2026-11-02T10:00:00.000Z',
      read: false,
    } as InboxMessage,
  ];
});

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await rm(claudeBase, { recursive: true, force: true });
});

function subject(options: { canDeliver?: boolean } = {}) {
  const ledgers = createNativeOpenCodePromptDeliveryLedgerFactory(teamsBasePath);
  return {
    watchdog: createNativeOpenCodeDeliveryWatchdog({
      teamsBasePath,
      scheduler: {
        isEnabled: () => true,
        schedule: (input) =>
          scheduled.push({
            teamName: input.teamName,
            memberName: input.memberName,
            messageId: input.messageId,
          }),
        isStaleError: async () => false,
      },
      identity: {
        resolveMembersForRuntimeLane: async () => [MEMBER],
        resolveCurrentOpenCodeRuntimeRunId: async () => 'run-1',
      },
      ledgers: {
        open: (teamName: string, laneId: string) => ledgers(teamName, laneId),
      } as never,
      proof: {
        applyDestinationProof: async () => ({ ledgerRecord: null, visibleReply: null }) as never,
        materializePlainTextReplyIfNeeded: async () => ({ ledgerRecord: null, visibleReply: null }) as never,
      },
      permissions: { syncAfterDelivery: async () => undefined },
      pidMemory: { rememberRuntimePidFromBridge: async () => undefined },
      bootstrap: {
        resolveTrackedBootstrapRunId: async () => 'run-1',
        hasCommittedBootstrapSession: async () => true,
      },
      lanes: { recoverLanesForWatchdog: async () => [] },
      stoppedLanes: { stopLanesForStoppedTeam: async () => 0 },
      readInboxMessages: async () => inbox,
      canDeliverToTeamRuntime: () => options.canDeliver !== false,
      hasAcceptedMemberWorkSyncReport: async () => false,
      hasAcknowledgedInbound: async () => false,
      logPromptDeliveryEvent: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      nowIso: () => '2026-11-02T10:00:00.000Z',
      sleep: async () => undefined,
      getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    }),
    ledger: ledgers(TEAM, LANE),
  };
}

describe('native delivery watchdog', () => {
  it('wakes an unread prompt that has no record instead of rebuilding it', async () => {
    const { watchdog, ledger } = subject();

    const scheduledCount = await watchdog.scanContinuity(TEAM);

    expect(scheduledCount).toBe(1);
    expect(scheduled).toEqual([
      { teamName: TEAM, memberName: MEMBER, messageId: PROMPT_ID },
    ]);
    await expect(
      ledger.getByInboxMessage({
        teamName: TEAM,
        memberName: MEMBER,
        laneId: LANE,
        inboxMessageId: PROMPT_ID,
      })
    ).resolves.toBeNull();
  });

  it('rebuilds the record at startup, so a lost delivery stays visible', async () => {
    const { watchdog, ledger } = subject();

    await watchdog.scan(TEAM);

    await expect(
      ledger.getByInboxMessage({
        teamName: TEAM,
        memberName: MEMBER,
        laneId: LANE,
        inboxMessageId: PROMPT_ID,
      })
    ).resolves.not.toBeNull();
  });

  it('does nothing while the team has no runtime to deliver to', async () => {
    const { watchdog } = subject({ canDeliver: false });

    await expect(watchdog.scanContinuity(TEAM)).resolves.toBe(0);
    expect(scheduled).toEqual([]);
  });
});
