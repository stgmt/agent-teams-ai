import type { KanbanState } from './team';

/** Durable evidence for one task/board transition that needs explicit recovery. */
export interface PendingKanbanTransition {
  id: string;
  taskId: string;
  kind: 'status' | 'review';
  phase: 'prepared' | 'applied';
  column: 'review' | 'approved' | 'none';
  operation?: 'status' | 'request_changes' | 'clear';
  targetStatus?: 'pending' | 'in_progress' | 'completed' | 'deleted';
  beforeTaskHash: string;
  expectedTaskHash: string;
  beforeBoardHash: string;
  expectedBoardHash: string;
  beforeBoardToken: string;
  targetBoard: KanbanState;
  contextHash: string;
  verifyArtifact?: boolean;
}

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
