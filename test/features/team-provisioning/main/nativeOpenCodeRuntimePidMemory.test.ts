// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNativeOpenCodeRuntimePidMemory } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeRuntimePidMemory';
import { createPersistedLaunchSnapshot } from '../../../../src/main/services/team/TeamLaunchStateEvaluator';
import { TeamLaunchStateStore } from '../../../../src/main/services/team/TeamLaunchStateStore';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

const TEAM = 'alpha';
const MEMBER = 'dev';
const LANE = 'primary';
const NOW = '2026-11-02T10:00:00.000Z';

let claudeBase = '';
let store: TeamLaunchStateStore;
let command = 'opencode serve --port 4444';
let invalidate: ReturnType<typeof vi.fn>;
let emit: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  claudeBase = await mkdtemp(join(tmpdir(), 'native-pid-'));
  setClaudeBasePathOverride(claudeBase);
  await mkdir(join(claudeBase, 'teams', TEAM), { recursive: true });
  store = new TeamLaunchStateStore();
  command = 'opencode serve --port 4444';
  invalidate = vi.fn();
  emit = vi.fn();

  await store.write(
    TEAM,
    createPersistedLaunchSnapshot({
      teamName: TEAM,
      expectedMembers: [MEMBER],
      members: {
        [MEMBER]: {
          name: MEMBER,
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: NOW,
          laneId: LANE,
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          providerId: 'opencode',
          runtimeRunId: 'run-1',
        },
      },
      updatedAt: NOW,
    }),
    { runId: 'run-1', republishesExistingLaunch: true, authorizesNewRun: () => true }
  );
});

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await rm(claudeBase, { recursive: true, force: true });
});

function subject() {
  return createNativeOpenCodeRuntimePidMemory({
    store,
    invalidateRuntimeSnapshotCaches: invalidate,
    emitTeamChange: emit,
    logDebug: () => undefined,
    now: () => NOW,
    readProcessCommand: () => command,
  });
}

function readMemberPid() {
  return store.read(TEAM).then((snapshot) => snapshot?.members?.[MEMBER]?.runtimePid ?? null);
}

describe('native runtime pid memory', () => {
  it('records the pid of a bridge process that is still an opencode host', async () => {
    await subject().rememberRuntimePidFromBridge({
      teamName: TEAM,
      memberName: MEMBER,
      laneId: LANE,
      runId: 'run-1',
      runtimePid: 4242,
      reason: 'bridge_launch',
    });

    expect(await readMemberPid()).toBe(4242);
    expect(invalidate).toHaveBeenCalledWith(TEAM);
    expect(emit).toHaveBeenCalled();
  });

  it('refuses a pid that now belongs to some other process', async () => {
    command = '/usr/bin/node unrelated-script.js';

    await subject().rememberRuntimePidFromBridge({
      teamName: TEAM,
      memberName: MEMBER,
      laneId: LANE,
      runId: 'run-1',
      runtimePid: 4242,
      reason: 'bridge_launch',
    });

    expect(await readMemberPid()).toBeNull();
    expect(emit).not.toHaveBeenCalled();
  });

  it('ignores a pid the bridge never sent', async () => {
    await subject().rememberRuntimePidFromBridge({
      teamName: TEAM,
      memberName: MEMBER,
      laneId: LANE,
      runId: 'run-1',
      reason: 'bridge_launch',
    });

    expect(await readMemberPid()).toBeNull();
  });
});
