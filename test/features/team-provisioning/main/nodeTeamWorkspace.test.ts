// @vitest-environment node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeMemberRuntime } from '../../../../src/features/team-provisioning/main/adapters/output/NodeMemberRuntime';
import { NodeTeamWorkspace } from '../../../../src/features/team-provisioning/main/adapters/output/NodeTeamWorkspace';

import type { ConfiguredMemberLaunch } from '../../../../src/features/team-provisioning/core/application/ports/MemberRuntimePorts';

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

let root: string;
let repo: string;
let workspace: NodeTeamWorkspace;
let launch: ConfiguredMemberLaunch;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'TEST-team-workspace-'));
  repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init');
  await writeFile(join(repo, 'README.md'), 'TEST base\n');
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
  workspace = new NodeTeamWorkspace(join(root, 'workspaces'), () =>
    Promise.resolve(join(root, 'TEST-ledger'))
  );
  launch = {
    team: {
      appInstanceId: 'TEST-app',
      dataRootFingerprint: 'TEST-root',
      connectionGeneration: 1,
      teamName: 'test-team',
      runId: 'TEST-run',
    },
    memberName: 'builder',
    role: 'member',
    configurationRevision: 'TEST-revision',
    providerId: 'anthropic',
    model: null,
    workingDirectory: repo,
    baseWorkingDirectory: repo,
    isolation: 'worktree',
    instructions: 'TEST',
  };
}, 60_000);

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}, 60_000);

const signal = (): AbortSignal => new AbortController().signal;

