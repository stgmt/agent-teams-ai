import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import { expect, it } from 'vitest';

import type { InternalStorageBackendInfo } from '@features/internal-storage/contracts/internalStorageContracts';

type Message = { type: string; message?: string; integrity?: string; observed?: boolean };

function racer(databasePath: string, mode: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      path.resolve('test/fixtures/internalStorageRecoveryRacer.ts'),
      databasePath,
      mode,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const received: Message[] = [];
  const waiters: { type: string; resolve: (message: Message) => void }[] = [];
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<never>((_resolve, reject) => {
    rejectExit = reject;
  });
  exited.catch(() => undefined);
  child.once('error', rejectExit);
  // `exit` can precede delivery of buffered stdout on Windows. `close` waits
  // for the pipes, so a completed JSON result is observed before rejection.
  child.once('close', (code) =>
    rejectExit(new Error(`racer exited (${String(code)}): ${stderr}; messages=${JSON.stringify(received)}`))
  );
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as Message;
    received.push(message);
    for (const waiter of waiters.filter((item) => item.type === message.type))
      waiter.resolve(message);
  });
  const waitFor = (type: string): Promise<Message> => {
    const existing = received.find((message) => message.type === type);
    return existing
      ? Promise.resolve(existing)
      : Promise.race([new Promise<Message>((resolve) => waiters.push({ type, resolve })), exited]);
  };
  return { waitFor, go: () => child.stdin.end('g'), stop: () => child.kill() };
}

it('does not let another process displace a live recovery owner or lose its later write', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-recovery-race-'));
  const storageDirectory = path.join(directory, 'actual-storage');
  const aliasDirectory = path.join(directory, 'storage-alias');
  await fs.mkdir(storageDirectory);
  await fs.symlink(storageDirectory, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  const databasePath = path.join(storageDirectory, 'app.db');
  const original = 'corrupt database; preserve this exact evidence';
  await fs.writeFile(databasePath, original);
  const owner = racer(databasePath, 'owner');
  let contender: ReturnType<typeof racer> | undefined;
  let reopened: InternalStorageWorkerCore | undefined;
  try {
    await owner.waitFor('recoveryStarted');
    // Both application data paths refer to the same physical directory.
    contender = racer(path.join(aliasDirectory, 'app.db'), 'contender');
    await contender.waitFor('started');
    const refused = await contender.waitFor('error');
    expect(refused.message).toContain('File lock timeout:');
    expect(await fs.readFile(databasePath, 'utf8')).toBe(original);
    expect((await fs.readdir(storageDirectory)).filter((name) => name.includes('.corrupt-'))).toHaveLength(
      0
    );

    owner.go();
    expect(await owner.waitFor('result')).toMatchObject({ integrity: 'recovered', observed: true });
    reopened = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
    expect(reopened.handle('storeImports.has', { storeId: 'proof', teamName: 'race' })).toBe(true);
    const backups = (await fs.readdir(storageDirectory)).filter((name) => name.includes('.corrupt-'));
    expect(backups).toHaveLength(1);
    expect(await fs.readFile(path.join(storageDirectory, backups[0], 'app.db'), 'utf8')).toBe(original);
  } finally {
    reopened?.close();
    owner.stop();
    contender?.stop();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}, 20_000);

it('preserves both backups when two corruptions have identical timestamps', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-recovery-same-clock-'));
  const databasePath = path.join(directory, 'app.db');
  const core = () =>
    new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
      now: () => new Date('2026-11-05T12:00:00.000Z'),
    });
  try {
    for (const damaged of ['first damaged database', 'second damaged database']) {
      await fs.writeFile(databasePath, damaged);
      const instance = core();
      try {
        expect((instance.handle('ping', {}) as InternalStorageBackendInfo).integrity).toBe(
          'recovered'
        );
      } finally {
        instance.close();
      }
    }
    const backups = (await fs.readdir(directory)).filter((name) => name.includes('.corrupt-'));
    expect(backups).toHaveLength(2);
    const contents = await Promise.all(
      backups.map((name) => fs.readFile(path.join(directory, name, 'app.db'), 'utf8'))
    );
    expect(contents.sort()).toEqual(['first damaged database', 'second damaged database']);
  } finally {
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
