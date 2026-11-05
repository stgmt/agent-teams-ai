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

interface GuardState {
  version: 2;
  marker: TaskWriteGuardMarker | null;
  decisions: { attemptId: string; operation: TaskWriteOperation }[];
}

function parseState(value: unknown): GuardState {
  if (value === null || value === undefined) return { version: 2, marker: null, decisions: [] };
  if (!value || typeof value !== 'object')
    throw new Error('Task write safety marker is unreadable');
  const raw = value as Record<string, unknown>;
  if (raw.version === 1) return { version: 2, marker: parseMarker(value), decisions: [] };
  if (raw.version !== 2 || !Object.hasOwn(raw, 'marker') || !Array.isArray(raw.decisions))
    throw new Error('Task write safety marker is unreadable');
  const decisions: GuardState['decisions'] = raw.decisions.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object')
      throw new Error('Task write safety decision is unreadable');
    const item = entry as Record<string, unknown>;
    if (
      typeof item.attemptId !== 'string' ||
      !item.attemptId ||
      (item.operation !== 'artifact' && item.operation !== 'manifest')
    )
      throw new Error('Task write safety decision is unreadable');
    return { attemptId: item.attemptId, operation: item.operation };
  });
  return { version: 2, marker: parseMarker(raw.marker), decisions };
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
      return parseState(await backend.get(taskWriteGuardKey(identity))).marker;
    },
    async readDecision(
      identity: TaskWriteGuardIdentity,
      marker: TaskWriteGuardMarker
    ): Promise<{ explicitlyResolved: boolean; marker: TaskWriteGuardMarker | null }> {
      const state = parseState(await backend.get(taskWriteGuardKey(identity)));
      return {
        explicitlyResolved: state.decisions.some(
          (entry) => entry.attemptId === marker.attemptId && entry.operation === marker.operation
        ),
        marker: state.marker,
      };
    },
    async acquire(identity: TaskWriteGuardIdentity, marker: TaskWriteGuardMarker): Promise<void> {
      let occupied: TaskWriteGuardMarker | null = null;
      await backend.update(taskWriteGuardKey(identity), (value: unknown) => {
        const state = parseState(value);
        occupied = state.marker;
        return occupied ? state : { ...state, marker };
      });
      if (occupied) throw new TaskWriteGuardOccupiedError(occupied);
    },
    async release(
      identity: TaskWriteGuardIdentity,
      marker: TaskWriteGuardMarker,
      options: { explicitDecision?: boolean } = {}
    ): Promise<void> {
      let released = false;
      await backend.update(taskWriteGuardKey(identity), (value: unknown) => {
        const state = parseState(value);
        const current = state.marker;
        if (
          (!current && options.explicitDecision) ||
          (current?.attemptId === marker.attemptId && current.operation === marker.operation)
        ) {
          released = true;
          const alreadyRecorded = state.decisions.some(
            (entry) => entry.attemptId === marker.attemptId && entry.operation === marker.operation
          );
          const decisions =
            options.explicitDecision && !alreadyRecorded
              ? [...state.decisions, { attemptId: marker.attemptId, operation: marker.operation }]
              : state.decisions;
          return { ...state, marker: null, decisions };
        }
        return state;
      });
      if (!released) throw new Error('Task write safety marker changed');
    },
  };
}

export const taskWriteGuardStorage = createTaskWriteGuardStorage();
