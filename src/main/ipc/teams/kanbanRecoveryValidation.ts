import type { KanbanRecoveryPatch } from '@shared/types/kanbanRecovery';

export function isKanbanRecoveryPatch(value: unknown): value is KanbanRecoveryPatch {
  if (!value || typeof value !== 'object' || !('op' in value)) return false;
  if (value.op === 'inspect_pending') return true;
  if (value.op !== 'resolve_pending') return false;
  const patch = value as Partial<Extract<KanbanRecoveryPatch, { op: 'resolve_pending' }>>;
  return (
    typeof patch.transitionId === 'string' &&
    /^[0-9a-f-]{36}$/i.test(patch.transitionId) &&
    typeof patch.snapshotHash === 'string' &&
    /^[0-9a-f]{64}$/i.test(patch.snapshotHash) &&
    typeof patch.contextHash === 'string' &&
    /^[0-9a-f]{64}$/i.test(patch.contextHash) &&
    (patch.mode === 'publish' || patch.mode === 'clear')
  );
}
