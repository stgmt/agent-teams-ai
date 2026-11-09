// @vitest-environment node
import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BoundControlContext } from '../../../../src/features/external-agent-connection/main/BoundControlContext';
import { createNativeTeamLifecycle } from '../../../../src/features/team-provisioning/main/composition/createNativeTeamLifecycle';

import type { ConfiguredMemberLaunch } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const exec = promisify(execFile);
let root: string;
let repo: string;
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'TEST-native-team-workspace-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'README.md'), 'TEST selected local HEAD\n');
  await git(repo, 'add', 'README.md');
  await git(
    repo,
    '-c',
    'user.name=TEST',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-m',
    'TEST'
  );
  repo = await realpath(repo);
}, 60_000);

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}, 60_000);

async function setup(worktree: string, cwd = repo) {
  const teamsRoot = join(root, 'teams');
  const teamName = 'test-named-workspace';
  await mkdir(join(teamsRoot, teamName), { recursive: true });
  const explicit = join(root, 'TEST-explicit');
  await mkdir(explicit, { recursive: true });
  const configPath = join(teamsRoot, teamName, 'config.json');
  const context = new BoundControlContext('TEST-app', root);
  const request = { expectedContext: context.snapshot(), teamName };
  const launches: Readonly<ConfiguredMemberLaunch>[] = [];
  const configs: Record<string, unknown>[] = [];
  // РИСК: real Git/config ordering is covered; provider preparation ends before model CLI/authentication.
  const lifecycle = createNativeTeamLifecycle({
    owner: context.snapshot(),
    readStartupTasks: async () => [],
    createController: () => ({
      taskBoard: { deliverStartupWorkAsync: async () => ({ delivered: [], skipped: [] }) },
    }),
    runtimeRoot: join(root, 'attempts'),
    workspaceRoot: join(root, 'workspaces'),
    teamsRoot,
    settings: {
      metadata: {
        getMeta: () =>
          Promise.resolve({ version: 1, providerId: 'anthropic', cwd, worktree, createdAt: 1 }),
      },
      members: {
        getMeta: () =>
          Promise.resolve({
            version: 1,
            members: [
              { name: 'builder' },
              { name: 'isolated', isolation: 'worktree' },
              { name: 'explicit', cwd: explicit },
            ],
          }),
      },
    },
    provider: {
      prepareWorkspaceTrust: async (launch) => {
        launches.push(launch);
        configs.push(JSON.parse(await readFile(configPath, 'utf8')));
        return [];
      },
      executable: () => Promise.reject(new Error('TEST provider boundary')),
      environment: () => Promise.reject(new Error('TEST no authentication')),
      resolveIdentity: () => Promise.reject(new Error('TEST no identity')),
      runtimeArgs: () => Promise.reject(new Error('TEST no runtime arguments')),
    },
    mcp: {
      writeConfigFile: () => Promise.reject(new Error('TEST no MCP')),
      removeConfigFile: () => Promise.resolve(),
    },
    inbox: { sendMessage: () => Promise.reject(new Error('TEST no process registration')) },
    controlUrl: () => Promise.resolve('http://127.0.0.1:9999'),
    briefing: () => Promise.resolve('TEST'),
    invalidate: () => undefined,
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
  return { lifecycle, request, launches, configs, explicit, configPath, teamsRoot };
}

describe('named team workspace in native lifecycle composition', { timeout: 60_000 }, () => {
  it('resolves the team directory before config and provider, shares it with the lead, and preserves it across stop/relaunch', async () => {
    const { lifecycle, request, launches, configs, explicit, teamsRoot, configPath } =
      await setup('TEST-feature/topic');
    const receipts = await Promise.all([
      lifecycle.commands.launch(request),
      lifecycle.commands.launch(request),
    ]);
    expect(receipts[0]).toEqual(receipts[1]);
    let run = receipts[0].run;
    try {
      await expect.poll(() => launches.length, { timeout: 60_000 }).toBe(4);
      const lead = launches.find((launch) => launch.role === 'lead')!;
      const builder = launches.find((launch) => launch.memberName === 'builder')!;
      const isolated = launches.find((launch) => launch.memberName === 'isolated')!;
      expect(lead.workingDirectory).not.toBe(repo);
      expect(builder.workingDirectory).toBe(lead.workingDirectory);
      expect(builder.worktree).toEqual(lead.worktree);
      expect(isolated.baseWorkingDirectory).toBe(lead.workingDirectory);
      expect(isolated.worktree?.baseRepoPath).toBe(lead.workingDirectory);
      expect(isolated.workingDirectory).not.toBe(lead.workingDirectory);
      expect(launches.find((launch) => launch.memberName === 'explicit')?.workingDirectory).toBe(
        await realpath(explicit)
      );
      expect(new Set(launches.map((launch) => launch.taskLedgerProjectDirectory))).toEqual(
        new Set([join(teamsRoot, request.teamName, 'task-ledger-project')])
      );
      for (const config of configs) {
        expect(config.appManagedRun).toMatchObject({ identity: run });
        expect(config.members).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: 'team-lead', cwd: lead.workingDirectory }),
            expect.objectContaining({ name: 'builder', cwd: lead.workingDirectory }),
            expect.objectContaining({ name: 'explicit', cwd: explicit }),
          ])
        );
      }
      await writeFile(join(lead.workingDirectory, 'notes.txt'), 'TEST retained team work');
      await lifecycle.commands.stop({ ...request, runId: run.runId });
      expect(await readFile(join(lead.workingDirectory, 'notes.txt'), 'utf8')).toBe(
        'TEST retained team work'
      );
      expect(JSON.parse(await readFile(configPath, 'utf8')).appManagedRun).toBeUndefined();
      const next = await lifecycle.commands.launch(request);
      run = next.run;
      await expect.poll(() => launches.length, { timeout: 60_000 }).toBe(8);
      expect(launches.slice(4).find((launch) => launch.role === 'lead')?.workingDirectory).toBe(
        lead.workingDirectory
      );
      expect(
        (await git(repo, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)
      ).toHaveLength(3);
    } finally {
      await lifecycle.commands.stop({ ...request, runId: run.runId });
    }
  });

  it('stops a named allocation without provider/config admission and reuses its retained checkout only in a fresh run', async () => {
    const managed = join(root, 'workspaces');
    await mkdir(managed);
    const { lifecycle, request, launches, configPath } = await setup('TEST-cancelled-team');
    let stopping: Promise<void> | undefined;
    const watcher = watch(managed, (_event, name) => {
      if (!stopping && name?.toString().startsWith('team-test-named-workspace-')) {
        const run = lifecycle.snapshot(request.teamName).identity;
        stopping = lifecycle.commands.stop({ ...request, runId: run.runId });
        void stopping.catch(() => undefined);
      }
    });
    try {
      await expect(lifecycle.commands.launch(request)).rejects.toThrow();
      expect(stopping).toBeDefined();
      await stopping;
    } finally {
      watcher.close();
    }
    expect(launches).toHaveLength(0);
    await expect(readFile(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(lifecycle.snapshot(request.teamName)).toMatchObject({
      desired: 'stopped',
      resources: 'released',
    });
    expect((await git(repo, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(
      2
    );
    const next = await lifecycle.commands.launch(request);
    try {
      await expect.poll(() => launches.length, { timeout: 60_000 }).toBe(4);
      expect(
        (await git(repo, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)
      ).toHaveLength(3);
    } finally {
      await lifecycle.commands.stop({ ...request, runId: next.run.runId });
    }
  });

  it.each(['../outside', 'TEST-work'])(
    'does not prepare providers or runtime config when allocation rejects (%s)',
    async (name) => {
      const { lifecycle, request, launches, configPath } = await setup(name, root);
      await expect(lifecycle.commands.launch(request)).rejects.toThrow();
      expect(launches).toHaveLength(0);
      await expect(readFile(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(lifecycle.snapshot(request.teamName)).toMatchObject({
        state: 'failed',
        resources: 'released',
      });
    }
  );
});
