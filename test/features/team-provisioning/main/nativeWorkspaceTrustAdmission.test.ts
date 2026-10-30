// @vitest-environment node
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { createNativeTeamLifecycle } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamLifecycle';
import { createNativeWorkspaceTrust } from '../../../../src/features/workspace-trust/main/composition/createNativeWorkspaceTrust';

import type { NativeWorkspaceTrustPreparation } from '../../../../src/features/workspace-trust/main/composition/createNativeWorkspaceTrust';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))
  );
});

async function setup(prepareTrust?: NativeWorkspaceTrustPreparation['prepare']) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'TEST-native-trust-admission-')));
  directories.push(root);
  const home = join(root, 'TEST-home');
  const cwd = join(root, 'TEST-project');
  const teamsRoot = join(root, 'teams');
  const teamName = 'test-trust-team';
  await Promise.all([
    mkdir(home),
    mkdir(cwd),
    mkdir(join(teamsRoot, teamName), { recursive: true }),
  ]);
  const state = join(home, '.claude.json');
  const context = new BoundControlContext('TEST-app', root);
  const run = { ...context.snapshot(), teamName, runId: 'TEST-run' };
  // РИСК: this boundary stops before model execution; it is not real CLI/provider acceptance.
  const executable = vi.fn(() => Promise.reject(new Error('TEST stops before CLI or model calls')));
  const mcp = vi.fn(() => Promise.reject(new Error('Unexpected MCP allocation')));
  const workspaceTrust = prepareTrust
    ? { prepare: prepareTrust }
    : createNativeWorkspaceTrust({ homeDirectory: home, env: {} });
  const lifecycle = createNativeTeamLifecycle({
    owner: context.snapshot(),
    runtimeRoot: join(root, 'attempts'),
    workspaceRoot: join(root, 'workspaces'),
    teamsRoot,
    provider: {
      prepareWorkspaceTrust: (launch, signal) =>
        workspaceTrust.prepare('anthropic', launch.workingDirectory, signal),
      executable,
      environment: () => Promise.reject(new Error('Unexpected authentication')),
      resolveIdentity: () => Promise.reject(new Error('Unexpected model resolution')),
      runtimeArgs: () => Promise.reject(new Error('Unexpected runtime arguments')),
    },
    settings: {
      metadata: {
        getMeta: () => Promise.resolve({ version: 1, providerId: 'anthropic', cwd, createdAt: 1 }),
      },
      members: {
        getMeta: () => Promise.resolve({ version: 1, members: [] }),
      },
    },
    mcp: { writeConfigFile: mcp, removeConfigFile: () => Promise.resolve() },
    inbox: { sendMessage: () => Promise.reject(new Error('Unexpected member registration')) },
    controlUrl: () => Promise.resolve('http://127.0.0.1:9999'),
    briefing: () => Promise.resolve('TEST'),
    invalidate: vi.fn(),
    contextInvalidationSignal: (expected) => context.invalidationSignal(expected),
    withExpectedContext: async (expected, operation) => {
      const release = context.admit(expected);
      try {
        return await operation();
      } finally {
        release();
      }
    },
  });
  return {
    root,
    state,
    cwd,
    lifecycle,
    run,
    executable,
    mcp,
    config: join(teamsRoot, teamName, 'config.json'),
  };
}

describe('native lifecycle workspace trust ownership', () => {
  it('prepares the selected profile before any provider probing without exposing a second runtime owner', async () => {
    const { lifecycle, run, state, executable, mcp } = await setup();
    const query = { expectedContext: run, teamName: run.teamName };
    expect(await lifecycle.queries.snapshot(query)).toBeNull();
    const feed = await lifecycle.queries.watch(query);
    const preparing = feed.next();
    await lifecycle.launchConfigured(run);
    expect((await preparing).value?.identity).toEqual(run);
    await expect.poll(() => executable.mock.calls.length).toBe(1);
    expect(JSON.parse(await readFile(state, 'utf8')).projects).toBeDefined();
    expect(mcp).not.toHaveBeenCalled();
    await lifecycle.stopConfigured(run);
    expect(lifecycle.snapshot(run.teamName)).toMatchObject({
      state: 'stopped',
      resources: 'released',
    });
    expect(await lifecycle.queries.snapshot(query)).toEqual(lifecycle.snapshot(run.teamName));
    await feed.return();
  });

  it('records trust refusal in the authoritative snapshot and can release the run claim', async () => {
    const { lifecycle, run, state, executable, mcp, config } = await setup();
    await writeFile(state, '{ TEST malformed');
    await lifecycle.launchConfigured(run);
    await expect
      .poll(() => lifecycle.snapshot(run.teamName).members['team-lead'].phase)
      .toBe('failed');
    expect(lifecycle.snapshot(run.teamName).members['team-lead']).toMatchObject({
      process: null,
      resources: 'released',
      error: expect.any(String),
    });
    expect(executable).not.toHaveBeenCalled();
    expect(mcp).not.toHaveBeenCalled();
    expect(await readFile(state, 'utf8')).toBe('{ TEST malformed');
    await lifecycle.stopConfigured(run);
    expect(JSON.parse(await readFile(config, 'utf8')).appManagedRun).toBeUndefined();
  });

  it('waits for cancelled trust preparation, prevents late authentication, and admits a fresh run only after release', async () => {
    let finish!: () => void;
    const prepare = vi.fn<NativeWorkspaceTrustPreparation['prepare']>(
      () =>
        new Promise((resolve) => {
          finish = () => resolve([]);
        })
    );
    const { lifecycle, run, executable, mcp } = await setup(prepare);
    await lifecycle.launchConfigured(run);
    await expect.poll(() => prepare.mock.calls.length).toBe(1);
    const stopped = lifecycle.stopConfigured(run);
    await expect.poll(() => prepare.mock.calls[0][2].aborted).toBe(true);
    expect(lifecycle.snapshot(run.teamName).state).toBe('stopping');
    expect(executable).not.toHaveBeenCalled();
    finish();
    await stopped;
    expect(executable).not.toHaveBeenCalled();
    expect(mcp).not.toHaveBeenCalled();
    expect(lifecycle.snapshot(run.teamName)).toMatchObject({
      state: 'stopped',
      resources: 'released',
    });
    prepare.mockResolvedValue([]);
    const next = { ...run, runId: 'TEST-next' };
    await lifecycle.launchConfigured(next);
    await expect.poll(() => executable.mock.calls.length).toBe(1);
    await lifecycle.stopConfigured(next);
  });
});
