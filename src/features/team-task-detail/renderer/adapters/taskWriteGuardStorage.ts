import { get, update } from 'idb-keyval';

import type { TaskDetailIdentity, TaskWriteOperation } from '../../contracts';

export interface TaskWriteGuardMarker {
  version: 1;
  attemptId: string;
  operation: TaskWriteOperation;
}

export interface TaskWriteGuardIdentity extends TaskDetailIdentity {
  dataRootFingerprint: string;
}

export class TaskWriteGuardOccupiedError extends Error {
  constructor(public readonly marker: TaskWriteGuardMarker) {
    super('A previous task write requires attention');
  }
}

export const taskWriteGuardKey = (identity: TaskWriteGuardIdentity): string => {
  if (!/^[a-f0-9]{64}$/i.test(identity.dataRootFingerprint))
    throw new Error('Task data root fingerprint is unavailable');
  return `task-write-guard:${JSON.stringify([identity.dataRootFingerprint, identity.contextId, identity.teamName, identity.taskId])}`;
};

function parseMarker(value: unknown): TaskWriteGuardMarker | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object')
    throw new Error('Task write safety marker is unreadable');
  const marker = value as Record<string, unknown>;
  if (
    marker.version !== 1 ||
    typeof marker.attemptId !== 'string' ||
    !marker.attemptId ||
    (marker.operation !== 'artifact' && marker.operation !== 'manifest')
  ) {
    throw new Error('Task write safety marker is unreadable');
  }
  return marker as unknown as TaskWriteGuardMarker;
}

interface GuardBackend {
  get(key: string): Promise<unknown>;
  update(key: string, change: (value: unknown) => unknown): Promise<void>;
}

export function createTaskWriteGuardStorage(
  backend: GuardBackend = {
    get: (key) => get(key),
    update: (key, change) => update(key, change),
  }
) {
  return {
    async read(identity: TaskWriteGuardIdentity): Promise<TaskWriteGuardMarker | null> {
      return parseMarker(await backend.get(taskWriteGuardKey(identity)));
    },
    async acquire(identity: TaskWriteGuardIdentity, marker: TaskWriteGuardMarker): Promise<void> {
      let occupied: TaskWriteGuardMarker | null = null;
      await backend.update(taskWriteGuardKey(identity), (value: unknown) => {
        occupied = parseMarker(value);
        return occupied ?? marker;
      });
      if (occupied) throw new TaskWriteGuardOccupiedError(occupied);
    },
    async release(
      identity: TaskWriteGuardIdentity,
      marker: TaskWriteGuardMarker,
      options: { allowMissingAfterDecision?: boolean } = {}
    ): Promise<void> {
      let released = false;
      await backend.update(taskWriteGuardKey(identity), (value: unknown) => {
        const current = parseMarker(value);
        if (!current && options.allowMissingAfterDecision) {
          released = true;
          return value;
        }
        if (current?.attemptId === marker.attemptId && current.operation === marker.operation) {
          released = true;
          return null;
        }
        return value;
      });
      if (!released) throw new Error('Task write safety marker changed');
    },
  };
}

export const taskWriteGuardStorage = createTaskWriteGuardStorage();
