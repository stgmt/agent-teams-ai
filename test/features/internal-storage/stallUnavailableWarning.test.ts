// @vitest-environment node
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createInternalStorageFeature } from '@features/internal-storage/main/composition/createInternalStorageFeature';
import { InternalStorageWorkerClient } from '@features/internal-storage/main/infrastructure/InternalStorageWorkerClient';
import { createInternalStorageCommentWarning } from '@main/internalStorageCommentWarning';
import { TeamTaskStallJournal } from '@main/services/team/stallMonitor/TeamTaskStallJournal';
import { TeamTaskStallMonitor } from '@main/services/team/stallMonitor/TeamTaskStallMonitor';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it('reports storage outage when the real stall monitor cannot persist its journal', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stall-storage-warning-'));
  const parent = await fs.realpath(os.tmpdir());
  const target = await fs.realpath(root);
  const relative = path.relative(parent, target);
  if (!relative.startsWith('stall-storage-warning-') || relative.includes(path.sep)) {
    throw new Error('Refusing to remove a test fixture outside its scratch parent');
  }
  vi.useFakeTimers();
  vi.stubEnv('CLAUDE_TEAM_TASK_STALL_SCAN_INTERVAL_MS', '1000');
  vi.stubEnv('CLAUDE_TEAM_TASK_STALL_STARTUP_GRACE_MS', '1');
  vi.stubEnv('CLAUDE_TEAM_TASK_STALL_ACTIVATION_GRACE_MS', '1');
  vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(false);
  const publish = vi.fn(async (_warning: unknown) => undefined);
  const warning = createInternalStorageCommentWarning(publish, () => 'ru');
  const storage = createInternalStorageFeature({
    userDataPath: root,
    onInternalStorageUnavailable: warning.onStorageUnavailable,
    onCommentJournalFailure: warning.onFailure,
    onCommentJournalMutationSuccess: warning.onMutationSuccess,
  });
  const registry = {
    start: vi.fn(),
    stop: vi.fn(),
    noteTeamChange: vi.fn(),
    listActiveTeams: vi.fn(async () => ['demo']),
  };
  const task = { id: 'task-a', displayId: 'abcd1234', subject: 'Task A' };
  const snapshot = {
    teamName: 'demo',
    inProgressTasks: [task],
    reviewOpenTasks: [],
    allTasksById: new Map([['task-a', task]]),
  };
  const source = { getSnapshot: vi.fn(async () => snapshot) };
  const policy = {
    evaluateWork: vi.fn(() => ({
      status: 'alert',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      epochKey: 'work-a:epoch',
      reason: 'Potential work stall.',
    })),
    evaluateReview: vi.fn(),
  };
  const notifier = {
    notifyLead: vi.fn(async () => undefined),
    notifyOpenCodeOwners: vi.fn(async () => []),
  };
  const monitor = new TeamTaskStallMonitor(
    registry as never,
    source as never,
    policy as never,
    new TeamTaskStallJournal({ store: storage.taskStallJournalStore }),
    notifier as never
  );
  try {
    monitor.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(policy.evaluateWork.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(notifier.notifyLead).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0]).toMatchObject({
      source: 'internal-storage',
      requiresAcknowledgement: true,
      message: expect.stringContaining('зависших задач'),
    });
  } finally {
    await monitor.stop();
    await storage.dispose();
    vi.useRealTimers();
    await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
