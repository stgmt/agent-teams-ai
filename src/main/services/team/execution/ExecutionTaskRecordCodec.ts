import {
  EXECUTION_TASK_METADATA_FIELDS,
  type ExecutionTaskMetadata,
  type ExecutionTaskMetadataPatch,
  normalizeExecutionTaskMetadata,
} from './ExecutionTaskMetadata';

import type {
  TaskArtifactRequirement,
  TaskAttachmentMeta,
  TaskComment,
  TaskCommentType,
  TaskHistoryEvent,
  TaskRef,
  TaskReviewInterval,
  TaskWorkInterval,
} from '@shared/types';

export const EXECUTION_TASK_SCHEMA_VERSION = 1;

/** Fields that belong to the canonical task record and are never persisted here. */
export const EXECUTION_TASK_CANONICAL_FIELDS = [
  'subject',
  'status',
  'owner',
  'blocks',
  'blockedBy',
  'related',
] as const;

/** Fields this store persists. Nothing else is accepted. */
export const EXECUTION_TASK_LOCAL_FIELDS = [
  'workIntervals',
  'reviewIntervals',
  'comments',
  'attachments',
  'artifactRequirement',
  'historyEvents',
  'needsClarification',
  ...EXECUTION_TASK_METADATA_FIELDS,
] as const;

export type ExecutionTaskLocalField = (typeof EXECUTION_TASK_LOCAL_FIELDS)[number];

export interface ExecutionTaskRecord extends ExecutionTaskMetadata {
  schemaVersion: typeof EXECUTION_TASK_SCHEMA_VERSION;
  taskId: string;
  updatedAt: string;
  workIntervals: TaskWorkInterval[];
  reviewIntervals: TaskReviewInterval[];
  comments: TaskComment[];
  attachments: TaskAttachmentMeta[];
  artifactRequirement?: TaskArtifactRequirement;
  historyEvents: TaskHistoryEvent[];
  /** Signals that the agent is blocked and needs clarification ("lead" | "user"). Absent when clear. */
  needsClarification?: 'lead' | 'user';
}

export interface ExecutionTaskPatch extends ExecutionTaskMetadataPatch {
  workIntervals?: readonly TaskWorkInterval[] | null;
  reviewIntervals?: readonly TaskReviewInterval[] | null;
  comments?: readonly TaskComment[] | null;
  attachments?: readonly TaskAttachmentMeta[] | null;
  artifactRequirement?: TaskArtifactRequirement | null;
  historyEvents?: readonly TaskHistoryEvent[] | null;
  /** `null` clears an outstanding clarification request. */
  needsClarification?: 'lead' | 'user' | null;
}

export type ExecutionTaskStoreErrorCode =
  | 'invalid_team'
  | 'invalid_task_id'
  | 'invalid_patch'
  | 'invalid_entry'
  | 'canonical_field_rejected'
  | 'unknown_field'
  | 'corrupt_record'
  | 'unsupported_schema';

export class ExecutionTaskStoreError extends Error {
  readonly code: ExecutionTaskStoreErrorCode;
  readonly filePath: string | undefined;

  constructor(code: ExecutionTaskStoreErrorCode, message: string, filePath?: string) {
    super(message);
    this.name = 'ExecutionTaskStoreError';
    this.code = code;
    this.filePath = filePath;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const TASK_COMMENT_TYPES: readonly TaskCommentType[] = [
  'regular',
  'review_request',
  'review_approved',
];
const TASK_HISTORY_EVENT_TYPES: readonly TaskHistoryEvent['type'][] = [
  'task_created',
  'status_changed',
  'owner_changed',
  'review_requested',
  'review_changes_requested',
  'review_approved',
  'review_started',
];
const TASK_HISTORY_EVENT_OPTIONAL_FIELDS = [
  'actor',
  'status',
  'from',
  'to',
  'reviewer',
  'note',
] as const;
const CANONICAL_FIELD_SET = new Set<string>(EXECUTION_TASK_CANONICAL_FIELDS);
const LOCAL_FIELD_SET = new Set<string>(EXECUTION_TASK_LOCAL_FIELDS);

type JsonObject = Record<string, unknown>;

/** Internal marker: an input value has the wrong shape, mapped to a public error code by the caller. */
export class InvalidExecutionValueError extends Error {}

function invalid(label: string, reason: string): never {
  throw new InvalidExecutionValueError(`${label}: ${reason}`);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isJsonObject(value)) invalid(label, 'expected a JSON object');
  return value;
}

function requireString(
  source: JsonObject,
  key: string,
  label: string,
  options: { allowEmpty?: boolean } = {}
): string {
  const value = source[key];
  if (typeof value !== 'string') invalid(label, `"${key}" must be a string`);
  if (!options.allowEmpty && value.trim() === '') invalid(label, `"${key}" must not be blank`);
  return value;
}

function optionalString(source: JsonObject, key: string, label: string): string | undefined {
  const value = source[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') invalid(label, `"${key}" must be a string when present`);
  return value;
}

function requireTimestamp(source: JsonObject, key: string, label: string): string {
  const value = requireString(source, key, label);
  if (!Number.isFinite(Date.parse(value))) invalid(label, `"${key}" must be an ISO timestamp`);
  return value;
}

function optionalTimestamp(source: JsonObject, key: string, label: string): string | undefined {
  const value = optionalString(source, key, label);
  if (value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value))) invalid(label, `"${key}" must be an ISO timestamp`);
  return value;
}

