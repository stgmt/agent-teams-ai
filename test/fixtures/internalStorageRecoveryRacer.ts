import { readSync, writeSync } from 'node:fs';

import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';

import type { InternalStorageBackendInfo } from '@features/internal-storage/contracts/internalStorageContracts';

const [databasePath, mode] = process.argv.slice(2);
if (!databasePath || !mode) throw new Error('database path and mode required');
let waited = false;
const emit = (value: unknown): void => {
  writeSync(1, `${JSON.stringify(value)}\n`);
};
const core = new InternalStorageWorkerCore({
  databasePath,
  createDatabase: (file) => new Database(file),
  now: () => {
    if (mode === 'owner' && !waited) {
      waited = true;
      emit({ type: 'recoveryStarted' });
      const signal = Buffer.alloc(1);
      if (readSync(0, signal, 0, 1, null) !== 1) throw new Error('barrier closed');
    }
    return new Date('2026-11-05T12:00:00.000Z');
  },
});

try {
  emit({ type: 'started' });
  const info = core.handle('ping', {}) as InternalStorageBackendInfo;
  if (mode === 'owner') {
    core.handle('storeImports.record', { storeId: 'proof', teamName: 'race', entryCount: 1 });
  }
  const observed = core.handle('storeImports.has', { storeId: 'proof', teamName: 'race' });
  emit({ type: 'result', integrity: info.integrity, observed });
} catch (error) {
  emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
} finally {
  core.close();
}
