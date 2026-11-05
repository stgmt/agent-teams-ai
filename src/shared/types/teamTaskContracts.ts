import type { AttachmentMediaType, AttachmentMeta } from '@features/agent-attachments/contracts';
import type { TaskRef } from './teamBoardTask';

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
export type TeamReviewState = 'none' | 'review' | 'needsFix' | 'approved';

export interface TaskWorkInterval {
  /** ISO timestamp when task entered in_progress */
  startedAt: string;
  /** ISO timestamp when task left in_progress (optional for active interval) */
  completedAt?: string;
}

export interface TaskReviewInterval {
  /** Reviewer actively reviewing during this interval. */
  reviewer: string;
  /** ISO timestamp when reviewer started or resumed review. */
  startedAt: string;
  /** ISO timestamp when reviewer stopped, paused, approved, or requested changes. */
  completedAt?: string;
}

// ---------------------------------------------------------------------------
// Task History Events — unified workflow event log
// ---------------------------------------------------------------------------

interface TaskHistoryEventBase {
  id: string;
  timestamp: string;
  actor?: string;
}

export interface TaskCreatedEvent extends TaskHistoryEventBase {
  type: 'task_created';
  status: TeamTaskStatus;
}

export interface TaskStatusChangedEvent extends TaskHistoryEventBase {
  type: 'status_changed';
  from: TeamTaskStatus;
  to: TeamTaskStatus;
}

export interface TaskOwnerChangedEvent extends TaskHistoryEventBase {
  type: 'owner_changed';
  from?: string;
  to?: string;
}

export interface TaskReviewRequestedEvent extends TaskHistoryEventBase {
  type: 'review_requested';
  from: TeamReviewState;
  to: 'review';
  reviewer?: string;
  note?: string;
}

export interface TaskReviewChangesRequestedEvent extends TaskHistoryEventBase {
  type: 'review_changes_requested';
  from: TeamReviewState;
  to: 'needsFix';
  note?: string;
}

export interface TaskReviewApprovedEvent extends TaskHistoryEventBase {
  type: 'review_approved';
  from: TeamReviewState;
  to: 'approved';
  note?: string;
}

export interface TaskReviewStartedEvent extends TaskHistoryEventBase {
  type: 'review_started';
  from: TeamReviewState;
  to: 'review';
}

export type TaskHistoryEvent =
  | TaskCreatedEvent
  | TaskStatusChangedEvent
  | TaskOwnerChangedEvent
  | TaskReviewRequestedEvent
  | TaskReviewChangesRequestedEvent
  | TaskReviewApprovedEvent
  | TaskReviewStartedEvent;

export type TaskCommentType = 'regular' | 'review_request' | 'review_approved';

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  type: TaskCommentType;
  taskRefs?: TaskRef[];
  /** Attachments on this comment. Metadata only — files stored on disk. */
  attachments?: TaskAttachmentMeta[];
}

/**
 * Snapshot of a user message captured at task-creation time.
 * Stored as provenance — the original message identity is `sourceMessageId`.
 */
export interface SourceMessageSnapshot {
  /** Sanitized message text (agent-only blocks stripped). */
  text: string;
  /** Who sent the message. */
  from: string;
  /** ISO timestamp of the original message. */
  timestamp: string;
  /** Message source type (e.g. "user_sent", "inbox"). */
  source?: string;
  /** Attachment metadata references (IDs only, no blobs). filePath present when file is stored on disk. */
  attachments?: AttachmentMeta[];
  /** IDs classified as generic file references in the original message. */
  fileReferenceIds?: string[];
}

/** Provenance for a retried agent task-creation command; not a canonical task identity. */
export interface TaskCreationCommand {
  namespace: string;
  scopeKey: string;
  operation: string;
  commandId: string;
  payloadHash: string;
}