function requireArray<T>(
  value: unknown,
  label: string,
  sanitizeItem: (item: unknown, itemLabel: string) => T
): T[] {
  if (!Array.isArray(value)) invalid(label, 'expected an array');
  return value.map((item, index) => sanitizeItem(item, `${label}[${index}]`));
}

function sanitizeWorkInterval(value: unknown, label: string): TaskWorkInterval {
  const source = requireObject(value, label);
  const interval: TaskWorkInterval = { startedAt: requireTimestamp(source, 'startedAt', label) };
  const completedAt = optionalTimestamp(source, 'completedAt', label);
  if (completedAt !== undefined) interval.completedAt = completedAt;
  return interval;
}

function sanitizeReviewInterval(value: unknown, label: string): TaskReviewInterval {
  const source = requireObject(value, label);
  const interval: TaskReviewInterval = {
    reviewer: requireString(source, 'reviewer', label),
    startedAt: requireTimestamp(source, 'startedAt', label),
  };
  const completedAt = optionalTimestamp(source, 'completedAt', label);
  if (completedAt !== undefined) interval.completedAt = completedAt;
  return interval;
}

function sanitizeTaskRef(value: unknown, label: string): TaskRef {
  const source = requireObject(value, label);
  return {
    taskId: requireString(source, 'taskId', label),
    displayId: optionalString(source, 'displayId', label) ?? '',
    teamName: requireString(source, 'teamName', label),
  };
}

export function sanitizeAttachmentMeta(value: unknown, label: string): TaskAttachmentMeta {
  const source = requireObject(value, label);
  const size = source.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    invalid(label, '"size" must be a non-negative number');
  }
  const meta: TaskAttachmentMeta = {
    id: requireString(source, 'id', label),
    filename: requireString(source, 'filename', label),
    mimeType: requireString(source, 'mimeType', label),
    size,
    addedAt: requireTimestamp(source, 'addedAt', label),
  };
  if ('filePath' in source) {
    const filePath = source.filePath;
    if (filePath === null) meta.filePath = null;
    else if (typeof filePath === 'string') meta.filePath = filePath;
    else invalid(label, '"filePath" must be a string or null');
  }
  return meta;
}

function sanitizeArtifactRequirement(value: unknown, label: string): TaskArtifactRequirement {
  const source = requireObject(value, label);
  if (typeof source.required !== 'boolean') invalid(label, '"required" must be a boolean');
  const requirement: TaskArtifactRequirement = { required: source.required };
  if (source.expectedFilename !== undefined) {
    requirement.expectedFilename = requireString(source, 'expectedFilename', label, {
      allowEmpty: true,
    });
  }
  if (source.proof !== undefined) {
    const proof = requireObject(source.proof, `${label}.proof`);
    const size = proof.size;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      invalid(`${label}.proof`, '"size" must be a non-negative number');
    }
    requirement.proof = {
      attachmentId: requireString(proof, 'attachmentId', `${label}.proof`),
      sha256: requireString(proof, 'sha256', `${label}.proof`),
      size,
    };
  }
  return requirement;
}

export function sanitizeComment(value: unknown, label: string): TaskComment {
  const source = requireObject(value, label);
  const type = requireString(source, 'type', label);
  if (!(TASK_COMMENT_TYPES as readonly string[]).includes(type)) {
    invalid(label, `unsupported comment type "${type}"`);
  }
  const comment: TaskComment = {
    id: requireString(source, 'id', label),
    author: requireString(source, 'author', label),
    text: requireString(source, 'text', label, { allowEmpty: true }),
    createdAt: requireTimestamp(source, 'createdAt', label),
    type: type as TaskCommentType,
  };
  if (source.taskRefs !== undefined) {
    comment.taskRefs = requireArray(source.taskRefs, `${label}.taskRefs`, sanitizeTaskRef);
  }
  if (source.attachments !== undefined) {
    comment.attachments = requireArray(
      source.attachments,
      `${label}.attachments`,
      sanitizeAttachmentMeta
    );
  }
  return comment;
}

