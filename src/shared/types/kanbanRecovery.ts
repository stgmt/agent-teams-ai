export interface PendingKanbanTransitionSnapshot {
  taskId: string;
  contextHash: string;
  transitionId: string;
  column: 'review' | 'approved';
  currentColumn?: 'review' | 'approved' | null;
  mode: 'publish' | 'clear' | 'conflict';
  reason?: 'artifact_invalid';
  snapshotHash?: string;
}

export type KanbanRecoveryPatch =
  | { op: 'inspect_pending' }
  | {
      op: 'resolve_pending';
      transitionId: string;
      snapshotHash: string;
      mode: 'publish' | 'clear';
      contextHash: string;
    };
