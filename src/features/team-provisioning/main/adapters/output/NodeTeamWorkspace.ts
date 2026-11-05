import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { promisify } from 'node:util';

import { validateMemberName, validateTeamName } from '@main/services/team/TeamIdentifierValidation';

import { withoutParentGitSelection } from '../../infrastructure/workspaceEnvironment';

import type { ConfiguredMemberLaunch } from '../../../core/application/ports/MemberRuntimePorts';
import type {
  ConfiguredTeamWorkspace,
  PreparedTeamWorkspace,
  TeamWorkspacePort,
} from '../../../core/application/ports/TeamWorkspacePorts';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const env = withoutParentGitSelection(process.env);
  const { stdout } = await exec(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
    {
      cwd,
      env,
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    }
  );
  return stdout.trim();
}

function samePath(left: string, right: string): boolean {
  const canonical = (value: string): string => {
    const path = normalize(value);
    return process.platform === 'win32' ? path.toLowerCase() : path;
  };
  return canonical(left) === canonical(right);
}

async function directory(path: string): Promise<string> {
  if (!isAbsolute(path)) throw new Error('Team workspace requires an absolute directory');
  const canonical = await realpath(path);
  if (!(await stat(canonical)).isDirectory()) throw new Error('Team workspace is not a directory');
  return canonical;
}

async function exists(path: string): Promise<boolean> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink()) throw new Error('Managed worktree path cannot be a symbolic link');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function readable(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 32);
}

