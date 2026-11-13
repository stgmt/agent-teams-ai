import { nativeSdkDeferred } from './nativeSdkTestHarness';
// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeTeamConfigStore } from '../../../../src/features/team-provisioning/main/infrastructure/NativeTeamConfigStore';
import * as processInspection from '../../../../src/main/utils/processInspection';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      )
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-config-store-'));
  directories.push(root);
  const teamName = 'test-lock-team';
  const directory = join(root, teamName);
  await mkdir(directory);
  return {
    store: new NativeTeamConfigStore(root),
    teamName,
    directory,
    path: join(directory, 'config.json'),
  };
}

describe('pinned native config storage boundary', () => {
  it('serializes independent adapter instances on the same CLI lock without dropping either update', async () => {
    const { store, teamName, directory, path } = await setup();
    const other = new NativeTeamConfigStore(join(directory, '..'));
    let finish!: () => void;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered = false;
    const first = store.mutate(teamName, new AbortController().signal, async () => {
      entered = true;
      await hold;
      return { first: true };
    });
    await expect.poll(() => entered).toBe(true);
    const updated = vi.fn(async (current) => ({ ...current, second: true }));
    const second = other.mutate(teamName, new AbortController().signal, updated);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(updated).not.toHaveBeenCalled();
    finish();
    await Promise.all([first, second]);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ first: true, second: true });
  });

  it('cancels a contending writer without entering its callback or removing the current owner lock', async () => {
    const { store, teamName, directory } = await setup();
    let finish!: () => void;
    const hold = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered = false;
    const first = store.mutate(teamName, new AbortController().signal, async () => {
      entered = true;
      await hold;
      return { owner: true };
    });
    await expect.poll(() => entered).toBe(true);
    const metadata = await readFile(join(directory, '.config.lock', 'metadata.json'), 'utf8');
    const abort = new AbortController();
    const update = vi.fn(async () => ({ wrong: true }));
    const second = store.mutate(teamName, abort.signal, update);
    const rejected = expect(second).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 75));
    abort.abort();
    await rejected;
    expect(update).not.toHaveBeenCalled();
    expect(await readFile(join(directory, '.config.lock', 'metadata.json'), 'utf8')).toBe(metadata);
    finish();
    await first;
  });

  it('takes over a lock whose recorded owner process is gone', async () => {
    const { store, teamName, directory, path } = await setup();
    // A killed app leaves this state behind: the lock names a dead process.
    const deadPid = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', () => resolve(child.pid ?? 0));
    });
    expect(deadPid).toBeGreaterThan(0);
    await mkdir(join(directory, '.config.lock'));
    await writeFile(
      join(directory, '.config.lock', 'metadata.json'),
      JSON.stringify({ pid: deadPid, createdAt: Date.now() })
    );
    await store.mutate(teamName, new AbortController().signal, async () => ({ written: true }));
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ written: true });
    await expect(readFile(join(directory, '.config.lock', 'metadata.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each(['metadata', 'publication'] as const)(
    'does not occupy the CLI lock when interrupted before %s publication',
    async (phase) => {
      const { teamName, directory, path } = await setup();
      const entered = nativeSdkDeferred<string>();
      const interruption = nativeSdkDeferred<void>();
      const crash = new Error('TEST interrupted lock publication');
      const write = filesystem.writeFile;
      const link = filesystem.symlink;
      const boundary = {
        writeFile:
          phase === 'metadata'
            ? async (...args: Parameters<typeof write>) => {
                entered.resolve(String(args[0]));
                await interruption.promise;
                return write(...args);
              }
            : write,
        symlink:
          phase === 'publication'
            ? async (...args: Parameters<typeof link>) => {
                entered.resolve(String(args[0]));
                await interruption.promise;
                return link(...args);
              }
            : link,
      };
      const store = new NativeTeamConfigStore(join(directory, '..'), boundary);
      const firstUpdate = vi.fn(async () => ({ first: true }));
      const first = store.mutate(teamName, new AbortController().signal, firstUpdate);
      const rejected = expect(first).rejects.toBe(crash);
      try {
        const stage = await entered.promise;
        if (phase === 'publication') {
          expect(JSON.parse(await readFile(join(stage, 'metadata.json'), 'utf8'))).toMatchObject({
            pid: process.pid,
            nonce: expect.any(String),
          });
        }
        // The interrupted writer has NOT run its finally/cleanup. A fresh writer
        // must progress without deleting its live preparation directory by age.
        const fresh = new NativeTeamConfigStore(join(directory, '..'));
        await fresh.mutate(teamName, AbortSignal.timeout(5_000), async () => ({ recovered: true }));
        expect(firstUpdate).not.toHaveBeenCalled();
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ recovered: true });
      } finally {
        interruption.reject(crash);
        await rejected;
      }
    },
    10_000
  );

  it('preserves an unowned legacy empty lock rather than guessing its owner is dead', async () => {
    const { teamName, directory } = await setup();
    const lock = join(directory, '.config.lock');
    await mkdir(lock);
    const attempted = nativeSdkDeferred<void>();
    const link = filesystem.symlink;
    const store = new NativeTeamConfigStore(join(directory, '..'), {
      writeFile: filesystem.writeFile,
      symlink: async (...args) => {
        try {
          return await link(...args);
        } finally {
          attempted.resolve();
        }
      },
    });
    const abort = new AbortController();
    const update = vi.fn(async () => ({ overwritten: true }));
    const mutation = store.mutate(teamName, abort.signal, update);
    const rejected = expect(mutation).rejects.toThrow();
    await attempted.promise;
    abort.abort();
    await rejected;
    expect(update).not.toHaveBeenCalled();
    expect((await filesystem.lstat(lock)).isDirectory()).toBe(true);
  });

  it('never evicts a demonstrably live lock owner solely because its timestamp is old', async () => {
    const { store, teamName, directory, path } = await setup();
    const lock = join(directory, '.config.lock');
    const metadataPath = join(lock, 'metadata.json');
    const originalConfig = JSON.stringify({ retained: true });
    await writeFile(path, originalConfig);
    await mkdir(lock);
    const old = new Date('2000-01-01T00:00:00.000Z');
    const metadata = JSON.stringify({
      pid: process.pid,
      createdAt: old.getTime(),
      nonce: 'TEST-live-lock',
    });
    await writeFile(metadataPath, metadata);
    await utimes(metadataPath, old, old);
    await utimes(lock, old, old);
    const update = vi.fn(async () => ({ overwritten: true }));
    const controller = new AbortController();
    const inspected = nativeSdkDeferred<void>();
    const inspect = processInspection.inspectProcessByPid;
    const probe = vi
      .spyOn(processInspection, 'inspectProcessByPid')
      .mockImplementation(async (...args) => {
        const result = await inspect(...args);
        inspected.resolve();
        return result;
      });
    try {
      const mutation = store.mutate(teamName, controller.signal, update);
      const rejection = expect(mutation).rejects.toThrow();
      // Wait for actual ownership evidence, not a guessed sleep or an early abort.
      await Promise.race([inspected.promise, mutation]);
      const settled = nativeSdkDeferred<void>();
      setImmediate(settled.resolve);
      await settled.promise;
      controller.abort();
      await rejection;
      expect(update).not.toHaveBeenCalled();
      expect(await readFile(metadataPath, 'utf8')).toBe(metadata);
      expect(await readFile(path, 'utf8')).toBe(originalConfig);
    } finally {
      probe.mockRestore();
    }
  });

  it('does not overwrite a non-cooperating writer that changes config while the mutation is prepared', async () => {
    const { store, teamName, path } = await setup();
    await writeFile(path, JSON.stringify({ before: true }));
    await expect(
      store.mutate(teamName, new AbortController().signal, async () => {
        await writeFile(path, JSON.stringify({ external: true }));
        return { ours: true };
      })
    ).rejects.toThrow('changed during publication');
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ external: true });
  });
});
