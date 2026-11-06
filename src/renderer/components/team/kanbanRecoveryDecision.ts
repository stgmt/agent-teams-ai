import { get, update } from 'idb-keyval';

import type { PendingKanbanTransitionSnapshot } from '@shared/types/kanbanRecovery';

type RecoveryMode = 'cancel' | 'publish' | 'clear';
export type RecoveryDecisionPhase =
  | 'prompting'
  | 'declined'
  | 'sending'
  | 'confirmed'
  | 'unknown'
  | 'not_sent';

export interface RecoveryDecisionRecord {
  version: 1;
  owner: string;
  teamName: string;
  taskId: string;
  mode: RecoveryMode;
  snapshotHash: string;
  phase: RecoveryDecisionPhase;
}

interface DecisionBackend {
  get(key: string): Promise<unknown>;
  update(key: string, change: (value: unknown) => unknown): Promise<void>;
}

export function kanbanRecoveryDecisionKey(snapshot: PendingKanbanTransitionSnapshot): string {
  if (
    !/^[0-9a-f]{64}$/i.test(snapshot.contextHash) ||
    !/^[0-9a-f-]{36}$/i.test(snapshot.transitionId)
  ) {
    throw new Error('Recovery identity is unavailable');
  }
  // The operation UUID is unique within a root. Do not key by spelling of a
  // team path: aliases of the same physical team must share the claim.
  return `kanban-recovery-decision:${JSON.stringify([
    snapshot.contextHash.toLowerCase(),
    snapshot.transitionId.toLowerCase(),
  ])}`;
}

function parse(value: unknown): RecoveryDecisionRecord | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object') throw new Error('Recovery decision is unreadable');
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1 ||
    typeof item.owner !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(item.owner) ||
    typeof item.teamName !== 'string' ||
    !item.teamName ||
    typeof item.taskId !== 'string' ||
    !item.taskId ||
    (item.mode !== 'cancel' && item.mode !== 'publish' && item.mode !== 'clear') ||
    typeof item.snapshotHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(item.snapshotHash) ||
    !['prompting', 'declined', 'sending', 'confirmed', 'unknown', 'not_sent'].includes(
      String(item.phase)
    )
  ) {
    throw new Error('Recovery decision is unreadable');
  }
  return item as unknown as RecoveryDecisionRecord;
}

function matches(
  record: RecoveryDecisionRecord,
  teamName: string,
  snapshot: PendingKanbanTransitionSnapshot
): boolean {
  return (
    record.teamName === teamName &&
    record.taskId === snapshot.taskId &&
    record.mode === snapshot.mode &&
    record.snapshotHash === snapshot.snapshotHash
  );
}

export function createKanbanRecoveryDecisionStorage(
  backend: DecisionBackend = {
    get: (key) => get(key),
    update: (key, change) => update(key, change),
  }
) {
  return {
    async read(snapshot: PendingKanbanTransitionSnapshot): Promise<RecoveryDecisionRecord | null> {
      return parse(await backend.get(kanbanRecoveryDecisionKey(snapshot)));
    },
    async claim(
      teamName: string,
      snapshot: PendingKanbanTransitionSnapshot
    ): Promise<{ claimed: boolean; record: RecoveryDecisionRecord }> {
      if (
        snapshot.mode === 'conflict' ||
        !snapshot.snapshotHash ||
        !/^[0-9a-f]{64}$/i.test(snapshot.snapshotHash)
      ) {
        throw new Error('Recovery snapshot is unavailable');
      }
      const proposed: RecoveryDecisionRecord = {
        version: 1,
        owner: crypto.randomUUID(),
        teamName,
        taskId: snapshot.taskId,
        mode: snapshot.mode,
        snapshotHash: snapshot.snapshotHash,
        phase: 'prompting',
      };
      let claimed = false;
      let observed = proposed;
      await backend.update(kanbanRecoveryDecisionKey(snapshot), (value) => {
        const current = parse(value);
        if (current) {
          observed = current;
          return current;
        }
        claimed = true;
        return proposed;
      });
      return { claimed, record: observed };
    },
    async transition(
      teamName: string,
      snapshot: PendingKanbanTransitionSnapshot,
      owner: string,
      from: readonly RecoveryDecisionPhase[],
      to: RecoveryDecisionPhase | null
    ): Promise<void> {
      let changed = false;
      await backend.update(kanbanRecoveryDecisionKey(snapshot), (value) => {
        const current = parse(value);
        if (!current || current.owner !== owner || !matches(current, teamName, snapshot))
          return value;
        if (!from.includes(current.phase)) return value;
        changed = true;
        return to === null ? undefined : { ...current, phase: to };
      });
      if (!changed) throw new Error('Recovery decision changed');
    },
    matches,
  };
}

export const kanbanRecoveryDecisionStorage = createKanbanRecoveryDecisionStorage();
