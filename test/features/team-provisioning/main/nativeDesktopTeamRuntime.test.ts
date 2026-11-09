// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamLifecycleCommands } from '../../../../src/features/team-provisioning/core/application/commands/TeamLifecycleCommands';
import { NativeLeadInboxRelay } from '../../../../src/features/team-provisioning/main/adapters/output/NativeLeadInboxRelay';
import { NativeMemberInboxRelay } from '../../../../src/features/team-provisioning/main/adapters/output/NativeMemberInboxRelay';
import { createNativeDesktopTeamRuntime } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';
import { createNativeTeamProvisioningApis } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamProvisioningApis';
import { NativeTeamConfigStore } from '../../../../src/features/team-provisioning/main/infrastructure/NativeTeamConfigStore';
import { claimTeamForThisProfile, createTeamProfileOwnership } from '../../../../src/main/services/team/provisioning/TeamProvisioningProfileOwnership';

import type { NativeDesktopTeamRuntimeDependencies } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';
import type { TeamLaunchRuntimeAdapter } from '../../../../src/main/services/team/runtime';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 20 }))
  );
});

function setup(
  registry?: { has: (id: string) => boolean; get: (id: string) => unknown },
  options: {
    teamsRoot?: string;
    listTeamNames?: () => Promise<readonly string[]>;
    relayIntervalMs?: number;
    profileOwnership?: NativeDesktopTeamRuntimeDependencies['profileOwnership'];
  } = {}
) {
  const deps: NativeDesktopTeamRuntimeDependencies = {
    owner,
    currentContext: () => owner,
    teamsRoot: options.teamsRoot ?? 'C:/TEST/teams',
    settings: {
      metadata: { getMeta: async () => null },
      members: { getMeta: async () => null },
    } as never,
    provider: {} as never,
    runtimeRoot: 'C:/TEST/runtime',
    workspaceRoot: 'C:/TEST/workspace',
    mcp: {} as never,
    inbox: {} as never,
    controlUrl: async () => 'http://127.0.0.1:1',
    briefing: async () => 'TEST briefing',
    readStartupTasks: async () => [],
    createController: () => ({
      taskBoard: { deliverStartupWorkAsync: async () => ({ delivered: [], skipped: [] }) },
    }),
    invalidate: () => undefined,
    contextInvalidationSignal: () => new AbortController().signal,
    withExpectedContext: async (_expected, operation) => operation(),
    ...(registry ? { runtimeAdapterRegistry: registry as never } : {}),
    definitions: {
      create: async () => undefined,
      updateLaunchSettings: async () => undefined,
    },
    profileOwnership: options.profileOwnership ?? {
      isManagedByThisProfile: async () => true,
      isManagedByThisProfileSync: () => true,
    },
    claimTeam: async () => undefined,
    clearStoppedLaneStopBackoff: () => undefined,
    progressHistory: { findByRunId: async () => undefined },
    listTeamNames: options.listTeamNames ?? (async () => []),
    ...(options.relayIntervalMs !== undefined ? { relayIntervalMs: options.relayIntervalMs } : {}),
  };
  return createNativeDesktopTeamRuntime(deps);
}

