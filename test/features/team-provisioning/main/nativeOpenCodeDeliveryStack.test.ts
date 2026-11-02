// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { createNativeSecondaryRuntimeRunStore } from '../../../../src/features/team-provisioning/main/adapters/output/NativeSecondaryRuntimeRunStore';
import { createNativeOpenCodeDeliveryStack } from '../../../../src/features/team-provisioning/main/composition/createNativeOpenCodeDeliveryStack';

import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime/TeamRuntimeAdapter';

const adapter = {
  providerId: 'opencode',
  launch: async () => ({}) as never,
  reconcile: async () => ({}) as never,
  stop: async () => ({}) as never,
  prepare: async () => ({}) as never,
  sendMessageToMember: async () => ({}) as never,
} as unknown as TeamLaunchRuntimeAdapter;

function sources(overrides: Record<string, unknown> = {}) {
  return {
    teamsBasePath: 'C:/TEST-teams',
    launchState: { read: async () => null, write: async () => ({}) as never },
    isTeamAlive: () => true,
    runs: createNativeSecondaryRuntimeRunStore(),
    openCodeAdapter: () => adapter,
    messageAdapter: () => adapter,
    config: { read: async () => null },
    teamMeta: { getMeta: async () => null },
    membersMeta: { getMeta: async () => null },
    inbox: { getMessagesFor: async () => [] },
    readInbox: async () => [],
    readTasks: async () => [],
    queue: { run: async (_team: string, operation: () => Promise<unknown>) => operation() },
    controlUrlResolver: () => async () => null,
    stoppingTeams: { has: () => false },
    isMemberLifecycleOperationActive: () => false,
    readPersistedTeamProjectPath: () => null,
    readRun: () => undefined,
    resolveOpenCodeInboxAttachmentPayloads: async () => ({ payloads: [], diagnostics: [] }),
    hasAcceptedMemberWorkSyncReport: async () => true,
    hasAcknowledgedInbound: async () => true,
    permissionListingAdapter: () => null,
    syncToolApprovals: () => undefined,
    emitRuntimeDeliveryReplyAdvisoryRefresh: () => undefined,
    emitTeamChange: () => undefined,
    emitMemberSpawnChange: () => undefined,
    emitPromptDeliveryTaskLogChange: () => undefined,
    invalidateRuntimeSnapshotCaches: () => undefined,
    logPromptDeliveryEvent: () => undefined,
    logger: { info: () => undefined, warn: () => undefined, debug: () => undefined },
    ...overrides,
  } as unknown as Parameters<typeof createNativeOpenCodeDeliveryStack>[0];
}

describe('native delivery stack', () => {
  it('binds the messaging surface to the service it built', () => {
    const stack = createNativeOpenCodeDeliveryStack(sources());

    expect(typeof stack.deliveryPort.relayOpenCodeMemberInboxMessages).toBe('function');
    expect(typeof stack.deliveryPort.getOpenCodeRuntimeDeliveryStatus).toBe('function');
    expect(typeof stack.deliver).toBe('function');
  });

  it('answers the scan passes from the same adapters the delivery path uses', () => {
    const stack = createNativeOpenCodeDeliveryStack(sources());

    expect(stack.watchdogDeps.identity).toBeDefined();
    expect(stack.watchdogDeps.proof).toBeDefined();
    expect(stack.watchdogDeps.ledgers.open('TEST-team', 'lane-1')).toBeDefined();
    expect(stack.watchdogDeps.canDeliverToTeamRuntime('TEST-team')).toBe(true);
  });

  it('stops delivering when the runtime holds no OpenCode adapter', () => {
    const stack = createNativeOpenCodeDeliveryStack(sources({ openCodeAdapter: () => null }));

    expect(stack.watchdogDeps.canDeliverToTeamRuntime('TEST-team')).toBe(false);
  });

  it('keeps one wake scheduler for the whole app', () => {
    const stack = createNativeOpenCodeDeliveryStack(sources());

    expect(stack.scheduler).toBe(stack.watchdogDeps.scheduler);
  });
});
