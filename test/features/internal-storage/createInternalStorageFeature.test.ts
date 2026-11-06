import { BackendSelectingTaskStallJournalStore } from '@features/internal-storage/main/composition/BackendSelectingTaskStallJournalStore';
import { createInternalStorageFeature } from '@features/internal-storage/main/composition/createInternalStorageFeature';
import { InternalStorageBackendSelector } from '@features/internal-storage/main/composition/InternalStorageBackendSelector';
import { InternalStorageJsonReplica } from '@features/internal-storage/main/infrastructure/InternalStorageJsonReplica';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getCommentNotificationJournalPath } from '../../../src/main/services/team/JsonTaskCommentNotificationJournalStore';
import { getStallMonitorJournalPath } from '../../../src/main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { setClaudeBasePathOverride } from '../../../src/main/utils/pathDecoder';

import type {
  TaskStallJournalMutation,
  TaskStallJournalStore,
} from '../../../src/main/services/team/stallMonitor/TaskStallJournalStore';
import type { TaskStallJournalEntry } from '../../../src/main/services/team/stallMonitor/TeamTaskStallTypes';
import type { TaskCommentNotificationJournalEntry } from '../../../src/main/services/team/TaskCommentNotificationJournalStore';
import type { InternalStorageBackendInfo } from '@features/internal-storage/contracts/internalStorageContracts';

class RecordingStore implements TaskStallJournalStore {
  calls = 0;

  update<T>(
    _teamName: string,
    mutate: (entries: TaskStallJournalEntry[]) => TaskStallJournalMutation<T>
  ): Promise<T> {
    this.calls += 1;
    return Promise.resolve(mutate([]).result);
  }
}

const backendInfo: InternalStorageBackendInfo = {
  driver: 'better-sqlite3',
  databasePath: '/fake/user-data/storage/app.db',
  schemaVersion: 2,
  integrity: 'ok',
};

describe('InternalStorageBackendSelector', () => {
  it('picks the sqlite backend when the initial ping succeeds and pings only once', async () => {
    let pings = 0;
    const selector = new InternalStorageBackendSelector(() => {
      pings += 1;
      return Promise.resolve(backendInfo);
    });

    expect(await selector.select('sqlite-store', 'json-store')).toBe('sqlite-store');
    expect(await selector.select('sqlite-store', 'json-store')).toBe('sqlite-store');
    expect(pings).toBe(1);
    expect(selector.getBackendKind()).toBe('sqlite');
  });

  it('allows JSON fallback only when the caller proves isolation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let pings = 0;
    const selector = new InternalStorageBackendSelector(
      () => {
        pings += 1;
        return Promise.reject(new Error('native module ABI mismatch'));
      },
      () => false,
      () => false
    );

    expect(await selector.select('sqlite-store', 'json-store')).toBe('json-store');
    expect(await selector.select('sqlite-store', 'json-store')).toBe('json-store');
    expect(pings).toBe(1);
    expect(selector.getBackendKind()).toBe('json-fallback');
  });

  it('blocks JSON by default when worker failure leaves backend ownership unproven', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const selector = new InternalStorageBackendSelector(() =>
      Promise.reject(new Error('worker offline'))
    );
    expect(await selector.probe()).toBe('verification-required');
    await expect(selector.select('sqlite-store', 'json-store')).rejects.toThrow(
      /JSON fallback is disabled/
    );
  });

  it('blocks storage when the recovery marker cannot be inspected', async () => {
    const ping = vi.fn(() => Promise.resolve(backendInfo));
    const selector = new InternalStorageBackendSelector(ping, () => {
      throw Object.assign(new Error('marker access denied'), { code: 'EACCES' });
    });
    expect(await selector.probe()).toBe('verification-required');
    await expect(selector.select('sqlite-store', 'json-store')).rejects.toThrow(/verif/i);
    expect(ping).not.toHaveBeenCalled();
  });

  it('refuses JSON fallback when corruption is known but the marker could not be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error('recovery marker could not be created'), {
      code: 'INTERNAL_STORAGE_RECOVERY_REQUIRED',
    });
    const selector = new InternalStorageBackendSelector(
      () => Promise.reject(error),
      () => false
    );
    expect(await selector.probe()).toBe('recovery-required');
    await expect(selector.select('sqlite-store', 'json-store')).rejects.toThrow(/manual recovery/);
    expect(selector.getBackendKind()).toBe('recovery-required');
  });
});

describe('BackendSelectingTaskStallJournalStore', () => {
  it('routes updates to the backend the selector picked', async () => {
    const sqlite = new RecordingStore();
    const json = new RecordingStore();
    const selector = new InternalStorageBackendSelector(() => Promise.resolve(backendInfo));
    const store = new BackendSelectingTaskStallJournalStore(selector, sqlite, json);

    await store.update('demo', (entries) => ({ entries, result: undefined }));
    await store.update('demo', (entries) => ({ entries, result: undefined }));

    expect(sqlite.calls).toBe(2);
    expect(json.calls).toBe(0);
  });
});

