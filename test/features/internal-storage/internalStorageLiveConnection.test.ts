import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';

import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import { expect, it } from 'vitest';

type Message = { type: string; rows?: unknown; observed?: boolean; message?: string };
function racer(databasePath: string, mode: string, identity: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      path.resolve('test/fixtures/internalStorageLiveConnection.ts'),
      databasePath,
      mode,
      identity,
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  const messages: Message[] = [];
  const waiters: { type: string; resolve: (message: Message) => void }[] = [];
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  let rejectExit!: (error: Error) => void;
  const exited = new Promise<never>((_resolve, reject) => {
    rejectExit = reject;
  });
  exited.catch(() => undefined);
  child.once('error', rejectExit);
  child.once('close', (code) =>
    rejectExit(new Error(`child exited ${String(code)}: ${stderr}; ${JSON.stringify(messages)}`))
  );
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line) as Message;
    messages.push(message);
    for (const waiter of waiters.filter((item) => item.type === message.type))
      waiter.resolve(message);
  });
  return {
    waitFor: (type: string): Promise<Message> => {
      const previous = messages.find((message) => message.type === type);
      return previous
        ? Promise.resolve(previous)
        : Promise.race([
            new Promise<Message>((resolve) => waiters.push({ type, resolve })),
            exited,
          ]);
    },
    go: () => child.stdin.end('g'),
    stop: () => child.kill(),
  };
}

it('permits two healthy processes to keep connections open and persist independent writes', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-live-healthy-'));
  const databasePath = path.join(directory, 'app.db');
  // Seed avoids a race in initial WAL setup and isolates concurrent connection handling.
  const seed = new InternalStorageWorkerCore({
    databasePath,
    createDatabase: (file) => new Database(file),
  });
  seed.handle('ping', {});
  seed.close();
  const first = racer(databasePath, 'healthy', 'first');
  const second = racer(databasePath, 'healthy', 'second');
  try {
    await Promise.all([first.waitFor('opened'), second.waitFor('opened')]);
    first.go();
    second.go();
    expect(await first.waitFor('written')).toMatchObject({ observed: true });
    expect(await second.waitFor('written')).toMatchObject({ observed: true });
    const reopened = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
    try {
      expect(reopened.handle('storeImports.has', { storeId: 'first', teamName: 'race' })).toBe(
        true
      );
      expect(reopened.handle('storeImports.has', { storeId: 'second', teamName: 'race' })).toBe(
        true
      );
    } finally {
      reopened.close();
    }
  } finally {
    first.stop();
    second.stop();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}, 15_000);

it.each(process.platform === 'win32' ? ['injected'] : ['injected', 'real'])(
  'never detaches a pre-existing live SQLite connection after %s corruption detection',
  async (scenario) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'storage-live-corruption-'));
    const databasePath = path.join(directory, 'app.db');
    const old = racer(databasePath, 'raw', 'successful-old-connection-write');
    try {
      await old.waitFor('opened');
      const before = await fs.stat(databasePath);
      if (scenario === 'real') {
        const file = await fs.open(databasePath, 'r+');
        try {
          await file.write(Buffer.from('CORRUPTED HEADER'), 0, 16, 0);
        } finally {
          await file.close();
        }
      }
      const detector = new InternalStorageWorkerCore({
        databasePath,
        createDatabase: (file) => {
          if (scenario === 'real') return new Database(file);
          const error = new Error('injected SQLite corruption');
          (error as Error & { code: string }).code = 'SQLITE_CORRUPT';
          throw error;
        },
      });
      expect(() => detector.handle('ping', {})).toThrow(/manual recovery/);
      expect(await fs.stat(databasePath)).toMatchObject({ dev: before.dev, ino: before.ino });
      expect((await fs.readdir(directory)).some((name) => name.includes('.corrupt-'))).toBe(false);
      old.go();
      expect(await old.waitFor('written')).toMatchObject({
        rows: [{ value: 'successful-old-connection-write' }],
      });
      if (scenario === 'injected') {
        const current = new Database(databasePath, { readonly: true });
        try {
          expect(current.prepare('SELECT value FROM live_writes').all()).toEqual([
            { value: 'successful-old-connection-write' },
          ]);
        } finally {
          current.close();
        }
      }
      detector.close();
    } finally {
      old.stop();
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    }
  },
  15_000
);
