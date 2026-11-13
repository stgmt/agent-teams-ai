import { readConsistentTaskSnapshot } from '@main/services/team/consistentTaskSnapshot';
import { describe, expect, it, vi } from 'vitest';

import type { KanbanState, TeamTask } from '@shared/types';

describe('consistent registry task and board snapshots', () => {
  const task: TeamTask = { id: 'TASK-1', subject: 'Registry work', status: 'in_progress' };
  const initial: KanbanState = { teamName: 'fixture', reviewers: ['lead'], tasks: {} };

  it('rejects a transition interrupted between the first board read and registry task read', async () => {
    let uncertain = false;
    const manager = {
      getState: vi.fn(async () => {
        if (uncertain)
          throw Object.assign(new Error('Interrupted transition'), {
            code: 'KANBAN_TRANSITION_UNCERTAIN',
          });
        return initial;
      }),
    };
    const readTasks = vi.fn(async () => {
      uncertain = true;
      return [task];
    });
    await expect(readConsistentTaskSnapshot(manager, 'fixture', readTasks)).rejects.toMatchObject({
      code: 'KANBAN_TRANSITION_UNCERTAIN',
    });
    expect(readTasks).toHaveBeenCalledOnce();
  });

  it('rejects when a successful transition changes the board after registry tasks were read', async () => {
    let state = initial;
    const manager = { getState: vi.fn(async () => state) };
    await expect(
      readConsistentTaskSnapshot(manager, 'fixture', async () => {
        state = { ...initial, reviewers: ['lead', 'reviewer'] };
        return [task];
      })
    ).rejects.toMatchObject({ code: 'KANBAN_SNAPSHOT_CHANGED' });
  });

  it('publishes the registry tasks only when both board reads observe the same state', async () => {
    const manager = { getState: vi.fn(async () => initial) };
    const snapshot = await readConsistentTaskSnapshot(manager, 'fixture', async () => [task]);
    expect(snapshot).toEqual({ tasks: [task], kanbanState: initial });
  });
});