describe('createInternalStorageFeature', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      const parent = await fs.realpath(os.tmpdir());
      const target = await fs.realpath(tmpDir);
      const relative = path.relative(parent, target);
      if (!relative.startsWith('internal-storage-feature-') || relative.includes(path.sep)) {
        throw new Error('Refusing to remove a path outside the test scratch parent');
      }
      await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      tmpDir = null;
    }
  });

  it('blocks both journals without a worker and preserves existing replicas', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'internal-storage-feature-'));
    setClaudeBasePathOverride(tmpDir);
    await fs.mkdir(path.join(tmpDir, 'teams', 'demo'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'teams', 'replica-team'), { recursive: true });

    const replicatedStall: TaskStallJournalEntry = {
      epochKey: 'task-replicated:epoch-1',
      teamName: 'replica-team',
      taskId: 'task-replicated',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      state: 'alerted',
      consecutiveScans: 3,
      createdAt: '2026-07-07T09:00:00.000Z',
      updatedAt: '2026-07-07T09:05:00.000Z',
      alertedAt: '2026-07-07T09:05:00.000Z',
    };
    const stallReplica = new InternalStorageJsonReplica<{ entries: TaskStallJournalEntry[] }>(
      (teamName) => `${getStallMonitorJournalPath(teamName)}.sqlite-fallback-replica`,
      (value): value is { entries: TaskStallJournalEntry[] } => Boolean(value)
    );
    await stallReplica.writeClean('replica-team', { entries: [replicatedStall] });

    const replicatedComment: TaskCommentNotificationJournalEntry = {
      key: 'task-replicated:comment-1',
      taskId: 'task-replicated',
      commentId: 'comment-1',
      author: 'bob',
      messageId: 'message-1',
      state: 'sent',
      createdAt: '2026-07-07T09:00:00.000Z',
      updatedAt: '2026-07-07T09:05:00.000Z',
      sentAt: '2026-07-07T09:05:00.000Z',
    };
    const commentReplica = new InternalStorageJsonReplica<{
      initialized: boolean;
      entries: TaskCommentNotificationJournalEntry[];
    }>(
      (teamName) => `${getCommentNotificationJournalPath(teamName)}.sqlite-fallback-replica`,
      (
        value
      ): value is {
        initialized: boolean;
        entries: TaskCommentNotificationJournalEntry[];
      } => Boolean(value)
    );
    await commentReplica.writeClean('replica-team', {
      initialized: true,
      entries: [replicatedComment],
    });

    // Under vitest the worker is unavailable or has the Electron ABI. No
    // selector-backed write may fall back to JSON while SQLite can appear.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const feature = createInternalStorageFeature({
      userDataPath: path.join(tmpDir, 'user-data'),
    });

    const entry: TaskStallJournalEntry = {
      epochKey: 'task-a:epoch-1',
      teamName: 'demo',
      taskId: 'task-a',
      branch: 'work',
      signal: 'turn_ended_after_touch',
      state: 'suspected',
      consecutiveScans: 1,
      createdAt: '2026-07-07T10:00:00.000Z',
      updatedAt: '2026-07-07T10:00:00.000Z',
    };
    await expect(
      feature.taskStallJournalStore.update('demo', (entries) => {
        entries.push(entry);
        return { entries, result: undefined };
      })
    ).rejects.toThrow(/JSON fallback is disabled/);
    expect(feature.getBackendKind()).toBe('verification-required');
    await expect(fs.readFile(getStallMonitorJournalPath('demo'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(feature.taskCommentNotificationJournalStore.exists('demo')).rejects.toThrow(
      /JSON fallback is disabled/
    );
    await expect(
      feature.taskCommentNotificationJournalStore.ensureInitialized('demo')
    ).rejects.toThrow(/JSON fallback is disabled/);
    await expect(
      feature.taskStallJournalStore.update('replica-team', (entries) => ({
        entries,
        result: entries[0],
        changed: false,
      }))
    ).rejects.toThrow(/JSON fallback is disabled/);
    await expect(feature.taskCommentNotificationJournalStore.read('replica-team')).rejects.toThrow(
      /JSON fallback is disabled/
    );
    await expect(stallReplica.readClean('replica-team', true)).resolves.toMatchObject({
      entries: [replicatedStall],
    });
    await expect(commentReplica.readClean('replica-team', true)).resolves.toMatchObject({
      initialized: true,
      entries: [replicatedComment],
    });
    expect(feature.memberWorkSyncBackend).not.toBeNull();
    await expect(feature.memberWorkSyncBackend!.selector.select('sqlite', 'json')).rejects.toThrow(
      /JSON fallback is disabled/
    );
    expect(feature.customTeamTemplatesBackend.gateway === null).toBe(
      feature.applicationCommandLedgerBackend === null
    );

    await feature.dispose();
  });
});
