import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';

const databasePath = process.argv[2];
if (!databasePath) throw new Error('Database path required');
const core = new InternalStorageWorkerCore({
  databasePath,
  createDatabase: (file) => new Database(file),
});
try {
  const at = '2026-01-01T00:00:00.000Z';
  core.handle('stallJournal.replace', {
    teamName: 'demo',
    entries: [
      {
        epochKey: 'sqlite-entry',
        teamName: 'demo',
        taskId: 'task',
        memberName: null,
        branch: 'work',
        signal: 'turn_ended_after_touch',
        state: 'suspected',
        consecutiveScans: 1,
        createdAt: at,
        updatedAt: at,
        alertedAt: null,
      },
    ],
  });
  process.stdout.write('sqlite-committed\n');
} finally {
  core.close();
}
