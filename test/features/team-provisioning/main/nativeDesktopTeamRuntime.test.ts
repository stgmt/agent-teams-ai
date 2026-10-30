// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNativeDesktopTeamRuntime } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';
import { NativeTeamConfigStore } from '../../../../src/features/team-provisioning/main/infrastructure/NativeTeamConfigStore';

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
    invalidate: () => undefined,
    contextInvalidationSignal: () => new AbortController().signal,
    withExpectedContext: async (_expected, operation) => operation(),
    ...(registry ? { runtimeAdapterRegistry: registry as never } : {}),
    definitions: {
      create: async () => undefined,
      updateLaunchSettings: async () => undefined,
    },
    progressHistory: { findByRunId: async () => undefined },
    listTeamNames: options.listTeamNames ?? (async () => []),
  };
  return createNativeDesktopTeamRuntime(deps);
}

describe('native desktop team runtime composition', () => {
  it('assembles lifecycle and runtime reads without a production owner switch', async () => {
    const { lifecycle, runtime } = setup();
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
    await expect(lifecycle.recoverOrphanedRuns([])).resolves.toEqual([]);
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
    const { recoverStartup } = setup(undefined, {
      teamsRoot,
      listTeamNames: async () => ['test-team'],
    });
    await expect(recoverStartup()).resolves.toEqual(['test-team']);
    const config = JSON.parse(
      await readFile(join(teamsRoot, 'test-team', 'config.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(config.appManagedRun).toBeUndefined();
  });
});
