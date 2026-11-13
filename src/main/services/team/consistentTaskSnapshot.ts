import { getTasksBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';

import { RegistryTaskProviderError } from './registry/RegistryTaskProvider';
import { TeamSpecBindingError } from './registry/TeamSpecBinding';

import type { TeamKanbanManager } from './TeamKanbanManager';
import type { KanbanState } from '@shared/types';

export async function listTaskTeamNames(): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(getTasksBasePath(), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function isKanbanError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return (
    code === 'KANBAN_TRANSITION_UNCERTAIN' ||
    code === 'KANBAN_SNAPSHOT_CHANGED' ||
    (error instanceof Error &&
      (error.message.includes('KANBAN_TRANSITION_UNCERTAIN') ||
        error.message.includes('KANBAN_SNAPSHOT_CHANGED')))
  );
}

/** Do not combine tasks from one board revision with the next board revision. */
export async function readConsistentTaskSnapshot<T>(
  manager: Pick<TeamKanbanManager, 'getState'>,
  teamName: string,
  readFreshTasks: () => Promise<T>
): Promise<{ tasks: T; kanbanState: KanbanState }> {
  const readBoard = async (): Promise<KanbanState> => {
    try {
      return await manager.getState(teamName, { strict: true });
    } catch (error) {
      if (isKanbanError(error)) throw error;
      throw Object.assign(
        new Error(
          'KANBAN_SNAPSHOT_CHANGED: Cannot verify the Kanban snapshot; open the team again.'
        ),
        { code: 'KANBAN_SNAPSHOT_CHANGED', cause: error }
      );
    }
  };
  const before = await readBoard();
  let tasks: T;
  try {
    tasks = await readFreshTasks();
  } catch (error) {
    if (error instanceof RegistryTaskProviderError || error instanceof TeamSpecBindingError)
      throw error;
    if (isKanbanError(error)) throw error;
    throw Object.assign(
      new Error('KANBAN_SNAPSHOT_CHANGED: Cannot verify task data; open the team again.'),
      { code: 'KANBAN_SNAPSHOT_CHANGED', cause: error }
    );
  }
  const after = await readBoard();
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw Object.assign(
      new Error(
        'KANBAN_SNAPSHOT_CHANGED: Kanban changed while tasks were read; open the team again.'
      ),
      { code: 'KANBAN_SNAPSHOT_CHANGED' }
    );
  }
  return { tasks, kanbanState: after };
}
