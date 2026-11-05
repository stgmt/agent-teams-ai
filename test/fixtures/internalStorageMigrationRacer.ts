import { readSync, writeSync } from 'node:fs';

import { runInternalStorageMigrations } from '@features/internal-storage/main/infrastructure/worker/internalStorageMigrations';
import Database from 'better-sqlite3-node';

const databasePath = process.argv[2];
if (!databasePath) throw new Error('database path required');
const db = new Database(databasePath);
db.pragma('busy_timeout = 5000');
let waited = false;

// Park each real process immediately before its migration transaction begins.
// The old implementation has already read user_version here; the fixed one
// reads it only after the transaction acquires SQLite's write lock.
const wrapped = new Proxy(db, {
  get(target, property) {
    if (property === 'transaction') {
      return (operation: () => void) => {
        const transaction = target.transaction(operation);
        const waitForPeer = () => {
          if (waited) return;
          waited = true;
          writeSync(1, 'ready\n');
          const signal = Buffer.alloc(1);
          if (readSync(0, signal, 0, 1, null) !== 1) throw new Error('barrier closed');
        };
        return Object.assign(
          () => {
            waitForPeer();
            transaction();
          },
          {
            immediate: () => {
              waitForPeer();
              transaction.immediate();
            },
          }
        );
      };
    }
    const value: unknown = Reflect.get(target, property, target);
    return typeof value === 'function' ? value.bind(target) : value;
  },
});

try {
  runInternalStorageMigrations(wrapped);
  writeSync(1, 'complete\n');
} finally {
  db.close();
}