export function sanitizeHistoryEvent(value: unknown, label: string): TaskHistoryEvent {
  const source = requireObject(value, label);
  const type = requireString(source, 'type', label);
  if (!(TASK_HISTORY_EVENT_TYPES as readonly string[]).includes(type)) {
    invalid(label, `unsupported history event type "${type}"`);
  }
  // The union is discriminated by `type`; the base fields are validated here and
  // type-specific extras are copied only when they are strings.
  const event: JsonObject = {
    id: requireString(source, 'id', label),
    timestamp: requireTimestamp(source, 'timestamp', label),
    type,
  };
  for (const key of TASK_HISTORY_EVENT_OPTIONAL_FIELDS) {
    const optionalValue = source[key];
    if (optionalValue === undefined || optionalValue === null) continue;
    if (typeof optionalValue !== 'string') invalid(label, `"${key}" must be a string when present`);
    event[key] = optionalValue;
  }
  return event as unknown as TaskHistoryEvent;
}

export function mapInvalidValue<T>(code: ExecutionTaskStoreErrorCode, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof InvalidExecutionValueError) {
      throw new ExecutionTaskStoreError(code, error.message);
    }
    throw error;
  }
}

interface NormalizedPatch extends ExecutionTaskMetadataPatch {
  workIntervals?: TaskWorkInterval[];
  reviewIntervals?: TaskReviewInterval[];
  comments?: TaskComment[];
  attachments?: TaskAttachmentMeta[];
  artifactRequirement?: TaskArtifactRequirement | null;
  historyEvents?: TaskHistoryEvent[];
  needsClarification?: 'lead' | 'user' | null;
}

export function normalizePatch(patch: ExecutionTaskPatch): NormalizedPatch {
  if (!isJsonObject(patch)) {
    throw new ExecutionTaskStoreError('invalid_patch', 'patch must be a plain object');
  }
  return mapInvalidValue('invalid_patch', () => {
    for (const key of Object.keys(patch)) {
      if (CANONICAL_FIELD_SET.has(key)) {
        throw new ExecutionTaskStoreError(
          'canonical_field_rejected',
          `Canonical task field "${key}" cannot be stored in the local execution record`
        );
      }
      if (!LOCAL_FIELD_SET.has(key)) {
        throw new ExecutionTaskStoreError(
          'unknown_field',
          `Field "${key}" is not an execution field`
        );
      }
    }

    let metadata: ExecutionTaskMetadataPatch;
    try {
      metadata = normalizeExecutionTaskMetadata(patch as Record<string, unknown>);
    } catch (error) {
      invalid('patch', error instanceof Error ? error.message : String(error));
    }
    const normalized: NormalizedPatch = { ...metadata };
    if (patch.workIntervals !== undefined) {
      normalized.workIntervals = requireArray(
        patch.workIntervals ?? [],
        'patch.workIntervals',
        sanitizeWorkInterval
      );
    }
    if (patch.reviewIntervals !== undefined) {
      normalized.reviewIntervals = requireArray(
        patch.reviewIntervals ?? [],
        'patch.reviewIntervals',
        sanitizeReviewInterval
      );
    }
    if (patch.comments !== undefined) {
      normalized.comments = requireArray(patch.comments ?? [], 'patch.comments', sanitizeComment);
    }
    if (patch.attachments !== undefined) {
      normalized.attachments = requireArray(
        patch.attachments ?? [],
        'patch.attachments',
        sanitizeAttachmentMeta
      );
    }
    if (patch.artifactRequirement !== undefined) {
      normalized.artifactRequirement =
        patch.artifactRequirement === null
          ? null
          : sanitizeArtifactRequirement(patch.artifactRequirement, 'patch.artifactRequirement');
    }
    if (patch.historyEvents !== undefined) {
      normalized.historyEvents = requireArray(
        patch.historyEvents ?? [],
        'patch.historyEvents',
        sanitizeHistoryEvent
      );
    }
    if (patch.needsClarification !== undefined) {
      const clarification = patch.needsClarification;
      if (clarification !== null && clarification !== 'lead' && clarification !== 'user') {
        invalid('patch.needsClarification', 'must be "lead", "user", or null');
      }
      normalized.needsClarification = clarification;
    }
    return normalized;
  });
}

/** Shared HTTP/service validation; validates without reading or writing files. */
export function validateExecutionTaskPatch(input: unknown): ExecutionTaskPatch {
  return normalizePatch(input as ExecutionTaskPatch);
}

