import { RegistryTeamTaskWriteError } from './RegistryTeamTaskWriteErrors';

import type { RegistryTask, RegistryTaskStatus } from './RegistryTaskClientTypes';
import type { TeamSpecBinding } from './TeamSpecBinding';
import type { TeamTaskStatus } from '@shared/types';

export const TEAM_TO_REGISTRY_STATUS: Record<TeamTaskStatus, RegistryTaskStatus> = {
  pending: 'todo',
  in_progress: 'in-progress',
  completed: 'done',
  deleted: 'deleted',
};

export const REGISTRY_TO_TEAM_STATUS: Record<RegistryTaskStatus, TeamTaskStatus> = {
  planned: 'pending',
  todo: 'pending',
  ready: 'pending',
  'in-progress': 'in_progress',
  blocked: 'pending',
  done: 'completed',
  deleted: 'deleted',
  deferred: 'pending',
  unknown: 'pending',
};

const LOCAL_TASK_ID_PATTERN = /^(?:TASK-)?(\d+)$/i;

/** `TASK-7` / `7` / `<spec>:TASK-7` → `7`; anything else → `null`. */
export function normalizeLocalId(value: string): string | null {
  const trimmed = value.trim();
  const match = LOCAL_TASK_ID_PATTERN.exec(trimmed);
  if (match) return match[1];
  const namespaced = /^[^:]+:TASK-(\d+)$/i.exec(trimmed);
  return namespaced ? namespaced[1] : null;
}

export function canonicalTaskRef(spec: string, localId: string): string {
  return `${spec}:TASK-${localId}`;
}

/** `refs` may hold non-task nodes; only `<this spec>:TASK-n` links map to a team task id. */
export function localIdFromRef(spec: string, ref: string): string | null {
  const match = /^([^:]+):TASK-(\d+)$/i.exec(ref.trim());
  if (match?.[1] !== spec) return null;
  return match[2];
}

export function normalizeTaskIds(taskIds: readonly string[] | undefined): string[] {
  return [
    ...new Set(
      (taskIds ?? []).map((value) => {
        const id = normalizeLocalId(value);
        if (!id)
          throw new RegistryTeamTaskWriteError(
            'TASK_NOT_FOUND',
            `Invalid task reference: ${value}`
          );
        return id;
      })
    ),
  ].sort();
}

export function taskRefs(spec: string, taskIds: readonly string[] | undefined): string[] {
  return normalizeTaskIds(taskIds).map((value) => canonicalTaskRef(spec, value));
}

export function allocateLocalId(tasks: readonly RegistryTask[], binding: TeamSpecBinding): string {
  let max = 0;
  for (const task of tasks) {
    const parsed = normalizeLocalId(task.localId);
    if (parsed !== null) max = Math.max(max, Number.parseInt(parsed, 10));
  }
  const next = String(max + 1);
  if (tasks.some((task) => normalizeLocalId(task.localId) === next)) {
    throw new RegistryTeamTaskWriteError(
      'LOCAL_ID_TAKEN',
      `Task #${next} already exists in ${binding.project}/${binding.spec}`,
      { taskId: next }
    );
  }
  return next;
}
