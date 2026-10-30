// @vitest-environment node
import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NodeTeamWorkspace } from '../../../../src/features/team-provisioning/main/adapters/output/NodeTeamWorkspace';

const exec = promisify(execFile);
const directories: string[] = [];
let repo: string;
let root: string;
let workspace: NodeTeamWorkspace;
const signal = (): AbortSignal => new AbortController().signal;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'TEST-named-team-'));
  directories.push(root);
  repo = join(root, 'repo');
  await mkdir(repo);
  await git(repo, 'init');
  await git(repo, 'config', 'core.autocrlf', 'false');
  await writeFile(join(repo, 'README.md'), 'TEST original\n');
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
    Promise.resolve(join(root, 'ledger'))
  );
}, 60_000);

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))
  );
}, 60_000);

describe('application-owned named team workspace', { timeout: 60_000 }, () => {
  it('allocates one shared workspace from the selected local HEAD without altering the original repository', async () => {
    const head = await git(repo, 'rev-parse', 'HEAD');
    await writeFile(join(repo, 'README.md'), 'TEST staged original\n');
    await git(repo, 'add', 'README.md');
    await writeFile(join(repo, 'README.md'), 'TEST unstaged original\n');
    await writeFile(join(repo, 'notes.txt'), 'TEST untracked original\n');
    const before = await git(repo, 'status', '--porcelain');
    const staged = await git(repo, 'diff', '--cached');
    const changed = await git(repo, 'diff');
    const input = { teamName: 'test-team', workingDirectory: repo, worktreeName: 'feature/topic' };
    const [first, second] = await Promise.all([
      workspace.prepareTeam(input, signal()),
      workspace.prepareTeam(input, signal()),
    ]);
    expect(first).toEqual(second);
    expect(first.workingDirectory).not.toBe(repo);
    expect(first.worktree).toMatchObject({ baseRepoPath: repo });
    expect(await git(first.workingDirectory, 'rev-parse', 'HEAD')).toBe(head);
    expect(await git(first.workingDirectory, 'symbolic-ref', '--short', 'HEAD')).toBe(
      first.worktree?.branchName
    );
    expect(await git(repo, 'status', '--porcelain')).toBe(before);
    expect(await git(repo, 'diff', '--cached')).toBe(staged);
    expect(await git(repo, 'diff')).toBe(changed);
    expect(await readFile(join(repo, 'README.md'), 'utf8')).toBe('TEST unstaged original\n');
    expect(await readFile(join(repo, 'notes.txt'), 'utf8')).toBe('TEST untracked original\n');
    expect(await readFile(join(first.workingDirectory, 'README.md'), 'utf8')).toBe(
      'TEST original\n'
    );
    expect((await git(repo, 'worktree', 'list', '--porcelain')).match(/^worktree /gm)).toHaveLength(
      2
    );
  });

  it('retains branch, staged, unstaged and untracked work on reuse and reattaches a retained branch without reset', async () => {
    const input = { teamName: 'test-team', workingDirectory: repo, worktreeName: 'TEST-work' };
    const first = await workspace.prepareTeam(input, signal());
    await writeFile(join(first.workingDirectory, 'README.md'), 'TEST committed\n');
    await git(first.workingDirectory, 'add', 'README.md');
    await git(
      first.workingDirectory,
      '-c',
      'user.name=TEST',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'TEST team work'
    );
    const head = await git(first.workingDirectory, 'rev-parse', 'HEAD');
    await git(repo, 'worktree', 'remove', first.workingDirectory);
    await git(repo, 'tag', first.worktree!.branchName, 'HEAD');
    const reattached = await workspace.prepareTeam(input, signal());
    expect(await git(reattached.workingDirectory, 'rev-parse', 'HEAD')).toBe(head);
    await git(reattached.workingDirectory, 'switch', '-c', 'TEST-user-branch');
    await writeFile(join(reattached.workingDirectory, 'README.md'), 'TEST staged\n');
    await git(reattached.workingDirectory, 'add', 'README.md');
    await writeFile(join(reattached.workingDirectory, 'README.md'), 'TEST unstaged\n');
    await writeFile(join(reattached.workingDirectory, 'notes.txt'), 'TEST untracked\n');
    const before = await git(reattached.workingDirectory, 'status', '--porcelain');
    const staged = await git(reattached.workingDirectory, 'diff', '--cached');
    const changed = await git(reattached.workingDirectory, 'diff');
    const next = await workspace.prepareTeam(input, signal());
    expect(next.worktree?.branchName).toBe('TEST-user-branch');
    expect(await git(next.workingDirectory, 'status', '--porcelain')).toBe(before);
    expect(await git(next.workingDirectory, 'diff', '--cached')).toBe(staged);
    expect(await git(next.workingDirectory, 'diff')).toBe(changed);
    expect(await readFile(join(next.workingDirectory, 'notes.txt'), 'utf8')).toBe(
      'TEST untracked\n'
    );
  });

  it('uses the resolved team HEAD as the base for isolated members and keeps one explicit ledger', async () => {
    const team = await workspace.prepareTeam(
      { teamName: 'test-team', workingDirectory: repo, worktreeName: 'TEST-shared' },
      signal()
    );
    await writeFile(join(team.workingDirectory, 'README.md'), 'TEST team HEAD\n');
    await git(team.workingDirectory, 'add', 'README.md');
    await git(
      team.workingDirectory,
      '-c',
      'user.name=TEST',
      '-c',
      'user.email=test@example.com',
      'commit',
      '-m',
      'TEST shared change'
    );
    const member = await workspace.prepare(
      {
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
        workingDirectory: team.workingDirectory,
        baseWorkingDirectory: team.workingDirectory,
        isolation: 'worktree',
        instructions: 'TEST',
      },
      signal()
    );
    expect(member.workingDirectory).not.toBe(team.workingDirectory);
    expect(member.workingDirectory).not.toBe(repo);
    expect(await readFile(join(member.workingDirectory, 'README.md'), 'utf8')).toBe(
      'TEST team HEAD\n'
    );
    expect(member.taskLedgerProjectDirectory).toBe(join(root, 'ledger'));
    expect(member.worktree?.baseRepoPath).toBe(team.workingDirectory);
  });

  it('revalidates the actual named shared checkout before each member attempt instead of retaining an obsolete branch projection', async () => {
    const team = await workspace.prepareTeam(
      { teamName: 'test-team', workingDirectory: repo, worktreeName: 'TEST-shared' },
      signal()
    );
    await git(team.workingDirectory, 'switch', '-c', 'TEST-current-team-branch');
    const launch = {
      team: {
        appInstanceId: 'TEST-app',
        dataRootFingerprint: 'TEST-root',
        connectionGeneration: 1,
        teamName: 'test-team',
        runId: 'TEST-run',
      },
      memberName: 'builder',
      role: 'member' as const,
      configurationRevision: 'TEST-revision',
      providerId: 'anthropic' as const,
      model: null,
      ...team,
      baseWorkingDirectory: team.workingDirectory,
      instructions: 'TEST',
    };
    expect((await workspace.prepare(launch, signal())).worktree?.branchName).toBe(
      'TEST-current-team-branch'
    );
    await git(team.workingDirectory, 'switch', '--detach');
    await expect(workspace.prepare(launch, signal())).rejects.toThrow('branch');
  });

  it('does not conflate member/team identities, case-distinct names or slash and dash names', async () => {
    const variants = [
      { teamName: 'test-team', worktreeName: 'Feature/Topic' },
      { teamName: 'test-team', worktreeName: 'feature/topic' },
      { teamName: 'test-team', worktreeName: 'feature-topic' },
      { teamName: 'other-team', worktreeName: 'feature/topic' },
    ];
    const prepared = await Promise.all(
      variants.map((input) => workspace.prepareTeam({ ...input, workingDirectory: repo }, signal()))
    );
    const member = await workspace.prepare(
      {
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
      },
      signal()
    );
    expect(
      new Set([...prepared, member].map((item) => item.workingDirectory.toLowerCase())).size
    ).toBe(5);
    expect(
      new Set([...prepared, member].map((item) => item.worktree?.branchName.toLowerCase())).size
    ).toBe(5);
  });

  it('validates an unnamed shared directory without requiring Git or allocating an isolated workspace', async () => {
    expect(
      await workspace.prepareTeam({ teamName: 'test-team', workingDirectory: root }, signal())
    ).toEqual({ workingDirectory: await realpath(root) });
  });

  it.each([
    '',
    '../outside',
    '/outside',
    'x/../y',
    'x//y',
    'C:\\outside',
    'x\\y',
    'x/',
    'x y',
    'x'.repeat(65),
  ])('rejects invalid configured name %j before filesystem allocation', async (worktreeName) => {
    const before = await git(repo, 'worktree', 'list', '--porcelain');
    await expect(
      workspace.prepareTeam(
        { teamName: 'test-team', workingDirectory: repo, worktreeName },
        signal()
      )
    ).rejects.toThrow('worktree name');
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toBe(before);
  });

  it('refuses occupied or detached managed targets without deleting their files', async () => {
    const input = { teamName: 'test-team', workingDirectory: repo, worktreeName: 'TEST-work' };
    const first = await workspace.prepareTeam(input, signal());
    await git(repo, 'worktree', 'remove', first.workingDirectory);
    await mkdir(first.workingDirectory);
    await writeFile(join(first.workingDirectory, 'notes.txt'), 'TEST occupied path');
    await expect(workspace.prepareTeam(input, signal())).rejects.toThrow();
    expect(await readFile(join(first.workingDirectory, 'notes.txt'), 'utf8')).toBe(
      'TEST occupied path'
    );
    await rm(first.workingDirectory, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 250,
    });
    await git(repo, 'worktree', 'add', '--detach', first.workingDirectory, 'HEAD');
    await writeFile(join(first.workingDirectory, 'notes.txt'), 'TEST detached work');
    await expect(workspace.prepareTeam(input, signal())).rejects.toThrow('branch');
    expect(await readFile(join(first.workingDirectory, 'notes.txt'), 'utf8')).toBe(
      'TEST detached work'
    );
  });

  it('uses the same hook-free Git boundary for named team allocation and does not copy local settings', async () => {
    const hooks = join(root, 'TEST-hooks');
    const marker = join(root, 'TEST-hook-ran');
    await mkdir(hooks);
    await writeFile(
      join(hooks, 'post-checkout'),
      '#!/bin/sh\nprintf TEST > "$TEST_TEAM_WORKSPACE_HOOK_MARKER"\n',
      { mode: 0o755 }
    );
    await git(repo, 'config', 'core.hooksPath', hooks.replaceAll('\\', '/'));
    await mkdir(join(repo, '.claude'));
    await writeFile(join(repo, '.claude', 'settings.local.json'), '{"TEST":"not copied"}');
    const previous = process.env.TEST_TEAM_WORKSPACE_HOOK_MARKER;
    process.env.TEST_TEAM_WORKSPACE_HOOK_MARKER = marker;
    try {
      const prepared = await workspace.prepareTeam(
        { teamName: 'test-team', workingDirectory: repo, worktreeName: 'TEST-work' },
        signal()
      );
      await expect(
        readFile(join(prepared.workingDirectory, '.claude', 'settings.local.json'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      if (previous === undefined) delete process.env.TEST_TEAM_WORKSPACE_HOOK_MARKER;
      else process.env.TEST_TEAM_WORKSPACE_HOOK_MARKER = previous;
    }
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await git(repo, 'config', '--get', 'core.hooksPath')).toBe(hooks.replaceAll('\\', '/'));
  });

  it('drains cancellation after Git allocation begins and reuses the retained worktree on the next request', async () => {
    const managed = join(root, 'workspaces');
    await mkdir(managed);
    const abort = new AbortController();
    let allocated = false;
    const watcher = watch(managed, (_event, name) => {
      if (name?.toString().startsWith('team-test-team-')) {
        allocated = true;
        abort.abort(new Error('TEST cancelled after allocation began'));
      }
    });
    const input = { teamName: 'test-team', workingDirectory: repo, worktreeName: 'TEST-work' };
    try {
      await expect(workspace.prepareTeam(input, abort.signal)).rejects.toThrow(
        'TEST cancelled after allocation began'
      );
    } finally {
      watcher.close();
    }
    expect(allocated).toBe(true);
    const retained = await git(repo, 'worktree', 'list', '--porcelain');
    expect(retained.match(/^worktree /gm)).toHaveLength(2);
    const next = await workspace.prepareTeam(input, signal());
    expect(await git(repo, 'worktree', 'list', '--porcelain')).toBe(retained);
    expect(await readFile(join(next.workingDirectory, 'README.md'), 'utf8')).toBe(
      'TEST original\n'
    );
  });

  it('rejects a cancelled request or non-Git named workspace rather than using another allocator', async () => {
    const abort = new AbortController();
    abort.abort(new Error('TEST cancelled workspace'));
    await expect(
      workspace.prepareTeam(
        { teamName: 'test-team', workingDirectory: repo, worktreeName: 'TEST-work' },
        abort.signal
      )
    ).rejects.toThrow('TEST cancelled workspace');
    await expect(
      workspace.prepareTeam(
        { teamName: 'test-team', workingDirectory: root, worktreeName: 'TEST-work' },
        signal()
      )
    ).rejects.toThrow();
  });
});