export function applyPatch(
  record: ExecutionTaskRecord,
  patch: NormalizedPatch
): ExecutionTaskRecord {
  const next: ExecutionTaskRecord = { ...record };
  if (patch.workIntervals !== undefined) next.workIntervals = patch.workIntervals;
  if (patch.reviewIntervals !== undefined) next.reviewIntervals = patch.reviewIntervals;
  if (patch.comments !== undefined) next.comments = patch.comments;
  if (patch.attachments !== undefined) next.attachments = patch.attachments;
  if (patch.artifactRequirement === null) delete next.artifactRequirement;
  else if (patch.artifactRequirement !== undefined)
    next.artifactRequirement = patch.artifactRequirement;
  if (patch.historyEvents !== undefined) next.historyEvents = patch.historyEvents;
  if (patch.needsClarification === null) delete next.needsClarification;
  else if (patch.needsClarification !== undefined) {
    next.needsClarification = patch.needsClarification;
  }
  for (const field of EXECUTION_TASK_METADATA_FIELDS) {
    if (patch[field] === null) delete next[field];
    else if (patch[field] !== undefined) Object.assign(next, { [field]: patch[field] });
  }
  return next;
}

export function appendUnique<T extends { id: string }>(existing: readonly T[], entry: T): T[] {
  if (existing.some((item) => item.id === entry.id)) return existing.slice();
  return [...existing, entry];
}

export function createEmptyRecord(taskId: string, updatedAt: string): ExecutionTaskRecord {
  return {
    schemaVersion: EXECUTION_TASK_SCHEMA_VERSION,
    taskId,
    updatedAt,
    workIntervals: [],
    reviewIntervals: [],
    comments: [],
    attachments: [],
    historyEvents: [],
  };
}

export function serializeRecord(record: ExecutionTaskRecord): string {
  const ordered: JsonObject = {
    schemaVersion: EXECUTION_TASK_SCHEMA_VERSION,
    taskId: record.taskId,
    updatedAt: record.updatedAt,
    workIntervals: record.workIntervals,
    reviewIntervals: record.reviewIntervals,
    comments: record.comments,
    attachments: record.attachments,
    historyEvents: record.historyEvents,
  };
  if (record.artifactRequirement !== undefined) {
    ordered.artifactRequirement = record.artifactRequirement;
  }
  if (record.needsClarification !== undefined) {
    ordered.needsClarification = record.needsClarification;
  }
  for (const field of EXECUTION_TASK_METADATA_FIELDS) {
    if (record[field] !== undefined) ordered[field] = record[field];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export function sanitizeStoredRecord(raw: unknown, expectedTaskId: string): ExecutionTaskRecord {
  const source = requireObject(raw, 'record');
  const schemaVersion = source.schemaVersion;
  if (typeof schemaVersion !== 'number') invalid('record.schemaVersion', 'must be a number');
  if (schemaVersion !== EXECUTION_TASK_SCHEMA_VERSION) {
    throw new ExecutionTaskStoreError(
      'unsupported_schema',
      `Unsupported execution record schema version ${String(schemaVersion)}`
    );
  }
  const taskId = requireString(source, 'taskId', 'record');
  if (taskId !== expectedTaskId) {
    invalid('record.taskId', `does not match file task id "${expectedTaskId}"`);
  }

  const record = createEmptyRecord(taskId, requireTimestamp(source, 'updatedAt', 'record'));
  if (source.workIntervals !== undefined) {
    record.workIntervals = requireArray(
      source.workIntervals,
      'record.workIntervals',
      sanitizeWorkInterval
    );
  }
  if (source.reviewIntervals !== undefined) {
    record.reviewIntervals = requireArray(
      source.reviewIntervals,
      'record.reviewIntervals',
      sanitizeReviewInterval
    );
  }
  if (source.comments !== undefined) {
    record.comments = requireArray(source.comments, 'record.comments', sanitizeComment);
  }
  if (source.attachments !== undefined) {
    record.attachments = requireArray(
      source.attachments,
      'record.attachments',
      sanitizeAttachmentMeta
    );
  }
  if (source.artifactRequirement !== undefined) {
    record.artifactRequirement = sanitizeArtifactRequirement(
      source.artifactRequirement,
      'record.artifactRequirement'
    );
  }
  if (source.historyEvents !== undefined) {
    record.historyEvents = requireArray(
      source.historyEvents,
      'record.historyEvents',
      sanitizeHistoryEvent
    );
  }
  if (source.needsClarification !== undefined) {
    const clarification = source.needsClarification;
    if (clarification !== 'lead' && clarification !== 'user') {
      invalid('record.needsClarification', 'must be "lead" or "user"');
    }
    record.needsClarification = clarification;
  }
  let metadata: ExecutionTaskMetadataPatch;
  try {
    metadata = normalizeExecutionTaskMetadata(source);
  } catch (error) {
    invalid('record', error instanceof Error ? error.message : String(error));
  }
  for (const field of EXECUTION_TASK_METADATA_FIELDS) {
    if (metadata[field] !== null && metadata[field] !== undefined) {
      Object.assign(record, { [field]: metadata[field] });
    }
  }
  return record;
}