/** Worktrees persist with configured teams/members; process stop never removes their work. */
export class NodeTeamWorkspace implements TeamWorkspacePort {
  private readonly pending = new Map<string, Promise<void>>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly taskLedgerProjectDirectory: (
      launch: Readonly<ConfiguredMemberLaunch>
    ) => Promise<string>
  ) {
    if (!isAbsolute(workspaceRoot)) throw new Error('Team workspace root must be absolute');
  }

  async prepareTeam(
    configured: Readonly<ConfiguredTeamWorkspace>,
    signal: AbortSignal
  ): Promise<Readonly<PreparedTeamWorkspace>> {
    const input = Object.freeze({ ...configured });
    signal.throwIfAborted();
    if (validateTeamName(input.teamName).value !== input.teamName)
      throw new Error('Invalid configured workspace identity');
    if (
      input.worktreeName !== undefined &&
      (input.worktreeName.length > 64 ||
        input.worktreeName
          .split('/')
          .some(
            (segment) => !/^[a-zA-Z0-9._-]+$/.test(segment) || segment === '.' || segment === '..'
          ))
    )
      throw new Error('Invalid configured team worktree name');
    const base = await directory(input.workingDirectory);
    signal.throwIfAborted();
    if (input.worktreeName === undefined) return Object.freeze({ workingDirectory: base });
    const baseRepoPath = await realpath(await git(base, ['rev-parse', '--show-toplevel']));
    const common = await realpath(
      await git(baseRepoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    );
    const identity = JSON.stringify(['team', common, input.teamName, input.worktreeName]);
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
    const name = `team-${readable(input.teamName)}-${readable(input.worktreeName)}-${hash}`;
    return this.serialized(identity, signal, () =>
      this.allocate(name, baseRepoPath, common, signal)
    );
  }

  async prepare(
    launch: Readonly<ConfiguredMemberLaunch>,
    signal: AbortSignal
  ): Promise<Readonly<ConfiguredMemberLaunch>> {
    signal.throwIfAborted();
    if (
      validateTeamName(launch.team.teamName).value !== launch.team.teamName ||
      validateMemberName(launch.memberName).value !== launch.memberName
    )
      throw new Error('Invalid configured workspace identity');
    const workingDirectory = await directory(launch.workingDirectory);
    signal.throwIfAborted();
    if (launch.isolation === undefined) {
      let prepared: Readonly<PreparedTeamWorkspace> = { workingDirectory };
      if (launch.worktree) {
        const baseRepoPath = await directory(launch.worktree.baseRepoPath);
        const common = await realpath(
          await git(baseRepoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
        );
        prepared = await this.validate(workingDirectory, baseRepoPath, common);
      }
      const taskLedgerProjectDirectory = await this.resolveLedger(launch);
      signal.throwIfAborted();
      return Object.freeze({ ...launch, ...prepared, taskLedgerProjectDirectory });
    }
    if (launch.isolation !== 'worktree' || !launch.baseWorkingDirectory)
      throw new Error('Configured workspace isolation is unavailable');
    const base = await directory(launch.baseWorkingDirectory);
    const baseRepoPath = await realpath(await git(base, ['rev-parse', '--show-toplevel']));
    const common = await realpath(
      await git(baseRepoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    );
    const key = JSON.stringify([common, launch.team.teamName, launch.memberName]);
    const prepared = await this.serialized(key, signal, async () => {
      if (!samePath(workingDirectory, base))
        return this.validate(workingDirectory, baseRepoPath, common);
      const hash = createHash('sha256').update(key).digest('hex').slice(0, 20);
      const name = `${readable(launch.team.teamName)}-${readable(launch.memberName)}-${hash}`;
      return this.allocate(name, baseRepoPath, common, signal);
    });
    const taskLedgerProjectDirectory = await this.resolveLedger(launch);
    signal.throwIfAborted();
    return Object.freeze({ ...launch, ...prepared, taskLedgerProjectDirectory });
  }

  private async serialized<T>(
    key: string,
    signal: AbortSignal,
    operation: () => Promise<T>
  ): Promise<T> {
    // Serialize filesystem changes, but validate each caller's own requested directory.
    const previous = this.pending.get(key) ?? Promise.resolve();
    const result = previous.then(() => {
      signal.throwIfAborted();
      return operation();
    });
    const settled = result.then(
      () => undefined,
      () => undefined
    );
    this.pending.set(key, settled);
    void settled.then(() => {
      if (this.pending.get(key) === settled) this.pending.delete(key);
    });
    const prepared = await result;
    signal.throwIfAborted();
    return prepared;
  }

  private async allocate(
    name: string,
    baseRepoPath: string,
    common: string,
    signal: AbortSignal
  ): Promise<Readonly<PreparedTeamWorkspace>> {
    const target = join(this.workspaceRoot, name);
    const branch = `agent-teams/${name}`;
    await mkdir(this.workspaceRoot, { recursive: true });
    if ((await lstat(this.workspaceRoot)).isSymbolicLink())
      throw new Error('Managed workspace root cannot be a symbolic link');
    const root = await realpath(this.workspaceRoot);
    if (!(await exists(target))) {
      let branchExists = false;
      try {
        await git(baseRepoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
        branchExists = true;
      } catch (error) {
        if ((error as { code?: unknown }).code !== 1) throw error;
      }
      signal.throwIfAborted();
      // Capture the selected checkout's local commit, never a remote default or a reset target.
      const args = branchExists
        ? ['worktree', 'add', target, branch]
        : [
            'worktree',
            'add',
            '-b',
            branch,
            target,
            await git(baseRepoPath, ['rev-parse', '--verify', 'HEAD^{commit}']),
          ];
      signal.throwIfAborted();
      await git(baseRepoPath, args);
    }
    const canonical = await directory(target);
    if (!samePath(dirname(canonical), root))
      throw new Error('Managed worktree is outside its workspace root');
    return this.validate(canonical, baseRepoPath, common);
  }

  private async validate(
    target: string,
    baseRepoPath: string,
    common: string
  ): Promise<Readonly<PreparedTeamWorkspace>> {
    const [top, targetCommon, reference, entries] = await Promise.all([
      git(target, ['rev-parse', '--show-toplevel']),
      git(target, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      git(target, ['symbolic-ref', '--quiet', 'HEAD']).catch(() => {
        throw new Error('Configured worktree must be on a branch');
      }),
      git(baseRepoPath, ['worktree', 'list', '--porcelain', '-z']),
    ]);
    if (!samePath(await realpath(top), target))
      throw new Error('Configured worktree must be its repository root');
    if (!samePath(await realpath(targetCommon), common))
      throw new Error('Configured worktree belongs to another repository');
    if (samePath(target, baseRepoPath))
      throw new Error('Isolated workspace cannot be the team repository root');
    const registered = entries
      .split('\0')
      .some(
        (field) =>
          field.startsWith('worktree ') && samePath(field.slice('worktree '.length), target)
      );
    if (!registered || !reference.startsWith('refs/heads/'))
      throw new Error('Configured worktree is not registered on a branch');
    return Object.freeze({
      workingDirectory: target,
      worktree: Object.freeze({
        baseRepoPath,
        branchName: reference.slice('refs/heads/'.length),
      }),
    });
  }

  private async resolveLedger(launch: Readonly<ConfiguredMemberLaunch>): Promise<string> {
    const selected = await this.taskLedgerProjectDirectory(launch);
    if (!isAbsolute(selected)) throw new Error('Team task ledger directory must be absolute');
    return selected;
  }
}
