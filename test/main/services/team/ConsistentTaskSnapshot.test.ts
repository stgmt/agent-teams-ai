import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { createController } from 'agent-teams-controller';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ dir: '' }));
vi.mock('agent-teams-controller', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('../../../../agent-teams-controller/src/index.js');
});
vi.mock('@main/utils/pathDecoder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/utils/pathDecoder')>()),
  getTeamsBasePath: () => path.join(fixture.dir, 'teams'),
  getTasksBasePath: () => path.join(fixture.dir, 'tasks'),
}));

import { readConsistentTaskSnapshot } from '@main/services/team/consistentTaskSnapshot';
import { TeamDataService } from '@main/services/team/TeamDataService';
import { TeamKanbanManager } from '@main/services/team/TeamKanbanManager';
import { TeamTaskReader } from '@main/services/team/TeamTaskReader';

describe('consistent task and board snapshots', () => {
  let teamDir: string;
  let board: {
    createTask: (input: object) => { id: string };
    completeTask: (id: string, actor: string) => void;
    requestReview: (id: string, options: object) => void;
  };
  let taskId: string;
  let reader: TeamTaskReader;
  let manager: TeamKanbanManager;

  beforeEach(() => {
    fixture.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'consistent-task-test-'));
    teamDir = path.join(fixture.dir, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'fixture',
        members: [
          { name: 'lead', role: 'team-lead' },
          { name: 'worker', role: 'developer' },
        ],
      })
    );
    const controller = createController({ teamName: 'fixture', claudeDir: fixture.dir });
    board = controller.taskBoard as unknown as typeof board;
    taskId = board.createTask({ subject: 'fixture', owner: 'worker' }).id;
    board.completeTask(taskId, 'worker');
    controller.kanban.addReviewer('lead');
    reader = new TeamTaskReader();
    manager = new TeamKanbanManager();
  });
  afterEach(() => {
    const target = path.resolve(fixture.dir);
    if (
      !target.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
      !path.basename(target).startsWith('consistent-task-test-')
    ) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it('rejects a transition interrupted between the first board read and task read', async () => {
    const rawFs = createRequire(import.meta.url)('fs') as typeof fs;
    const original = rawFs.writeFileSync;
    await expect(
      readConsistentTaskSnapshot(manager, 'fixture', async () => {
        const spy = vi.spyOn(rawFs, 'writeFileSync').mockImplementation(((
          target: fs.PathOrFileDescriptor,
          ...args: unknown[]
        ) => {
          if (
            typeof target === 'string' &&
            path.dirname(target) === teamDir &&
            path.basename(target).startsWith('.tmp.')
          ) {
            throw Object.assign(new Error('board EIO'), { code: 'EIO' });
          }
          return (original as (...parts: unknown[]) => void)(target, ...args);
        }) as typeof fs.writeFileSync);
        try {
          expect(() => board.requestReview(taskId, { from: 'worker', reviewer: 'lead' })).toThrow();
        } finally {
          spy.mockRestore();
        }
        return reader.getTasksProjectionSnapshot('fixture', { fresh: true });
      })
    ).rejects.toMatchObject({ code: 'KANBAN_TRANSITION_UNCERTAIN' });
  });

  it('rejects when a successful transition changes the board after tasks were read', async () => {
    await expect(
      readConsistentTaskSnapshot(manager, 'fixture', async () => {
        const tasks = await reader.getTasksProjectionSnapshot('fixture', { fresh: true });
        board.requestReview(taskId, { from: 'worker', reviewer: 'lead' });
        return tasks;
      })
    ).rejects.toMatchObject({ code: 'KANBAN_SNAPSHOT_CHANGED' });
  });

  it('uses fresh tasks for the global list and ignores orphan task directories', async () => {
    const configReader = {
      getConfigSnapshot: vi.fn(async () => ({ name: 'fixture', members: [{ name: 'lead' }] })),
      listTeams: vi.fn(async () => []),
    };
    const service = new TeamDataService(
      configReader as never,
      reader,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      manager
    );
    const before = await service.getAllTasks();
    expect(before.find((task) => task.id === taskId)?.reviewState).toBe('none');
    board.requestReview(taskId, { from: 'worker', reviewer: 'lead' });
    const orphan = path.join(fixture.dir, 'tasks', 'orphan');
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, 'broken.json'), '{');
    const after = await service.getAllTasks();
    expect(after.find((task) => task.id === taskId)?.reviewState).toBe('review');
    expect(fs.existsSync(path.join(fixture.dir, 'teams', 'orphan'))).toBe(false);
  });

  it('does not recreate a team deleted after global list discovery', async () => {
    const configReader = {
      getConfigSnapshot: vi.fn(async () => ({ name: 'fixture', members: [{ name: 'lead' }] })),
      listTeams: vi.fn(async () => []),
    };
    const service = new TeamDataService(
      configReader as never,
      reader,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      manager
    );
    const rawFs = createRequire(import.meta.url)('fs') as typeof fs;
    const original = rawFs.promises.stat;
    let detached = false;
    const spy = vi.spyOn(rawFs.promises, 'stat').mockImplementation((async (
      target: fs.PathLike,
      ...args: unknown[]
    ) => {
      const result = await (original as (...parts: unknown[]) => Promise<fs.Stats>)(
        target,
        ...args
      );
      if (!detached && path.resolve(String(target)) === path.join(teamDir, 'config.json')) {
        fs.renameSync(teamDir, path.join(fixture.dir, 'teams', 'fixture-detached'));
        detached = true;
      }
      return result;
    }) as typeof rawFs.promises.stat);
    try {
      await expect(service.getAllTasks()).rejects.toMatchObject({
        code: 'KANBAN_SNAPSHOT_CHANGED',
      });
      expect(detached).toBe(true);
      expect(fs.existsSync(teamDir)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
