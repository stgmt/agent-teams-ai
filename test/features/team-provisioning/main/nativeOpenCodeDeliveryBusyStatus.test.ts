// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NativeOpenCodeDeliveryBusyStatus } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeDeliveryBusyStatus';
import { createNativeOpenCodeMemberIdentity } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeMemberIdentity';
import { createNativeOpenCodePromptDeliveryLedgerFactory } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodePromptDeliveryLedgerFactory';
import { getOpenCodeRuntimeLaneIndexPath } from '../../../../src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { TeamInboxReader } from '../../../../src/main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '../../../../src/main/services/team/TeamInboxWriter';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { TeamConfig } from '../../../../src/shared/types';

const teamName = 'alpha';
const memberName = 'builder';
const nowIso = '2026-11-01T00:05:00.000Z';
const created: string[] = [];
let teamsBasePath = '';

function config(providerId: string): TeamConfig {
  return {
    name: 'Alpha',
    projectPath: '/TEST/alpha',
    members: [
      { name: 'team-lead', agentType: 'team-lead', providerId } as never,
      { name: memberName, agentType: 'general-purpose', providerId } as never,
    ],
  } as never;
}

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-busy-status-'));
  created.push(root);
  teamsBasePath = join(root, 'teams');
  setClaudeBasePathOverride(root);
});

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await Promise.all(created.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeActiveLane(): Promise<void> {
  const path = getOpenCodeRuntimeLaneIndexPath(teamsBasePath, teamName);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      updatedAt: nowIso,
      lanes: { primary: { laneId: 'primary', state: 'active', updatedAt: nowIso } },
    }),
    'utf8'
  );
}

function busyStatus(providerId = 'opencode', recovery = false) {
  const identity = createNativeOpenCodeMemberIdentity({
    teamsBasePath,
    readConfig: async () => config(providerId),
    readTeamMeta: async () => null,
    readMetaMembers: async () => [],
    readSecondaryRuntimeRuns: async () => [],
    getCurrentOpenCodeRuntimeRunId: () => null,
  });
  const scheduleWake = vi.fn(() => undefined);
  const subject = new NativeOpenCodeDeliveryBusyStatus({
    teamsBasePath,
    identity,
    inbox: new TeamInboxReader(),
    recoverLaneForConfiguredMemberBeforeDelivery: async () => recovery,
    recoverLaneAndVerifyActive: async () => recovery,
    createLedger: createNativeOpenCodePromptDeliveryLedgerFactory(teamsBasePath),
    scheduleWake,
  });
  return { subject, scheduleWake };
}

describe('native OpenCode delivery busy status', () => {
  it('reports a free member once the lane is active and nothing is in flight', async () => {
    await writeActiveLane();
    const { subject } = busyStatus();

    await expect(
      subject.getBusyStatus({ teamName, memberName, nowIso })
    ).resolves.toEqual({ busy: false });
  });

  it('reports an unread foreground message as busy and arms its delivery', async () => {
    await writeActiveLane();
    await new TeamInboxWriter().sendMessage(teamName, {
      member: memberName,
      from: 'team-lead',
      text: 'Please review the payment retry loop.',
      messageId: 'msg-unread',
      timestamp: nowIso,
    });
    const { subject, scheduleWake } = busyStatus();

    const status = await subject.getBusyStatus({ teamName, memberName, nowIso });

    expect(status).toMatchObject({
      busy: true,
      reason: 'opencode_foreground_inbox_unread',
      activeMessageId: 'msg-unread',
    });
    expect(scheduleWake).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'msg-unread', delayMs: 500 })
    );
  });

  it('treats a member outside OpenCode as free', async () => {
    const { subject } = busyStatus('claude');

    await expect(
      subject.getBusyStatus({ teamName, memberName, nowIso })
    ).resolves.toEqual({ busy: false });
  });

  it('stays busy while no lane evidence proves the member can be reached', async () => {
    const { subject } = busyStatus('opencode', false);

    const status = await subject.getBusyStatus({ teamName, memberName, nowIso });

    expect(status).toMatchObject({ busy: true, reason: 'opencode_no_active_lane' });
  });
});
