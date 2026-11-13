import {
  registryTaskFixtureConfigReader,
  registryTaskFixtureMetaStore,
  registryBoardSnapshotFixture,
} from '../../helpers/teamRuntimeSnapshot';
import { knownEmptyTeamRuntimeSnapshot } from '../../helpers/teamRuntimeSnapshot';
// @vitest-environment node
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { BackendSelectingTaskCommentNotificationJournalStore } from '@features/internal-storage/main/composition/BackendSelectingTaskCommentNotificationJournalStore';
import { createInternalStorageFeature } from '@features/internal-storage/main/composition/createInternalStorageFeature';
import { InternalStorageJsonReplica } from '@features/internal-storage/main/infrastructure/InternalStorageJsonReplica';
import { InternalStorageWorkerClient } from '@features/internal-storage/main/infrastructure/InternalStorageWorkerClient';
import { createInternalStorageCommentWarning } from '@main/internalStorageCommentWarning';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamTaskCommentNotificationJournal } from '@main/services/team/TeamTaskCommentNotificationJournal';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  const parent = await fs.realpath(os.tmpdir());
  for (const root of roots.splice(0)) {
    const target = await fs.realpath(root);
    const relative = path.relative(parent, target);
    if (!relative.startsWith('comment-journal-warning-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a test fixture outside its scratch parent');
    }
    await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});

describe('comment forwarding storage diagnostics', () => {
  it('reports an unavailable forwarding journal through the production team service without sending a message', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-journal-warning-'));
    roots.push(root);
    const previousFlag = process.env.CLAUDE_TEAM_TASK_COMMENT_FORWARDING;
    process.env.CLAUDE_TEAM_TASK_COMMENT_FORWARDING = 'on';
    setClaudeBasePathOverride(root);
    await fs.mkdir(path.join(root, 'teams', 'fixture'), { recursive: true });
    vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(false);
    const publish = vi.fn(async (_warning: unknown) => undefined);
    const storage = createInternalStorageFeature({
      userDataPath: path.join(root, 'userdata'),
      onCommentJournalFailure: createInternalStorageCommentWarning(publish, () => 'ru').onFailure,
    });
    const getConfig = vi.fn(async () => ({
      name: 'fixture',
      members: [{ name: 'team-lead', role: 'Lead' }],
      leadSessionId: 'lead',
    }));
    const getTasks = vi.fn(async () => [
      {
        id: 'task-1',
        displayId: 'abcd1234',
        subject: 'Fixture',
        status: 'pending',
        owner: 'alice',
        comments: [
          {
            id: 'comment-1',
            author: 'alice',
            text: 'Fixture comment',
            createdAt: '2026-03-14T10:00:00.000Z',
            type: 'regular',
          },
        ],
      },
    ]);
    const inboxReader = {
      listInboxNames: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
      getMessagesFor: vi.fn(async () => []),
    };
    const sendMessage = vi.fn(async () => ({ deliveredToInbox: true, messageId: 'fixture' }));
    const service = new TeamDataService(
      knownEmptyTeamRuntimeSnapshot,
      registryTaskFixtureConfigReader({ listTeams: vi.fn(), getConfig } as never),
      inboxReader as never,
      { sendMessage } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      (() => ({}) as never) as never,
      new TeamTaskCommentNotificationJournal(storage.taskCommentNotificationJournalStore),
      registryTaskFixtureMetaStore(undefined),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      registryBoardSnapshotFixture({ getTasks } as never)
    );
    service.setTeamProfileOwnership(async (teamName) => teamName === 'fixture');
    try {
      await service.notifyLeadOnTeammateTaskComment('fixture', 'task-1');
      await Promise.resolve();
      expect(sendMessage).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledOnce();
      expect(publish.mock.calls[0][0]).toMatchObject({
        source: 'internal-storage',
        target: { kind: 'team', teamName: 'fixture', section: 'tasks' },
      });
      expect((publish.mock.calls[0][0] as { message: string }).message).toContain(
        'результат неизвестен'
      );
    } finally {
      await storage.dispose();
      setClaudeBasePathOverride(null);
      if (previousFlag === undefined) delete process.env.CLAUDE_TEAM_TASK_COMMENT_FORWARDING;
      else process.env.CLAUDE_TEAM_TASK_COMMENT_FORWARDING = previousFlag;
    }
  });

  it('reports a blocked production journal and preserves the original failure', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'comment-journal-warning-'));
    roots.push(root);
    vi.spyOn(InternalStorageWorkerClient.prototype, 'isAvailable').mockReturnValue(false);
    const onCommentJournalFailure = vi.fn();
    const storage = createInternalStorageFeature({ userDataPath: root, onCommentJournalFailure });
    try {
      await expect(
        storage.taskCommentNotificationJournalStore.exists('fixture-team')
      ).rejects.toThrow(/storage/i);
      expect(onCommentJournalFailure).toHaveBeenCalledOnce();
      expect(onCommentJournalFailure.mock.calls[0][0]).toBe('fixture-team');
      expect(onCommentJournalFailure.mock.calls[0][1]).toBeInstanceOf(Error);
    } finally {
      await storage.dispose();
    }
  });

  it('reports a new journal outage after a successful mutation, without retrying either write', async () => {
    vi.spyOn(InternalStorageJsonReplica.prototype, 'readForPrimary').mockResolvedValue(null);
    vi.spyOn(InternalStorageJsonReplica.prototype, 'markDirty').mockResolvedValue(undefined);
    vi.spyOn(InternalStorageJsonReplica.prototype, 'writeClean').mockResolvedValue(undefined);
    const publish = vi.fn(async (_warning: unknown) => undefined);
    const warning = createInternalStorageCommentWarning(publish, () => 'ru');
    const ensureInitialized = vi
      .fn()
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second failure'));
    const sqlite = {
      ensureInitialized,
      exists: vi.fn(async () => true),
      read: vi.fn(async () => []),
    };
    const selector = { select: vi.fn(async () => 'sqlite'), getBackendInfo: vi.fn(() => null) };
    const store = new BackendSelectingTaskCommentNotificationJournalStore(
      selector as never,
      sqlite as never,
      {} as never,
      {
        fallbackRequiresReplica: false,
        onFailure: warning.onFailure,
        onMutationSuccess: warning.onMutationSuccess,
      }
    );
    await expect(store.ensureInitialized('fixture-team')).rejects.toThrow('first failure');
    await store.ensureInitialized('fixture-team');
    await expect(store.ensureInitialized('fixture-team')).rejects.toThrow('second failure');
    expect(ensureInitialized).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
