import type {
  SourceMessageSnapshot,
  TaskCreationCommand,
  TaskRef,
  TeamReviewState,
} from '@shared/types';
import type { PendingKanbanTransition } from '@shared/types/kanbanRecovery';
import type { KanbanColumnId, KanbanState } from '@shared/types/team';

/** Non-canonical context that must survive registry reads and process restarts. */
export interface ExecutionTaskMetadata {
  reviewState?: TeamReviewState;
  activeForm?: string;
  groupChatId?: string;
  prompt?: string;
  projectPath?: string;
  descriptionTaskRefs?: TaskRef[];
  promptTaskRefs?: TaskRef[];
  sourceMessageId?: string;
  sourceMessage?: SourceMessageSnapshot;
  createdBy?: string;
  creationCommand?: TaskCreationCommand;
  pendingKanbanTransition?: PendingKanbanTransition;
}

export type ExecutionTaskMetadataPatch = {
  [K in keyof ExecutionTaskMetadata]?: ExecutionTaskMetadata[K] | null;
};

export const EXECUTION_TASK_METADATA_FIELDS = [
  'reviewState',
  'activeForm',
  'groupChatId',
  'prompt',
  'projectPath',
  'descriptionTaskRefs',
  'promptTaskRefs',
  'sourceMessageId',
  'sourceMessage',
  'createdBy',
  'creationCommand',
  'pendingKanbanTransition',
] as const satisfies readonly (keyof ExecutionTaskMetadata)[];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function refs(value: unknown, label: string): TaskRef[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry) => {
    const ref = object(entry, label);
    return {
      taskId: string(ref.taskId, label),
      teamName: string(ref.teamName, label),
      displayId: string(ref.displayId, label),
    };
  });
}
const KANBAN_COLUMN_IDS = new Set<KanbanColumnId>([
  'todo',
  'in_progress',
  'done',
  'review',
  'approved',
]);

function normalizeKanbanState(value: unknown, label: string): KanbanState {
  const source = object(value, label);
  const teamName = string(source.teamName, `${label}.teamName`);
  const reviewers = source.reviewers;
  if (
    !teamName.trim() ||
    !Array.isArray(reviewers) ||
    reviewers.some((reviewer) => typeof reviewer !== 'string' || !reviewer.trim())
  ) {
    throw new Error(`${label} has invalid teamName or reviewers`);
  }
  const rawTasks = object(source.tasks, `${label}.tasks`);
  const tasks: KanbanState['tasks'] = {};
  for (const [taskId, rawEntry] of Object.entries(rawTasks)) {
    const entry = object(rawEntry, `${label}.tasks.${taskId}`);
    if (entry.column !== 'review' && entry.column !== 'approved') {
      throw new Error(`${label}.tasks.${taskId}.column is invalid`);
    }
    const movedAt = string(entry.movedAt, `${label}.tasks.${taskId}.movedAt`);
    if (!taskId.trim() || !Number.isFinite(Date.parse(movedAt))) {
      throw new Error(`${label}.tasks.${taskId} is invalid`);
    }
    const taskState: KanbanState['tasks'][string] = {
      column: entry.column,
      movedAt,
    };
    if (entry.transitionId !== undefined) {
      taskState.transitionId = string(entry.transitionId, `${label}.tasks.${taskId}.transitionId`);
    }
    if (entry.reviewer !== undefined) {
      if (entry.reviewer !== null && typeof entry.reviewer !== 'string') {
        throw new Error(`${label}.tasks.${taskId}.reviewer is invalid`);
      }
      taskState.reviewer = entry.reviewer;
    }
    if (entry.errorDescription !== undefined) {
      taskState.errorDescription = string(
        entry.errorDescription,
        `${label}.tasks.${taskId}.errorDescription`
      );
    }
    tasks[taskId] = taskState;
  }
  const state: KanbanState = { teamName, reviewers: [...reviewers], tasks };
  if (source.revision !== undefined) state.revision = string(source.revision, `${label}.revision`);
  if (source.columnOrder !== undefined) {
    const rawOrder = object(source.columnOrder, `${label}.columnOrder`);
    const columnOrder: NonNullable<KanbanState['columnOrder']> = {};
    for (const [column, rawIds] of Object.entries(rawOrder)) {
      if (!KANBAN_COLUMN_IDS.has(column as KanbanColumnId) || !Array.isArray(rawIds)) {
        throw new Error(`${label}.columnOrder.${column} is invalid`);
      }
      columnOrder[column as KanbanColumnId] = rawIds.map((id, index) =>
        string(id, `${label}.columnOrder.${column}[${index}]`)
      );
    }
    state.columnOrder = columnOrder;
  }
  return state;
}

