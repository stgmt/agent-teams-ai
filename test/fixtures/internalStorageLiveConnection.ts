import { readSync, writeSync } from 'node:fs';

import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';

const [databasePath, mode, identity] = process.argv.slice(2);
if (!databasePath || !mode || !identity)
  throw new Error('database path, mode and identity required');
const emit = (value: unknown): void => {
  writeSync(1, `${JSON.stringify(value)}\n`);
};
const wait = () => {
  const signal = Buffer.alloc(1);
  if (readSync(0, signal, 0, 1, null) !== 1) throw new Error('barrier closed');
};

try {
  if (mode === 'raw') {
    // Represents a previously opened SQLite user that knows nothing of new
    // marker/lease protocols, including an older app process.
    const db = new Database(databasePath);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      db.exec('CREATE TABLE IF NOT EXISTS live_writes(value TEXT)');
      emit({ type: 'opened' });
      wait();
      db.prepare('INSERT INTO live_writes VALUES (?)').run(identity);
      emit({ type: 'written', rows: db.prepare('SELECT value FROM live_writes').all() });
    } finally {
      db.close();
    }
  } else {
    const core = new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
    try {
      core.handle('ping', {});
      emit({ type: 'opened' });
      wait();
      core.handle('storeImports.record', { storeId: identity, teamName: 'race', entryCount: 1 });
      emit({
        type: 'written',
        observed: core.handle('storeImports.has', { storeId: identity, teamName: 'race' }),
      });
    } finally {
      core.close();
    }
  }
} catch (error) {
  emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
}
