// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativeTeamProvisioningGraph } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamProvisioningGraph';

import type { NativeTeamProvisioningGraphDependencies } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamProvisioningGraph';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 20 });
});

function build(teamsRoot: string, overrides: Partial<NativeTeamProvisioningGraphDependencies> = {}) {
  const sendMessage = vi.fn(async () => ({}) as never);
  const removeConfigFile = vi.fn(async () => undefined);
  const deps: NativeTeamProvisioningGraphDependencies = {
    stores: {
      teamsRoot,
      metadata: { getMeta: async () => null },
      members: { getMeta: async () => null },
      mcp: { writeConfigFile: async () => 'TEST-mcp.json' },
      inbox: { sendMessage },
      invalidate: () => undefined,
    },
    mcpConfig: { removeConfigFile },
    runtimeDeps: {
      owner,
      currentContext: () => owner,
      teamsRoot,
      readStartupTasks: async () => [],
      provider: {} as never,
      runtimeRoot: join(teamsRoot, 'runtime'),
      workspaceRoot: join(teamsRoot, 'workspace'),
      controlUrl: async () => 'http://127.0.0.1:1',
      briefing: async () => 'TEST briefing',
      invalidate: () => undefined,
      contextInvalidationSignal: () => new AbortController().signal,
      withExpectedContext: async (_expected, operation) => operation(),
      definitions: { create: async () => undefined, updateLaunchSettings: async () => undefined },
      progressHistory: { findByRunId: async () => undefined },
      listTeamNames: async () => [],
    },
    apisDeps: {
      taskActivity: { repairStaleTaskActivityIntervalsBeforeSnapshot: async () => undefined },
      now: () => '2026-11-02T00:00:00.000Z',
    },
    watchdogDeps: {
      teamsBasePath: teamsRoot,
      scheduler: {
        isEnabled: () => true,
        schedule: () => undefined,
        isStaleError: async () => false,
      },
      identity: {
        resolveMembersForRuntimeLane: async () => [],
        resolveCurrentOpenCodeRuntimeRunId: async () => null,
      },
      ledgers: { open: () => ({}) as never },
      proof: {} as never,
      permissions: { syncAfterDelivery: async () => undefined },
      pidMemory: { rememberRuntimePidFromBridge: async () => undefined },
      bootstrap: {
        resolveTrackedBootstrapRunId: async () => null,
        hasCommittedBootstrapSession: async () => false,
      },
      lanes: { recoverLanesForWatchdog: async () => [] },
      stoppedLanes: { stopLanesForStoppedTeam: async () => 0 },
      readInboxMessages: async () => [],
      canDeliverToTeamRuntime: () => false,
      hasAcceptedMemberWorkSyncReport: async () => false,
      hasAcknowledgedInbound: async () => false,
      logPromptDeliveryEvent: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      nowIso: () => '2026-11-02T00:00:00.000Z',
      sleep: async () => undefined,
      getErrorMessage: (error: unknown) => String(error),
    } as never,
    prepDeps: {
      provider: { environment: async () => ({}), executable: async () => '' } as never,
      runtimeAdapterRegistry: { has: () => false, get: () => undefined } as never,
      logger: { info: () => undefined, warn: () => undefined },
    },
    languageDeps: {
      readConfig: async () => null,
      writeLanguage: async () => undefined,
      getSystemLocale: () => 'en',
      resolveLanguageName: (code: string) => code,
      logger: { info: () => undefined, warn: () => undefined },
    },
    busyStatus: { getBusyStatus: async () => ({ busy: false }) as never },
    inboxRelay: {
      relayOpenCodeMemberInboxMessages: async () => ({ delivered: 0, diagnostics: [] }) as never,
    },
    ...overrides,
  };
  return { root: createNativeTeamProvisioningGraph(deps), sendMessage, removeConfigFile };
}

describe('production native graph', () => {
  it('answers the shell surface for a team that was never launched', async () => {
    const teamsRoot = mkdtempSync(join(tmpdir(), 'native-graph-'));
    directories.push(teamsRoot);
    const { root } = build(teamsRoot);

    await expect(root.getRuntimeState('TEST-team')).resolves.toMatchObject({
      teamName: 'TEST-team',
      isAlive: false,
      runId: null,
    });
    expect(root.getAliveTeamNames()).toEqual([]);
    expect(root.hasActiveTeamRuntimes()).toBe(false);
    expect(root.isTeamAlive('TEST-team')).toBe(false);
    expect(root.getCurrentRunId('TEST-team')).toBeNull();
    await expect(root.stopAllTeams()).resolves.toEqual([]);
  });

  it('runs the delivery sweep and the shutdown cancellation over an empty roster', async () => {
    const teamsRoot = mkdtempSync(join(tmpdir(), 'native-graph-'));
    directories.push(teamsRoot);
    const { root } = build(teamsRoot);

    await expect(root.scanOpenCodePromptDeliveryWatchdog('TEST-team')).resolves.toBeUndefined();
    await expect(
      root.cancelPendingRuntimeAdapterLaunchesForShutdown()
    ).resolves.toBeUndefined();
  });

  it('exposes the transport surface it built instead of a second one', async () => {
    const teamsRoot = mkdtempSync(join(tmpdir(), 'native-graph-'));
    directories.push(teamsRoot);
    const { root } = build(teamsRoot);

    expect(Object.keys(root.apis)).not.toHaveLength(0);
    expect(Object.keys(root)).toEqual(
      expect.arrayContaining([
        'apis',
        'createTeam',
        'launchTeam',
        'getAliveTeamNames',
        'hasActiveTeamRuntimes',
        'restartLeadRuntime',
        'assessLeadRuntimeRestart',
        'notifyLanguageChange',
        'hasLiveOpenCodeMcpConsumers',
      ])
    );
  });
});