describe('native desktop team runtime composition', () => {
  it('starts and stops both relay pollers through the composition', () => {
    const { lifecycle } = setup();
    const leadStart = vi.spyOn(NativeLeadInboxRelay.prototype, 'startPolling');
    const memberStart = vi.spyOn(NativeMemberInboxRelay.prototype, 'startPolling');
    const leadStop = vi.spyOn(NativeLeadInboxRelay.prototype, 'stopPolling');
    const memberStop = vi.spyOn(NativeMemberInboxRelay.prototype, 'stopPolling');
    lifecycle.startRelays('TEST-team', 250);
    expect(leadStart).toHaveBeenCalledWith('TEST-team', 250);
    expect(memberStart).toHaveBeenCalledWith('TEST-team', 250);
    lifecycle.stopRelays('TEST-team');
    expect(leadStop).toHaveBeenCalledWith('TEST-team');
    expect(memberStop).toHaveBeenCalledWith('TEST-team');
    vi.restoreAllMocks();
  });

  it('starts relays after a successful configured launch', async () => {
    const { lifecycle } = setup(undefined, { relayIntervalMs: 250 });
    const run = { ...owner, teamName: 'TEST-team', runId: 'TEST-run' };
    const launch = vi
      .spyOn(TeamLifecycleCommands.prototype, 'launchConfigured')
      .mockResolvedValue({ run, leadCredential: 'TEST-credential' });
    const leadStart = vi.spyOn(NativeLeadInboxRelay.prototype, 'startPolling');
    const memberStart = vi.spyOn(NativeMemberInboxRelay.prototype, 'startPolling');
    await lifecycle.launchConfigured(run);
    expect(leadStart).toHaveBeenCalledWith(run.teamName, 250);
    expect(memberStart).toHaveBeenCalledWith(run.teamName, 250);
    launch.mockRestore();
    vi.restoreAllMocks();
  });

  it('rejects an invalid relay polling interval before composing', () => {
    expect(() => setup(undefined, { relayIntervalMs: -1 })).toThrow('positive integer');
    expect(() => setup(undefined, { relayIntervalMs: 1.5 })).toThrow('positive integer');
  });

  it('assembles the IPC surface from the real native runtime composition', async () => {
    const native = setup();
    const apis = createNativeTeamProvisioningApis({
      runtime: native,
      preflight: {
        getCliHelpOutput: async () => 'help',
        prepareForProvisioning: async () => ({}) as never,
      },
      taskActivity: { repairStaleTaskActivityIntervalsBeforeSnapshot: async () => undefined },
      recipientSources: {
        readConfigSnapshot: async () => null,
        readMembersMeta: async () => [],
      },
      now: () => '2026-10-31T00:00:00.000Z',
    });
    expect(Object.keys(apis)).toHaveLength(11);
    await expect(apis.runtime.getRuntimeState('TEST-team')).resolves.toMatchObject({
      teamName: 'TEST-team',
      isAlive: false,
    });
    expect(apis.messaging.getCurrentLeadSessionId('TEST-team')).toBeNull();
  });

  it('assembles lifecycle and runtime reads without a production owner switch', async () => {
    const { lifecycle, runtime, logs } = setup();
    expect(lifecycle.runs.aliveTeamNames()).toEqual([]);
    expect(lifecycle.runs.aliveRunId('TEST-team')).toBeNull();
    await expect(runtime.getRuntimeState('TEST-team')).resolves.toEqual({
      teamName: 'TEST-team',
      isAlive: false,
      runId: null,
      progress: null,
    });
    expect(runtime.hasProvisioningRun('TEST-team')).toBe(false);
    expect(runtime.getAliveTeams()).toEqual([]);
    await expect(lifecycle.recoverOrphanedRuns([])).resolves.toEqual({ recovered: [], failed: [] });
    expect(logs.read('TEST-team')).toMatchObject({ lines: [], total: 0, hasMore: false });
  });

  it('selects the OpenCode adapter from the startup registry', () => {
    const adapter = { launch: vi.fn() } as unknown as TeamLaunchRuntimeAdapter;
    const has = vi.fn((providerId: string) => providerId === 'opencode');
    const get = vi.fn((providerId: string) => {
      if (providerId !== 'opencode') throw new Error('unexpected provider');
      return adapter;
    });
    setup({ has, get });
    expect(has).toHaveBeenCalledWith('opencode');
    expect(get).toHaveBeenCalledWith('opencode');
  });

  it('keeps the registry untouched when the OpenCode entry is absent', () => {
    const has = vi.fn(() => false);
    const get = vi.fn();
    setup({ has, get });
    expect(has).toHaveBeenCalledWith('opencode');
    expect(get).not.toHaveBeenCalled();
  });

  it('clears an orphaned native claim during startup recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'TEST-native-desktop-'));
    directories.push(root);
    const teamsRoot = join(root, 'teams');
    await mkdir(join(teamsRoot, 'test-team'), { recursive: true });
    const store = new NativeTeamConfigStore(teamsRoot);
    await store.mutate('test-team', new AbortController().signal, async () => ({
      name: 'test-team',
      appManagedRun: {
        identity: {
          appInstanceId: 'TEST-old-app',
          dataRootFingerprint: 'TEST-root',
          connectionGeneration: 1,
          teamName: 'test-team',
          runId: 'TEST-old-run',
        },
        configurationRevision: 'TEST-revision',
      },
    }));
    await mkdir(join(teamsRoot, 'foreign-team'), { recursive: true });
    await store.mutate('foreign-team', new AbortController().signal, async () => ({
      name: 'foreign-team',
      appManagedRun: {
        identity: {
          appInstanceId: 'TEST-foreign-app',
          dataRootFingerprint: 'TEST-foreign-root',
          connectionGeneration: 1,
          teamName: 'foreign-team',
          runId: 'TEST-foreign-run',
        },
        configurationRevision: 'TEST-revision',
      },
    }));
    await claimTeamForThisProfile({ teamsBasePath: teamsRoot, teamName: 'test-team', reason: 'create', profileScope: 'TEST-own' });
    await claimTeamForThisProfile({ teamsBasePath: teamsRoot, teamName: 'foreign-team', reason: 'create', profileScope: 'TEST-foreign' });
    const { recoverStartup } = setup(undefined, {
      teamsRoot,
      listTeamNames: async () => ['test-team', 'foreign-team'],
      profileOwnership: createTeamProfileOwnership({
        isTrackedInThisProcess: () => false,
        getTeamsBasePath: () => teamsRoot,
        getProfileScope: () => 'TEST-own',
      }),
    });
    await expect(recoverStartup()).resolves.toEqual({ recovered: ['test-team'], failed: [] });
    const config = JSON.parse(
      await readFile(join(teamsRoot, 'test-team', 'config.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(config.appManagedRun).toBeUndefined();
    const foreign = JSON.parse(
      await readFile(join(teamsRoot, 'foreign-team', 'config.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(foreign.appManagedRun).toBeDefined();
  });
});
