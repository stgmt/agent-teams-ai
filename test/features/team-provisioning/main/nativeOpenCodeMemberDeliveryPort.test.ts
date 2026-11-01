// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NativeTeamMessagingApi } from '../../../../src/features/team-provisioning/main/adapters/input/NativeTeamMessagingApi';
import { createNativeOpenCodeMemberDeliveryPort } from '../../../../src/features/team-provisioning/main/composition/createNativeOpenCodeMemberDeliveryPort';
import { TeamInboxReader } from '../../../../src/main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { OpenCodeMemberMessageDeliveryInput } from '../../../../src/main/services/team/opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { TeamConfig } from '../../../../src/shared/types';

const teamName = 'alpha';
const memberName = 'builder';
const created: string[] = [];
let teamsBasePath = '';

const config: TeamConfig = {
  name: 'Alpha',
  projectPath: '/TEST/alpha',
  members: [
    { name: 'team-lead', agentType: 'team-lead', providerId: 'opencode' } as never,
    { name: memberName, agentType: 'general-purpose', providerId: 'opencode' } as never,
  ],
} as never;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-delivery-port-'));
  created.push(root);
  teamsBasePath = join(root, 'teams');
  setClaudeBasePathOverride(root);
});

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function deliveryPort(delivered: OpenCodeMemberMessageDeliveryInput[]) {
  return createNativeOpenCodeMemberDeliveryPort({
    teamsBasePath,
    readConfig: async () => config,
    readInbox: async (team, inbox) =>
      (await new TeamInboxReader().getMessagesFor(team, inbox)) as never,
    readTasks: async () => [],
    deliverOpenCodeMemberMessage: async (_team, input) => {
      delivered.push(input);
      return {
        delivered: true,
        accepted: true,
        responsePending: false,
        ledgerStatus: 'responded',
        laneId: 'primary',
        visibleReplyMessageId: 'reply-1',
      };
    },
    scheduleOpenCodeMemberInboxDeliveryWake: () => undefined,
    resolveOpenCodeInboxAttachmentPayloads: async () => ({ ok: true }),
    logPromptDeliveryEvent: () => undefined,
    emitRuntimeDeliveryReplyAdvisoryRefresh: () => undefined,
    suppressRuntimeInactiveWarning: () => true,
    hasAcceptedMemberWorkSyncReport: async () => false,
    canDeliverToOpenCodeRuntimeForTeam: () => true,
    canAttemptCommittedOpenCodeSessionRecovery: () => true,
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: () => undefined,
    tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: async () => null,
    tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: async () => null,
    logger: { info: () => undefined, warn: () => undefined },
    now: () => '2026-11-01T00:05:00.000Z',
    getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
  });
}

function messaging(delivery: ReturnType<typeof deliveryPort>) {
  return new NativeTeamMessagingApi({
    runs: {
      find: (team: string) =>
        team === teamName ? ({ identity: { teamName } } as never) : undefined,
      isLive: () => true,
    } as never,
    settings: { findConfiguredMember: () => null } as never,
    liveLeadMessages: { read: () => [], push: () => undefined } as never,
    sendLeadMessage: async () => undefined,
    relayLeadInboxMessages: async () => 0,
    openCodeMemberDelivery: delivery,
  });
}

describe('native OpenCode delivery port', () => {
  it('relays a member prompt through the messaging surface and reports the delivery', async () => {
    await new TeamInboxWriter().sendMessage(teamName, {
      member: memberName,
      from: 'team-lead',
      text: 'Please fix the parser crash on empty input.',
      messageId: 'msg-1',
      timestamp: '2026-11-01T00:00:00.000Z',
    });
    const delivered: OpenCodeMemberMessageDeliveryInput[] = [];
    const api = messaging(deliveryPort(delivered));

    const result = await api.relayOpenCodeMemberInboxMessages(teamName, memberName);

    expect(result.delivered).toBe(1);
    expect(delivered[0]?.text).toContain('parser crash');
    const rows = await new TeamInboxReader().getMessagesFor(teamName, memberName);
    expect(rows.find((row) => row.messageId === 'msg-1')?.read).toBe(true);
  });

  it('answers delivery status for a message it never delivered as null', async () => {
    const api = messaging(deliveryPort([]));

    await expect(api.getOpenCodeRuntimeDeliveryStatus(teamName, 'msg-absent')).resolves.toBeNull();
  });
});
