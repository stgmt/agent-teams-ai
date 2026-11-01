// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNativeOpenCodeRuntimePermissionSync } from '../../../../src/features/team-provisioning/main/adapters/output/NativeOpenCodeRuntimePermissionSync';
import { createPersistedLaunchSnapshot } from '../../../../src/main/services/team/TeamLaunchStateEvaluator';
import { TeamLaunchStateStore } from '../../../../src/main/services/team/TeamLaunchStateStore';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

const TEAM = 'alpha';
const MEMBER = 'builder';
const LANE = 'secondary:opencode:builder';
const RUN = 'run-1';
const NOW = '2026-11-02T10:00:00.000Z';

let claudeBase = '';
let store: TeamLaunchStateStore;
let aliveRunId: string | null = RUN;
let pending: { permissions: unknown[]; diagnostics: string[] };
let approvals: unknown[];

beforeEach(async () => {
  claudeBase = await mkdtemp(join(tmpdir(), 'native-perms-'));
  setClaudeBasePathOverride(claudeBase);
  await mkdir(join(claudeBase, 'teams', TEAM), { recursive: true });
  store = new TeamLaunchStateStore();
  aliveRunId = RUN;
  pending = { permissions: [], diagnostics: [] };
  approvals = [];

  await store.write(
    TEAM,
    createPersistedLaunchSnapshot({
      teamName: TEAM,
      expectedMembers: [MEMBER],
      members: {
        [MEMBER]: {
          name: MEMBER,
          providerId: 'opencode',
          laneId: LANE,
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: NOW,
          runtimeRunId: RUN,
        },
      },
      updatedAt: NOW,
    }),
    { runId: RUN, republishesExistingLaunch: true, authorizesNewRun: () => true }
  );
});

afterEach(async () => {
  setClaudeBasePathOverride(null);
  await rm(claudeBase, { recursive: true, force: true });
});

function subject(options: { bridgeAvailable?: boolean } = {}) {
  const tail: Promise<unknown>[] = [];
  return createNativeOpenCodeRuntimePermissionSync({
    teamsBasePath: join(claudeBase, 'teams'),
    runs: { aliveRunId: () => aliveRunId },
    readConfig: async () => null,
    getPermissionListingAdapter: () =>
      options.bridgeAvailable === false
        ? null
        : ({ listRuntimePermissions: async () => pending } as never),
    store,
    syncToolApprovals: (input) => approvals.push(input),
    invalidateRuntimeSnapshotCaches: () => undefined,
    emitMemberSpawnChange: () => undefined,
    logger: { warn: () => undefined, debug: () => undefined },
    now: () => NOW,
    serializeLaunchStateUpdate: (_team, operation) => {
      const next = (tail[tail.length - 1] ?? Promise.resolve()).then(operation);
      tail.push(next.catch(() => undefined));
      return next;
    },
  });
}

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    teamName: TEAM,
    memberName: MEMBER,
    laneId: LANE,
    runId: RUN,
    cwd: '/TEST/alpha',
    sessionId: 'session-1',
    responseState: 'permission_blocked',
    ...overrides,
  };
}

function pendingIds() {
  return store
    .read(TEAM)
    .then((snapshot) => snapshot?.members?.[MEMBER]?.pendingPermissionRequestIds ?? []);
}

describe('native OpenCode permission sync after delivery', () => {
  it('records a pending approval request on the member it belongs to', async () => {
    pending = {
      permissions: [{ requestId: 'perm-1', sessionId: 'session-1', toolName: 'bash' }],
      diagnostics: [],
    };

    await subject().syncAfterDelivery(delivery());

    expect(await pendingIds()).toEqual(['perm-1']);
    expect(approvals).toHaveLength(1);
  });

  it('does nothing for a delivery that was not answered with a permission request', async () => {
    pending = {
      permissions: [{ requestId: 'perm-1', sessionId: 'session-1', toolName: 'bash' }],
      diagnostics: [],
    };

    await subject().syncAfterDelivery(delivery({ responseState: 'responded_plain_text' }));

    expect(await pendingIds()).toEqual([]);
    expect(approvals).toEqual([]);
  });

  it('ignores a request belonging to a run the team has already left', async () => {
    pending = {
      permissions: [{ requestId: 'perm-1', sessionId: 'session-1', toolName: 'bash' }],
      diagnostics: [],
    };
    aliveRunId = 'run-2';

    await subject().syncAfterDelivery(delivery());

    expect(await pendingIds()).toEqual([]);
    expect(approvals).toEqual([]);
  });

  it('records nothing when the bridge cannot list requests', async () => {
    pending = {
      permissions: [{ requestId: 'perm-1', sessionId: 'session-1', toolName: 'bash' }],
      diagnostics: [],
    };

    await subject({ bridgeAvailable: false }).syncAfterDelivery(delivery());

    expect(await pendingIds()).toEqual([]);
  });

  it('drops a listed request that answers a different session', async () => {
    pending = {
      permissions: [{ requestId: 'perm-1', sessionId: 'other-session', toolName: 'bash' }],
      diagnostics: [],
    };

    await subject().syncAfterDelivery(delivery());

    expect(await pendingIds()).toEqual([]);
    expect(approvals).toEqual([]);
  });
});
