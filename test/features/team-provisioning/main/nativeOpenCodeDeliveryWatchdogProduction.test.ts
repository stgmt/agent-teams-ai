// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeSecondaryRuntimeRunStore } from '../../../../src/features/team-provisioning/main/adapters/output/NativeSecondaryRuntimeRunStore';
import { createNativeOpenCodeDeliveryWatchdogProductionDeps } from '../../../../src/features/team-provisioning/main/composition/createNativeOpenCodeDeliveryWatchdogProduction';

import type { NativeOpenCodeDeliveryWatchdogProductionSources } from '../../../../src/features/team-provisioning/main/composition/createNativeOpenCodeDeliveryWatchdogProduction';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime/TeamRuntimeAdapter';

const adapter = {
  providerId: 'opencode',
  launch: async () => ({}) as never,
  reconcile: async () => ({}) as never,
  stop: async () => ({}) as never,
  prepare: async () => ({}) as never,
} as unknown as TeamLaunchRuntimeAdapter;

function sources(
  overrides: Partial<NativeOpenCodeDeliveryWatchdogProductionSources> = {}
): NativeOpenCodeDeliveryWatchdogProductionSources {
  return {
    teamsBasePath: 'C:/TEST-teams',
    launchState: { read: async () => null, write: async () => ({}) as never },
    isTeamAlive: () => true,
    adapterRegistry: { has: () => true, get: () => adapter as never },
    runs: createNativeSecondaryRuntimeRunStore(),
    openCodeAdapter: () => adapter,
    config: { read: async () => null },
    teamMeta: { getMeta: async () => null },
    membersMeta: { getMeta: async () => null },
    inbox: { getMessagesFor: async () => [] },
    queue: { run: async (_team, operation) => operation() },
    ledgers: () => ({ listDue: async () => [], markNextAttemptDeferred: async () => undefined }),
    scheduler: { isEnabled: () => true, schedule: () => undefined, isStaleError: () => false },
    hasAcceptedMemberWorkSyncReport: async () => false,
    hasAcknowledgedInbound: async () => true,
    emitRuntimeDeliveryReplyAdvisoryRefresh: () => undefined,
    emitTeamChange: () => undefined,
    emitMemberSpawnChange: () => undefined,
    invalidateRuntimeSnapshotCaches: () => undefined,
    syncToolApprovals: () => undefined,
    permissionListingAdapter: () => null,
    readPersistedTeamProjectPath: () => null,
    logPromptDeliveryEvent: () => undefined,
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    ...overrides,
  } as NativeOpenCodeDeliveryWatchdogProductionSources;
}

describe('production delivery supervisor', () => {
  it('answers every port the watchdog needs from the shell sources', async () => {
    const deps = createNativeOpenCodeDeliveryWatchdogProductionDeps(sources());

    expect(deps).toMatchObject({
      teamsBasePath: 'C:/TEST-teams',
      hasAcceptedMemberWorkSyncReport: expect.any(Function),
      hasAcknowledgedInbound: expect.any(Function),
    });
    await expect(
      deps.readInboxMessages('TEST-team', 'Builder')
    ).resolves.toEqual([]);
    expect(deps.canDeliverToTeamRuntime('TEST-team')).toBe(true);
    expect(deps.nowIso()).toMatch(/Z$/);
  });

  it('stops delivering when the team is not alive or the adapter is missing', () => {
    const dead = createNativeOpenCodeDeliveryWatchdogProductionDeps(sources({ isTeamAlive: () => false }));
    const noAdapter = createNativeOpenCodeDeliveryWatchdogProductionDeps(
      sources({ adapterRegistry: { has: () => false, get: () => adapter as never } })
    );

    expect(dead.canDeliverToTeamRuntime('TEST-team')).toBe(false);
    expect(noAdapter.canDeliverToTeamRuntime('TEST-team')).toBe(false);
  });

  it('opens the ledger through the shared factory it was given', () => {
    const open = vi.fn(() => ({}) as never);
    const deps = createNativeOpenCodeDeliveryWatchdogProductionDeps(sources({ ledgers: open }));

    expect(deps.ledgers.open('TEST-team', 'lane-1')).toBeDefined();
    expect(open).toHaveBeenCalledWith('TEST-team', 'lane-1');
  });
});