describe('configured persistent team workspaces', { timeout: 60_000 }, () => {
  it('binds an explicit team ledger for a shared workspace instead of leaving it to the runtime path codec', async () => {
    const prepared = await workspace.prepare({ ...launch, isolation: undefined }, signal());
    expect(prepared).toMatchObject({
      workingDirectory: repo,
      taskLedgerProjectDirectory: join(root, 'TEST-ledger'),
    });
    expect(prepared.worktree).toBeUndefined();
  });

  it('rejects a relative ledger binding and waits for cancelled binding to settle', async () => {
    const invalid = new NodeTeamWorkspace(join(root, 'workspaces'), () =>
      Promise.resolve('relative')
    );
    await expect(invalid.prepare({ ...launch, isolation: undefined }, signal())).rejects.toThrow(
      'absolute'
    );
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = new NodeTeamWorkspace(
      join(root, 'workspaces'),
      () =>
        new Promise<string>((resolve) => {
          finish = () => resolve(join(root, 'TEST-ledger'));
          entered();
        })
    );
    const abort = new AbortController();
    const preparing = pending.prepare({ ...launch, isolation: undefined }, abort.signal);
    const rejected = expect(preparing).rejects.toThrow('TEST cancelled ledger');
    await started;
    abort.abort(new Error('TEST cancelled ledger'));
    finish();
    await rejected;
  });

  it('creates one registered worktree for concurrent requests and keeps every kind of local work on reuse', async () => {
    const [first, concurrent] = await Promise.all([
      workspace.prepare(launch, signal()),
      workspace.prepare(launch, signal()),
    ]);
    expect(concurrent).toEqual(first);
    expect(first.workingDirectory).not.toBe(repo);
    expect(first.worktree?.baseRepoPath).toBe(repo);
    await git(first.workingDirectory, 'switch', '-c', 'TEST-task');
    await writeFile(join(first.workingDirectory, 'README.md'), 'TEST staged\n');
    await git(first.workingDirectory, 'add', 'README.md');
    await writeFile(join(first.workingDirectory, 'README.md'), 'TEST unstaged\n');
    await writeFile(join(first.workingDirectory, 'notes.txt'), 'TEST untracked\n');
    const before = await git(first.workingDirectory, 'status', '--porcelain');
    const staged = await git(first.workingDirectory, 'diff', '--cached');
    const unstaged = await git(first.workingDirectory, 'diff');
    const reused = await workspace.prepare(launch, signal());
    expect(reused.workingDirectory).toBe(first.workingDirectory);
    expect(reused.worktree?.branchName).toBe('TEST-task');
    expect(await git(first.workingDirectory, 'status', '--porcelain')).toBe(before);
    expect(await git(first.workingDirectory, 'diff', '--cached')).toBe(staged);
    expect(await git(first.workingDirectory, 'diff')).toBe(unstaged);
    expect(await readFile(join(first.workingDirectory, 'notes.txt'), 'utf8')).toBe(
      'TEST untracked\n'
    );
  });

  it('validates each concurrent request independently instead of sharing another request workspace result', async () => {
    const foreign = join(root, 'foreign');
    await mkdir(foreign);
    const [valid, invalid] = await Promise.allSettled([
      workspace.prepare(launch, signal()),
      workspace.prepare({ ...launch, workingDirectory: foreign }, signal()),
    ]);
    expect(valid.status).toBe('fulfilled');
    expect(invalid.status).toBe('rejected');
  });

  it('validates an explicitly configured worktree against the team repository instead of creating or searching another path', async () => {
    const selected = join(root, 'selected');
    await git(repo, 'worktree', 'add', '-b', 'TEST-selected', selected, 'HEAD');
    const prepared = await workspace.prepare({ ...launch, workingDirectory: selected }, signal());
    expect(prepared.workingDirectory).toBe(await realpath(selected));
    expect(prepared.worktree?.branchName).toBe('TEST-selected');
    await expect(
      workspace.prepare({ ...launch, workingDirectory: join(root, 'missing') }, signal())
    ).rejects.toThrow();
  });

  it('rejects foreign repositories, nested directories and detached worktrees without changing them', async () => {
    const foreign = join(root, 'foreign');
    await mkdir(foreign);
    await git(foreign, 'init');
    await writeFile(join(foreign, 'README.md'), 'TEST foreign');
    await git(foreign, 'add', '.');
    await git(
      foreign,
      '-c',
      'user.name=TEST',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'TEST'
    );
    await expect(
      workspace.prepare({ ...launch, workingDirectory: foreign }, signal())
    ).rejects.toThrow('repository');
    const detached = join(root, 'detached');
    await git(repo, 'worktree', 'add', '--detach', detached, 'HEAD');
    await writeFile(join(detached, 'notes.txt'), 'TEST retained');
    await expect(
      workspace.prepare({ ...launch, workingDirectory: detached }, signal())
    ).rejects.toThrow('branch');
    const attached = join(root, 'attached');
    await git(repo, 'worktree', 'add', '-b', 'TEST-attached', attached, 'HEAD');
    await mkdir(join(attached, 'nested'));
    await expect(
      workspace.prepare({ ...launch, workingDirectory: join(attached, 'nested') }, signal())
    ).rejects.toThrow('root');
    expect(await readFile(join(detached, 'notes.txt'), 'utf8')).toBe('TEST retained');
  });

  it('reattaches the retained managed branch without resetting its committed work', async () => {
    const first = await workspace.prepare(launch, signal());
    await writeFile(join(first.workingDirectory, 'README.md'), 'TEST committed member work\n');
    await git(first.workingDirectory, 'add', 'README.md');
    await git(
      first.workingDirectory,
      '-c',
      'user.name=TEST',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'TEST member change'
    );
    const head = await git(first.workingDirectory, 'rev-parse', 'HEAD');
    await git(repo, 'worktree', 'remove', first.workingDirectory);
    await git(repo, 'tag', first.worktree!.branchName, 'HEAD');
    const restored = await workspace.prepare(launch, signal());
    expect(restored.worktree?.branchName).toBe(first.worktree?.branchName);
    expect(await git(restored.workingDirectory, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('does not conflate configured names that have the same readable slug', async () => {
    const first = await workspace.prepare({ ...launch, memberName: 'Builder' }, signal());
    const second = await workspace.prepare({ ...launch, memberName: 'builder' }, signal());
    expect(first.workingDirectory.toLowerCase()).not.toBe(second.workingDirectory.toLowerCase());
    expect(first.worktree?.branchName.toLowerCase()).not.toBe(
      second.worktree?.branchName.toLowerCase()
    );
  });

  it('requires absolute directories, a real Git base for isolation, and valid configured identity', async () => {
    await expect(
      workspace.prepare({ ...launch, baseWorkingDirectory: 'relative' }, signal())
    ).rejects.toThrow('absolute');
    await expect(
      workspace.prepare({ ...launch, baseWorkingDirectory: root, workingDirectory: root }, signal())
    ).rejects.toThrow();
    await expect(
      workspace.prepare({ ...launch, memberName: '../outside' }, signal())
    ).rejects.toThrow('identity');
    const abort = new AbortController();
    abort.abort();
    await expect(workspace.prepare(launch, abort.signal)).rejects.toThrow();
  });

  it('passes the resolved directory to an owned OS child and leaves member work intact after stop', async () => {
    const prepared = await workspace.prepare(launch, signal());
    const marker = join(prepared.workingDirectory, 'TEST-child.txt');
    // РИСК: Node proves OS cwd ownership and file preservation, not model/provider acceptance.
    const runtime = new NodeMemberRuntime(
      {
        prepare() {
          return Promise.resolve({
            executable: process.execPath,
            args: [
              '-e',
              "require('node:fs').writeFileSync('TEST-child.txt',process.cwd());setInterval(()=>{},1000)",
            ],
            cwd: prepared.workingDirectory,
            env: process.env,
          });
        },
      },
      async (_token, operation) => operation()
    );
    const child = await runtime.spawn(
      prepared,
      {
        ...launch.team,
        memberName: launch.memberName,
        generation: 1,
        operationId: 'TEST-start',
      },
      signal()
    );
    try {
      await expect
        .poll(async () => readFile(marker, 'utf8').catch(() => ''))
        .toBe(prepared.workingDirectory);
    } finally {
      await child.stop();
    }
    expect(await readFile(marker, 'utf8')).toBe(prepared.workingDirectory);
    expect((await workspace.prepare(launch, signal())).workingDirectory).toBe(
      prepared.workingDirectory
    );
  });

  it('does not execute repository checkout hooks while allocating a member worktree or change their configured path', async () => {
    const hooks = join(root, 'TEST-hooks');
    const marker = join(root, 'TEST-hook-ran');
    await mkdir(hooks);
    await writeFile(
      join(hooks, 'post-checkout'),
      '#!/bin/sh\nprintf TEST > "$TEST_TEAM_WORKSPACE_HOOK_MARKER"\n',
      { mode: 0o755 }
    );
    await git(repo, 'config', 'core.hooksPath', hooks.replaceAll('\\', '/'));
    const previous = process.env.TEST_TEAM_WORKSPACE_HOOK_MARKER;
    process.env.TEST_TEAM_WORKSPACE_HOOK_MARKER = marker;
    try {
      await workspace.prepare(launch, signal());
    } finally {
      if (previous === undefined) delete process.env.TEST_TEAM_WORKSPACE_HOOK_MARKER;
      else process.env.TEST_TEAM_WORKSPACE_HOOK_MARKER = previous;
    }
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(repo, 'config', '--get', 'core.hooksPath')).toBe(hooks.replaceAll('\\', '/'));
  });

  it('does not borrow Git directory selection from the parent process', async () => {
    const parent = join(root, 'TEST-parent-repository');
    await mkdir(parent);
    await git(parent, 'init');
    const keys = ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'] as const;
    const previous = keys.map((key) => [key, process.env[key]] as const);
    Object.assign(process.env, {
      GIT_DIR: join(parent, '.git'),
      GIT_COMMON_DIR: join(parent, '.git'),
      GIT_WORK_TREE: parent,
      GIT_INDEX_FILE: join(parent, '.git', 'TEST-index'),
    });
    let prepared: Readonly<ConfiguredMemberLaunch>;
    try {
      prepared = await workspace.prepare(launch, signal());
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(prepared.worktree?.baseRepoPath).toBe(repo);
    expect(await git(prepared.workingDirectory, 'rev-parse', '--show-toplevel')).toBe(
      prepared.workingDirectory.replaceAll('\\', '/')
    );
    expect(await git(parent, 'worktree', 'list', '--porcelain')).not.toContain(
      prepared.workingDirectory.replaceAll('\\', '/')
    );
  });

  it('validates shared directories without requiring Git or creating an isolated workspace', async () => {
    const shared = { ...launch, workingDirectory: root, isolation: undefined };
    expect(await workspace.prepare(shared, signal())).toMatchObject({
      workingDirectory: await realpath(root),
    });
    await expect(
      workspace.prepare({ ...shared, workingDirectory: join(root, 'missing') }, signal())
    ).rejects.toThrow();
  });
});
