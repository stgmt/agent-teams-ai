// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNativeOpenCodeDeliveryReadCommitPolicy } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeDeliveryReadCommit';
import { createNativeOpenCodeLedgerTransitions } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeLedgerTransitions';
import { createNativeOpenCodeMemberIdentity } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeMemberIdentity';
import { createNativeOpenCodeMemberInboxRelay } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeMemberInboxRelay';
import { createNativeOpenCodeVisibleReplyProof } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeVisibleReplyProof';
import { TeamInboxReader } from '../../../../src/main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type {
  OpenCodeMemberInboxDelivery,
  OpenCodeMemberMessageDeliveryInput,
} from '../../../../src/main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { TeamConfig } from '../../../../src/shared/types';

const teamName = 'alpha';
const memberName = 'builder';
const created: string[] = [];
let claudeBase = '';

const config: TeamConfig = {
  name: 'Alpha',
  projectPath: '/TEST/alpha',
  members: [
    { name: 'team-lead', agentType: 'team-lead', providerId: 'opencode' } as never,
    { name: memberName, agentType: 'general-purpose', providerId: 'opencode' } as never,
  ],
} as never;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-relay-'));
  created.push(root);
  claudeBase = root;
  setClaudeBasePathOverride(root);
});

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function build(
  deliver: (
    input: OpenCodeMemberMessageDeliveryInput
  ) => OpenCodeMemberInboxDelivery | Promise<OpenCodeMemberInboxDelivery>
) {
  const teamsBasePath = join(claudeBase, 'teams');
  const identity = createNativeOpenCodeMemberIdentity({
    teamsBasePath,
    readConfig: async () => config,
    readTeamMeta: async () => null,
    readMetaMembers: async () => [],
    readSecondaryRuntimeRuns: async () => [],
    getCurrentOpenCodeRuntimeRunId: () => null,
  });
  const logging = {
    info: () => undefined,
    logPromptDeliveryEvent: () => undefined,
  };
  const ledgerTransitions = createNativeOpenCodeLedgerTransitions({
    logging,
    nowIso: () => '2026-11-01T00:05:00.000Z',
  });
  const visibleReplyProof = createNativeOpenCodeVisibleReplyProof({
    readConfig: async () => config,
    emitRuntimeDeliveryReplyAdvisoryRefresh: () => undefined,
    warn: () => undefined,
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    nowIso: () => '2026-11-01T00:05:00.000Z',
  });
  const readCommitPolicy = createNativeOpenCodeDeliveryReadCommitPolicy({
    hasAcceptedMemberWorkSyncReport: async () => false,
  });
  const delivered: OpenCodeMemberMessageDeliveryInput[] = [];
  const wakes: string[] = [];
  const relay = createNativeOpenCodeMemberInboxRelay({
    teamsBasePath,
    identity,
    ledgerTransitions,
    visibleReplyProof,
    readCommitPolicy,
    deliverOpenCodeMemberMessage: async (_team, input) => {
      delivered.push(input);
      return deliver(input);
    },
    scheduleOpenCodeMemberInboxDeliveryWake: (input) => wakes.push(input.messageId),
    resolveOpenCodeInboxAttachmentPayloads: async () => ({ ok: true }),
    readTaskRefInferenceTasks: async () => [],
    logOpenCodePromptDeliveryEvent: () => undefined,
    suppressRuntimeInactiveWarning: () => true,
    logWarning: () => undefined,
    nowIso: () => '2026-11-01T00:05:00.000Z',
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
  });
  return { relay, delivered, wakes };
}

describe('native OpenCode member inbox relay', () => {
  it('delivers an unread member row to the lane and then marks it read', async () => {
    const writer = new TeamInboxWriter();
    await writer.sendMessage(teamName, {
      member: memberName,
      from: 'team-lead',
      text: 'Please fix the parser crash on empty input.',
      messageId: 'msg-1',
      timestamp: '2026-11-01T00:00:00.000Z',
    });
    const { relay, delivered } = build(() => ({
      delivered: true,
      accepted: true,
      responsePending: false,
      ledgerStatus: 'responded',
      laneId: 'primary',
      visibleReplyMessageId: 'reply-1',
    }));

    const result = await relay.relayOpenCodeMemberInboxMessages(teamName, memberName);

    expect(result.delivered).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain('parser crash');
    const rows = await new TeamInboxReader().getMessagesFor(teamName, memberName);
    expect(rows.find((row) => row.messageId === 'msg-1')?.read).toBe(true);
  });

  it('leaves the row unread when the runtime refuses the prompt', async () => {
    const writer = new TeamInboxWriter();
    await writer.sendMessage(teamName, {
      member: memberName,
      from: 'team-lead',
      text: 'Please fix the parser crash on empty input.',
      messageId: 'msg-2',
      timestamp: '2026-11-01T00:00:00.000Z',
    });
    const { relay, delivered } = build(() => ({
      delivered: false,
      reason: 'opencode_runtime_message_bridge_unavailable',
    }));

    const result = await relay.relayOpenCodeMemberInboxMessages(teamName, memberName);

    expect(delivered).toHaveLength(1);
    expect(result.delivered).toBe(0);
    const rows = await new TeamInboxReader().getMessagesFor(teamName, memberName);
    expect(rows.find((row) => row.messageId === 'msg-2')?.read).toBe(false);
  });

  it('keeps the row unread while the lane has accepted the prompt but not answered', async () => {
    const writer = new TeamInboxWriter();
    await writer.sendMessage(teamName, {
      member: memberName,
      from: 'team-lead',
      text: 'Please fix the parser crash on empty input.',
      messageId: 'msg-4',
      timestamp: '2026-11-01T00:00:00.000Z',
    });
    const { relay, delivered } = build(() => ({
      delivered: true,
      accepted: true,
      responsePending: true,
      ledgerStatus: 'accepted',
      laneId: 'primary',
    }));

    const result = await relay.relayOpenCodeMemberInboxMessages(teamName, memberName);

    expect(delivered).toHaveLength(1);
    // Acceptance is not an answer: the row stays unread until a reply appears.
    expect(result.delivered).toBe(0);
    expect(result.lastDelivery?.responsePending).toBe(true);
    const rows = await new TeamInboxReader().getMessagesFor(teamName, memberName);
    expect(rows.find((row) => row.messageId === 'msg-4')?.read).toBe(false);
  });

  it('does not touch the inbox of a member that is not on an OpenCode lane', async () => {
    const writer = new TeamInboxWriter();
    await writer.sendMessage(teamName, {
      member: 'reviewer',
      from: 'team-lead',
      text: 'Please review the parser change.',
      messageId: 'msg-3',
      timestamp: '2026-11-01T00:00:00.000Z',
    });
    const { relay, delivered } = build(() => ({
      delivered: true,
      accepted: true,
    }));

    const result = await relay.relayOpenCodeMemberInboxMessages(teamName, 'reviewer');

    expect(delivered).toEqual([]);
    expect(result.delivered).toBe(0);
    const rows = await new TeamInboxReader().getMessagesFor(teamName, 'reviewer');
    expect(rows.find((row) => row.messageId === 'msg-3')?.read).toBe(false);
  });
});
