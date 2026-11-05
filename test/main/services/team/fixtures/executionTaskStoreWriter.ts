// Cross-process writer used by the ExecutionTaskStore concurrency test.
// Runs through tsx so it exercises the real store implementation.
import { ExecutionTaskStore } from '../../../../../src/main/services/team/execution/ExecutionTaskStore';

const [basePath, team, taskId, prefix, countRaw] = process.argv.slice(2);

if (!basePath || !team || !taskId || !prefix) {
  throw new Error('usage: executionTaskStoreWriter <basePath> <team> <taskId> <prefix> [count]');
}

const count = Number.parseInt(countRaw ?? '5', 10);
if (!Number.isFinite(count) || count <= 0) {
  throw new Error(`invalid event count: ${String(countRaw)}`);
}

const store = new ExecutionTaskStore({ basePath, lockOptions: { acquireTimeoutMs: 60_000 } });

for (let index = 0; index < count; index += 1) {
  store.appendHistoryEvent(team, taskId, {
    id: `${prefix}-${index}`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    type: 'review_started',
    from: 'none',
    to: 'review',
  });
}