// Fields are validated in TeamTaskReader.getTasks() using `satisfies Record<keyof TeamTask, unknown>`.
// Adding a field here without mapping it there will cause a compile error.
export interface TeamTask {
  id: string;
  /** Human-friendly short task label shown in UI. Canonical identity remains `id`. */
  displayId?: string;
  subject: string;
  description?: string;
  descriptionTaskRefs?: TaskRef[];
  /** Optional same-team group context; does not change task assignment or delivery. */
  groupChatId?: string;
  activeForm?: string;
  prompt?: string;
  promptTaskRefs?: TaskRef[];
  owner?: string;
  createdBy?: string;
  status: TeamTaskStatus;
  /**
   * One task can be worked on in multiple disjoint periods (e.g. review sends it back to in_progress).
   * We persist intervals for reliable log attribution without relying on heuristics.
   */
  workIntervals?: TaskWorkInterval[];
  /**
   * Review work periods, split across runtime pauses/restarts just like workIntervals.
   */
  reviewIntervals?: TaskReviewInterval[];
  /**
   * Unified workflow event log.
   * Append-only — records task creation, status changes, and review transitions.
   */
  historyEvents?: TaskHistoryEvent[];
  blocks?: string[];
  blockedBy?: string[];
  /**
   * Explicit task links (non-blocking). Used for navigation between related tasks,
   * e.g. "frontend task" ↔ "backend task" or a rare meta reminder ↔ the main work task.
   */
  related?: string[];
  createdAt?: string;
  /** File modification time (mtime). Used for sorting by last activity. */
  updatedAt?: string;
  projectPath?: string;
  comments?: TaskComment[];
  /** Signals that the agent is blocked and needs clarification. "lead" = ask team lead, "user" = escalated to human. */
  needsClarification?: 'lead' | 'user';
  /** ISO timestamp — when the task was soft-deleted. Only set for status === 'deleted'. */
  deletedAt?: string;
  /** Attachments associated with this task. Metadata only — actual files stored on disk. */
  attachments?: TaskAttachmentMeta[];
  /** Derived review state — computed from historyEvents, not persisted as authority. */
  reviewState?: TeamReviewState;
  /** Exact messageId of the user message this task was created from. */
  sourceMessageId?: string;
  /** Snapshot of the source message at creation time (sanitized, no blobs). */
  sourceMessage?: SourceMessageSnapshot;
  creationCommand?: TaskCreationCommand;
}

/** Task enriched for UI/DTO use (overlay from kanban-state.json). */
export type TaskChangePresenceState = 'has_changes' | 'needs_attention' | 'no_changes' | 'unknown';

export interface TeamTaskWithKanban extends TeamTask {
  /** Set when task is in team kanban (review or approved column). */
  kanbanColumn?: 'review' | 'approved';
  /** Reviewer assigned in kanban state, when applicable. */
  reviewer?: string | null;
  /** Cheap persisted change-presence state for kanban rendering. */
  changePresence?: TaskChangePresenceState;
}

/** Metadata for an attachment associated with a task or comment. */
export interface TaskAttachmentMeta {
  /** Unique attachment ID (uuid). */
  id: string;
  /** Original filename (e.g. "screenshot.png"). */
  filename: string;
  /** MIME type. */
  mimeType: AttachmentMediaType;
  /** File size in bytes. */
  size: number;
  /** ISO timestamp when the attachment was added. */
  addedAt: string;
  /** Absolute path to the file on disk. Null/absent for metadata-only references. */
  filePath?: string | null;
}

/** Payload for uploading an attachment with base64 data (renderer → main). */
export interface CommentAttachmentPayload {
  id: string;
  filename: string;
  mimeType: AttachmentMediaType;
  base64Data: string;
}

export interface AddTaskCommentRequest {
  text: string;
  attachments?: CommentAttachmentPayload[];
  taskRefs?: TaskRef[];
}

export interface ApplicationCommandRequestIdentity {
  commandId: string;
  idempotencyKey: string;
}

/** Omitted fields preserve existing values; null explicitly removes the group association. */
export interface TaskFieldUpdates {
  subject?: string;
  description?: string;
  groupChatId?: string | null;
}

export interface CreateTaskRequest {
  /** Stable for one user intent so transport retries cannot create a second task. */
  command?: ApplicationCommandRequestIdentity;
  /** Agent-command provenance, persisted with execution metadata for replay. */
  creationCommand?: TaskCreationCommand;
  groupChatId?: string;
  subject: string;
  description?: string;
  /**
   * FR/NFR/AC ids the task implements. Required for every new task:
   * the spec registry refuses a task that does not name its requirements.
   */
  requirements?: string[];
  /** Free-form tracking note the registry stores on the task. */
  tracking?: string;
  descriptionTaskRefs?: TaskRef[];
  owner?: string;
  blockedBy?: string[];
  related?: string[];
  prompt?: string;
  promptTaskRefs?: TaskRef[];
  startImmediately?: boolean;
}

export interface GlobalTask extends TeamTaskWithKanban {
  teamName: string;
  teamDisplayName: string;
  projectPath?: string;
  /** True when the parent team has been soft-deleted. */
  teamDeleted?: boolean;
}