function pendingKanbanTransition(value: unknown, label: string): PendingKanbanTransition {
  const source = object(value, label);
  const allowedKeys = new Set([
    'id',
    'taskId',
    'kind',
    'phase',
    'column',
    'operation',
    'targetStatus',
    'beforeTaskHash',
    'expectedTaskHash',
    'beforeBoardHash',
    'expectedBoardHash',
    'beforeBoardToken',
    'targetBoard',
    'contextHash',
    'verifyArtifact',
  ]);
  if (Object.keys(source).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} contains unknown fields`);
  }
  const id = string(source.id, `${label}.id`);
  const taskId = string(source.taskId, `${label}.taskId`);
  if (!id.trim() || !taskId.trim()) throw new Error(`${label} identity must not be blank`);
  if (source.kind !== 'status' && source.kind !== 'review') {
    throw new Error(`${label}.kind is invalid`);
  }
  if (source.phase !== 'prepared' && source.phase !== 'applied') {
    throw new Error(`${label}.phase is invalid`);
  }
  if (source.column !== 'review' && source.column !== 'approved' && source.column !== 'none') {
    throw new Error(`${label}.column is invalid`);
  }
  const operation = source.operation;
  if (
    operation !== undefined &&
    operation !== 'status' &&
    operation !== 'request_changes' &&
    operation !== 'clear'
  ) {
    throw new Error(`${label}.operation is invalid`);
  }
  const targetStatus = source.targetStatus;
  if (
    targetStatus !== undefined &&
    targetStatus !== 'pending' &&
    targetStatus !== 'in_progress' &&
    targetStatus !== 'completed' &&
    targetStatus !== 'deleted'
  ) {
    throw new Error(`${label}.targetStatus is invalid`);
  }
  const hash = (field: string): string => {
    const value = string(source[field], `${label}.${field}`);
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${label}.${field} is invalid`);
    return value;
  };
  if (source.verifyArtifact !== undefined && typeof source.verifyArtifact !== 'boolean') {
    throw new Error(`${label}.verifyArtifact must be a boolean`);
  }
  return {
    id,
    taskId,
    kind: source.kind,
    phase: source.phase,
    column: source.column,
    ...(operation !== undefined ? { operation } : {}),
    ...(targetStatus !== undefined ? { targetStatus } : {}),
    beforeTaskHash: hash('beforeTaskHash'),
    expectedTaskHash: hash('expectedTaskHash'),
    beforeBoardHash: hash('beforeBoardHash'),
    expectedBoardHash: hash('expectedBoardHash'),
    beforeBoardToken: hash('beforeBoardToken'),
    targetBoard: normalizeKanbanState(source.targetBoard, `${label}.targetBoard`),
    contextHash: hash('contextHash'),
    ...(source.verifyArtifact !== undefined ? { verifyArtifact: source.verifyArtifact } : {}),
  };
}

export function normalizeExecutionTaskMetadata(
  source: Record<string, unknown>
): ExecutionTaskMetadataPatch {
  const result: Record<string, unknown> = {};
  for (const field of EXECUTION_TASK_METADATA_FIELDS) {
    const value = source[field];
    if (value === undefined) continue;
    if (value === null) {
      result[field] = null;
      continue;
    }
    if (field === 'descriptionTaskRefs' || field === 'promptTaskRefs') {
      result[field] = refs(value, field);
    } else if (field === 'reviewState') {
      if (!['none', 'review', 'needsFix', 'approved'].includes(string(value, field)))
        throw new Error('Invalid reviewState');
      result[field] = value;
    } else if (field === 'creationCommand') {
      const command = object(value, field);
      const normalized: Record<string, string> = {};
      for (const key of ['namespace', 'scopeKey', 'operation', 'commandId', 'payloadHash']) {
        normalized[key] = string(command[key], `${field}.${key}`);
        if (!normalized[key].trim()) throw new Error(`${field}.${key} must not be blank`);
      }
      result[field] = normalized;
    } else if (field === 'pendingKanbanTransition') {
      result[field] = pendingKanbanTransition(value, field);
    } else if (field === 'sourceMessage') {
      const message = object(value, field);
      string(message.text, 'sourceMessage.text');
      string(message.from, 'sourceMessage.from');
      if (!Number.isFinite(Date.parse(string(message.timestamp, 'sourceMessage.timestamp'))))
        throw new Error('Invalid sourceMessage.timestamp');
      if (message.source !== undefined) string(message.source, 'sourceMessage.source');
      if (
        message.fileReferenceIds !== undefined &&
        (!Array.isArray(message.fileReferenceIds) ||
          message.fileReferenceIds.some((id) => typeof id !== 'string'))
      )
        throw new Error('Invalid sourceMessage.fileReferenceIds');
      if (message.attachments !== undefined && !Array.isArray(message.attachments))
        throw new Error('Invalid sourceMessage.attachments');
      result[field] = structuredClone(message);
    } else {
      result[field] = string(value, field);
    }
  }
  return result as ExecutionTaskMetadataPatch;
}
