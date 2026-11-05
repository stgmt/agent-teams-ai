import { useSyncExternalStore } from 'react';

/** One dispatched library write which may still complete. */
export interface PendingTemplateMutation {
  id: string;
  kind: 'duplicate' | 'copyBuiltin' | 'delete' | 'save' | 'edit' | 'import' | 'unknown';
  label: string;
}

type NewMutation = Omit<PendingTemplateMutation, 'id'>;
type Snapshot = { operations: readonly PendingTemplateMutation[]; storageAvailable: boolean };
const PREFIX = 'agent-teams:custom-template-pending-mutation:';
const PROBE_KEY = 'agent-teams:custom-template-mutation-storage-probe';
const listeners = new Set<() => void>();
let snapshot: Snapshot = { operations: [], storageAvailable: true };

function publish(operations: readonly PendingTemplateMutation[], storageAvailable: boolean): void {
  snapshot = { operations, storageAvailable };
  for (const listener of listeners) listener();
}

function parseOperation(id: string, raw: string | null): PendingTemplateMutation {
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (typeof value === 'object' && value !== null) {
      const candidate = value as Partial<NewMutation>;
      if (
        ['duplicate', 'copyBuiltin', 'delete', 'save', 'edit', 'import'].includes(
          candidate.kind ?? ''
        ) &&
        typeof candidate.label === 'string' &&
        candidate.label.length <= 512
      ) {
        return { id, kind: candidate.kind as NewMutation['kind'], label: candidate.label };
      }
    }
  } catch {
    // A damaged marker must still prevent writes until the user decides.
  }
  return { id, kind: 'unknown', label: '' };
}

function refresh(): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) throw new Error('localStorage unavailable');
    // Reading localStorage is not evidence that a recovery marker can be saved.
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    const next: PendingTemplateMutation[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(PREFIX)) continue;
      const id = key.slice(PREFIX.length);
      const parsed = parseOperation(id, storage.getItem(key));
      const previous = snapshot.operations.find((item) => item.id === id);
      next.push(
        previous && previous.kind === parsed.kind && previous.label === parsed.label
          ? previous
          : parsed
      );
    }
    // Markers created while storage was unavailable remain blocked in memory.
    if (!snapshot.storageAvailable) {
      for (const item of snapshot.operations)
        if (!next.some((entry) => entry.id === item.id)) next.push(item);
    }
    if (
      !snapshot.storageAvailable ||
      next.length !== snapshot.operations.length ||
      next.some((item, index) => item !== snapshot.operations[index])
    ) {
      publish(next, true);
    }
  } catch {
    if (snapshot.storageAvailable) publish(snapshot.operations, false);
  }
}

refresh();
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === null || event.key.startsWith(PREFIX)) refresh();
  });
}

function getSnapshot(): Snapshot {
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getPendingTemplateMutation(): PendingTemplateMutation | null {
  refresh();
  return snapshot.operations[0] ?? null;
}

export function getPendingTemplateMutations(): readonly PendingTemplateMutation[] {
  refresh();
  return snapshot.operations;
}

/** Record before dispatch. A failed persistent marker prevents the write. */
export function beginTemplateMutation(value: NewMutation): PendingTemplateMutation | null {
  refresh();
  if (!snapshot.storageAvailable || snapshot.operations.length) return null;
  try {
    const id = newOperationId();
    const operation = { id, ...value };
    globalThis.localStorage.setItem(PREFIX + id, JSON.stringify(value));
    publish([...snapshot.operations, operation], true);
    return operation;
  } catch {
    publish(snapshot.operations, false);
    return null;
  }
}

/** Remove only the identified operation after its response is definitive. */
export function finishTemplateMutation(operation: PendingTemplateMutation): void {
  try {
    globalThis.localStorage.removeItem(PREFIX + operation.id);
    publish(
      snapshot.operations.filter((item) => item.id !== operation.id),
      true
    );
    refresh();
  } catch {
    publish(snapshot.operations, false);
  }
}

/** Test helper: inject or clear independent markers. */
export function setPendingTemplateMutation(value: NewMutation | null): void {
  if (value) {
    const operation = { id: newOperationId(), ...value };
    globalThis.localStorage.setItem(PREFIX + operation.id, JSON.stringify(value));
    publish([...snapshot.operations, operation], true);
  } else {
    for (const operation of snapshot.operations)
      globalThis.localStorage.removeItem(PREFIX + operation.id);
    publish([], true);
  }
}

function newOperationId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function usePendingTemplateMutations(): Snapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function usePendingTemplateMutation(): PendingTemplateMutation | null {
  return usePendingTemplateMutations().operations[0] ?? null;
}
