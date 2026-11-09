import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { atomicWriteAsync } from '@main/utils/atomicWrite';
import { inspectProcessByPid } from '@main/utils/processInspection';

export type NativeTeamConfig = Record<string, unknown>;

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
  try {
    metadata = JSON.parse(await readFile(join(lock, 'metadata.json'), 'utf8'));
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
  await rm(lock, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  return true;
}

export class NativeTeamConfigStore {
  constructor(private readonly teamsRoot: string) {}

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
    const lock = join(directory, '.config.lock');
    const nonce = randomUUID();
    const deadline = Date.now() + 10_000;
    while (true) {
      signal.throwIfAborted();
      await assertDirectory();
      try {
        await mkdir(lock, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        // A lock whose recorded owner is gone must not wedge every later write:
        // a killed app never releases it. Live or unreadable owners still block.
        if (await takeOverDeadLock(lock)) continue;
        if (Date.now() >= deadline) throw new Error('Native team config lock is occupied');
        await delay(25, undefined, { signal });
      }
    }
    const claimed = await lstat(lock);
    let operationError: Error | undefined;
    try {
      await writeFile(
        join(lock, 'metadata.json'),
        JSON.stringify({ pid: process.pid, createdAt: Date.now(), nonce }),
        { mode: 0o600, flag: 'wx' }
      );
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
