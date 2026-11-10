// @vitest-environment node
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeTeamConfigStore } from '../../../../src/features/team-provisioning/main/infrastructure/NativeTeamConfigStore';

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
