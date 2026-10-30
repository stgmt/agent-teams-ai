// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeDesktopTeamRuntime } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';

import type { NativeDesktopTeamRuntimeDependencies } from '../../../../src/features/team-provisioning/main/composition/createNativeDesktopTeamRuntime';
import type { TeamLaunchRuntimeAdapter } from '../../../../src/main/services/team/runtime';

const owner = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
};

function setup(registry?: { has: (id: string) => boolean; get: (id: string) => unknown }) {
  const deps: NativeDesktopTeamRuntimeDependencies = {
    owner,
    currentContext: () => owner,
    teamsRoot: 'C:/TEST/teams',
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
});
