export interface PendingKanbanTransitionSnapshot {
  taskId: string;
  contextHash: string;
  transitionId: string;
  column: 'review' | 'approved' | 'none';
  currentColumn?: 'review' | 'approved' | null;
  targetStatus?: 'pending' | 'in_progress' | 'completed' | 'deleted';
  phase?: 'prepared' | 'applied';
  operation?: 'request_changes' | 'status' | 'clear';
  mode: 'cancel' | 'publish' | 'clear' | 'conflict';
  reason?: 'artifact_invalid';
  snapshotHash?: string;
}

export type KanbanRecoveryPatch =
  | { op: 'inspect_pending' }
  | {
      op: 'resolve_pending';
      transitionId: string;
      snapshotHash: string;
      mode: 'cancel' | 'publish' | 'clear';
      contextHash: string;
    };
