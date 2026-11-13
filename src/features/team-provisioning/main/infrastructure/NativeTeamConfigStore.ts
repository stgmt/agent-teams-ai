import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { inspectProcessByPid } from '@main/utils/processInspection';

import type { Stats } from 'node:fs';

export type NativeTeamConfig = Record<string, unknown>;

export interface NativeTeamConfigLockFilesystem {
  writeFile: typeof writeFile;
  symlink: typeof symlink;
}

function object(value: unknown): value is NativeTeamConfig {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Uses the pinned CLI's .config.lock protocol, not a second independent config lock. */
/**
 * Removes a lock only when its metadata names a process that provably no longer
 * exists. A missing or unreadable metadata file keeps the lock: the creator may
 * still be in the window between `mkdir` and its metadata write.
 */
async function takeOverDeadLock(lock: string): Promise<boolean> {
  let metadata: unknown;
  let claimed: Stats;
  let raw: string;
  try {
    claimed = await lstat(lock);
    raw = await readFile(join(lock, 'metadata.json'), 'utf8');
    metadata = JSON.parse(raw);
  } catch {
    return false;
  }
  const pid =
    typeof (metadata as { pid?: unknown }).pid === 'number'
      ? (metadata as { pid: number }).pid
      : null;
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) return false;
  const inspection = await inspectProcessByPid(pid).catch(() => null);
  if (!inspection || inspection.status !== 'not_found') return false;
  const current = await lstat(lock).catch(() => null);
  if (!current || current.dev !== claimed.dev || current.ino !== claimed.ino) return false;
  const latest = await readFile(join(lock, 'metadata.json'), 'utf8').catch(() => null);
  if (latest !== raw) return false;
  await rm(lock, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  return true;
}

/** Publish the complete owner atomically; an interrupted preparation never occupies the CLI lock. */
async function acquireLock(
  directory: string,
  signal: AbortSignal,
  assertDirectory: () => Promise<void>,
  filesystem: NativeTeamConfigLockFilesystem
) {
  const lock = join(directory, '.config.lock');
  const nonce = randomUUID();
  const prepared = join(directory, `.config.lock-owner-${process.pid}-${nonce}`);
  await mkdir(prepared, { mode: 0o700 });
  let published = false;
  try {
    await filesystem.writeFile(
      join(prepared, 'metadata.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce }),
      { mode: 0o600, flag: 'wx' }
    );
    const deadline = Date.now() + 30_000;
    while (true) {
      signal.throwIfAborted();
      await assertDirectory();
      try {
        // Exclusive creation preserves an existing lock, including a legacy empty directory.
        await filesystem.symlink(prepared, lock, process.platform === 'win32' ? 'junction' : 'dir');
        published = true;
        return { lock, nonce, prepared, claimed: await lstat(lock) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (await takeOverDeadLock(lock)) continue;
        if (Date.now() >= deadline) throw new Error('Native team config lock is occupied');
        await delay(25, undefined, { signal });
      }
    }
  } finally {
    if (!published)
      await rm(prepared, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}

export class NativeTeamConfigStore {
  constructor(
    private readonly teamsRoot: string,
    private readonly lockFilesystem: NativeTeamConfigLockFilesystem = { writeFile, symlink }
  ) {}

  async mutate(
    teamName: string,
    signal: AbortSignal,
    update: (current: NativeTeamConfig | null) => Promise<NativeTeamConfig | null>
  ): Promise<void> {
    if (validateTeamName(teamName).value !== teamName) throw new Error('Invalid native team name');
    signal.throwIfAborted();
    const directory = join(resolve(this.teamsRoot), teamName);
    const [rootIdentity, teamIdentity] = await Promise.all([
      lstat(resolve(this.teamsRoot)),
      lstat(directory),
    ]);
    const assertDirectory = async (): Promise<void> => {
      const [root, team] = await Promise.all([lstat(resolve(this.teamsRoot)), lstat(directory)]);
      if (
        !root.isDirectory() ||
        root.isSymbolicLink() ||
        !team.isDirectory() ||
        team.isSymbolicLink() ||
        root.dev !== rootIdentity.dev ||
        root.ino !== rootIdentity.ino ||
        team.dev !== teamIdentity.dev ||
        team.ino !== teamIdentity.ino
      ) {
        throw new Error('Native team directory must not be redirected');
      }
    };
    await assertDirectory();
    const { lock, nonce, prepared, claimed } = await acquireLock(
      directory,
      signal,
      assertDirectory,
      this.lockFilesystem
    );
    let operationError: Error | undefined;
    try {
      await assertDirectory();
      const path = join(directory, 'config.json');
      const before = await this.read(path);
      signal.throwIfAborted();
      const next = await update(before === null ? null : (JSON.parse(before) as NativeTeamConfig));
      signal.throwIfAborted();
      if (next !== null) {
        await atomicWriteAsync(path, `${JSON.stringify(next, null, 2)}\n`, {
          mode: 0o600,
          beforeCommit: async () => {
            signal.throwIfAborted();
            await assertDirectory();
            const currentLock = await lstat(lock);
            const metadata: unknown = JSON.parse(
              await readFile(join(lock, 'metadata.json'), 'utf8')
            );
            if (
              currentLock.dev !== claimed.dev ||
              currentLock.ino !== claimed.ino ||
              !object(metadata) ||
              metadata.nonce !== nonce
            ) {
              throw new Error('Native team config lock ownership changed');
            }
            if ((await this.read(path)) !== before)
              throw new Error('Native team config changed during publication');
          },
        });
      }
    } catch (error) {
      operationError =
        error instanceof Error
          ? error
          : new Error('Native team config update failed', { cause: error });
    }
    try {
      const current = await lstat(lock);
      if (current.dev !== claimed.dev || current.ino !== claimed.ino)
        throw new Error('Native team config lock ownership changed');
      await rm(lock, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      await rm(prepared, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch (releaseError) {
      if (operationError)
        throw new AggregateError(
          [operationError, releaseError],
          'Native team config update and lock release failed'
        );
      throw releaseError;
    }
    if (operationError) throw operationError;
  }

  private async read(path: string): Promise<string | null> {
    let before;
    try {
      before = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.nlink !== 1 ||
      before.size > 10 * 1024 * 1024
    ) {
      throw new Error('Native team config must be one bounded regular file');
    }
    const handle = await open(path, 'r');
    try {
      const owned = await handle.stat();
      if (owned.dev !== before.dev || owned.ino !== before.ino || owned.size > 10 * 1024 * 1024)
        throw new Error('Native team config changed during read');
      const text = await handle.readFile('utf8');
      if (!object(JSON.parse(text))) throw new Error('Native team config is invalid');
      return text;
    } finally {
      await handle.close();
    }
  }
}
