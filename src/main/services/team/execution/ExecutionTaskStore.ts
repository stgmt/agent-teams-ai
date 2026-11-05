import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteSync } from '../../../utils/atomicWrite';
import { getLocalTasksBasePath } from '../../../utils/pathDecoder';
import { isTransientFsErrorCode } from '../../../utils/transientFsRetry';
import { withFileLockSync } from '../fileLock';

import type { FileLockOptions } from '../fileLock';
import type {
  AttachmentMediaType,
  TaskAttachmentMeta,
  TaskComment,
  TaskCommentType,
  TaskHistoryEvent,
  TaskRef,
  TaskReviewInterval,
  TaskWorkInterval,
} from '@shared/types';

/**
 * Local store for the execution half of a team task.
 *
 * Canonical task fields stay in the canonical task files. Everything that
 * records how the task was worked on - work/review intervals, comments,
 * attachments, workflow history, clarification requests - is owned here, in
 * `~/.claude/tasks-local/<team>/<taskId>.json`.
 *
 * The file layout is intentionally the same field vocabulary as the canonical
 * task file, minus the canonical fields: `subject`, `status`, `owner`,
 * `blocks`, `blockedBy`, `related` are rejected outright, so a caller cannot
 * quietly fork the canonical state into a second location.
 */

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
  'historyEvents',
  'needsClarification',
] as const;

export type ExecutionTaskLocalField = (typeof EXECUTION_TASK_LOCAL_FIELDS)[number];

export interface ExecutionTaskRecord {
  schemaVersion: typeof EXECUTION_TASK_SCHEMA_VERSION;
  taskId: string;
  updatedAt: string;
  workIntervals: TaskWorkInterval[];
  reviewIntervals: TaskReviewInterval[];
  comments: TaskComment[];
  attachments: TaskAttachmentMeta[];
  historyEvents: TaskHistoryEvent[];
  /** Signals that the agent is blocked and needs clarification ("lead" | "user"). Absent when clear. */
  needsClarification?: 'lead' | 'user';
}

export interface ExecutionTaskPatch {
  workIntervals?: readonly TaskWorkInterval[];
  reviewIntervals?: readonly TaskReviewInterval[];
  comments?: readonly TaskComment[];
  attachments?: readonly TaskAttachmentMeta[];
  historyEvents?: readonly TaskHistoryEvent[];
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

export interface ExecutionTaskStoreOptions {
  /** Defaults to {@link getLocalTasksBasePath}, resolved lazily per call. */
  basePath?: string;
  clock?: () => Date;
  lockOptions?: FileLockOptions;
}

const RECORD_EXTENSION = '.json';
const MAX_RECORD_BYTES = 2 * 1024 * 1024;
const MAX_PATH_SEGMENT_LENGTH = 200;
const READ_MAX_ATTEMPTS = 8;
const READ_RETRY_DELAY_MS = 20;
const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
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
class InvalidExecutionValueError extends Error {}

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

function sanitizeAttachmentMeta(value: unknown, label: string): TaskAttachmentMeta {
  const source = requireObject(value, label);
  const size = source.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    invalid(label, '"size" must be a non-negative number');
  }
  const meta: TaskAttachmentMeta = {
    id: requireString(source, 'id', label),
    filename: requireString(source, 'filename', label),
    mimeType: requireString(source, 'mimeType', label) as AttachmentMediaType,
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

function sanitizeComment(value: unknown, label: string): TaskComment {
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

function sanitizeHistoryEvent(value: unknown, label: string): TaskHistoryEvent {
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

function mapInvalidValue<T>(code: ExecutionTaskStoreErrorCode, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof InvalidExecutionValueError) {
      throw new ExecutionTaskStoreError(code, error.message);
    }
    throw error;
  }
}

interface NormalizedPatch {
  workIntervals?: TaskWorkInterval[];
  reviewIntervals?: TaskReviewInterval[];
  comments?: TaskComment[];
  attachments?: TaskAttachmentMeta[];
  historyEvents?: TaskHistoryEvent[];
  needsClarification?: 'lead' | 'user' | null;
}

function normalizePatch(patch: ExecutionTaskPatch): NormalizedPatch {
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

    const normalized: NormalizedPatch = {};
    if (patch.workIntervals !== undefined) {
      normalized.workIntervals = requireArray(
        patch.workIntervals,
        'patch.workIntervals',
        sanitizeWorkInterval
      );
    }
    if (patch.reviewIntervals !== undefined) {
      normalized.reviewIntervals = requireArray(
        patch.reviewIntervals,
        'patch.reviewIntervals',
        sanitizeReviewInterval
      );
    }
    if (patch.comments !== undefined) {
      normalized.comments = requireArray(patch.comments, 'patch.comments', sanitizeComment);
    }
    if (patch.attachments !== undefined) {
      normalized.attachments = requireArray(
        patch.attachments,
        'patch.attachments',
        sanitizeAttachmentMeta
      );
    }
    if (patch.historyEvents !== undefined) {
      normalized.historyEvents = requireArray(
        patch.historyEvents,
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

function applyPatch(record: ExecutionTaskRecord, patch: NormalizedPatch): ExecutionTaskRecord {
  const next: ExecutionTaskRecord = { ...record };
  if (patch.workIntervals !== undefined) next.workIntervals = patch.workIntervals;
  if (patch.reviewIntervals !== undefined) next.reviewIntervals = patch.reviewIntervals;
  if (patch.comments !== undefined) next.comments = patch.comments;
  if (patch.attachments !== undefined) next.attachments = patch.attachments;
  if (patch.historyEvents !== undefined) next.historyEvents = patch.historyEvents;
  if (patch.needsClarification === null) delete next.needsClarification;
  else if (patch.needsClarification !== undefined) {
    next.needsClarification = patch.needsClarification;
  }
  return next;
}

function appendUnique<T extends { id: string }>(existing: readonly T[], entry: T): T[] {
  if (existing.some((item) => item.id === entry.id)) return existing.slice();
  return [...existing, entry];
}

function createEmptyRecord(taskId: string, updatedAt: string): ExecutionTaskRecord {
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

function serializeRecord(record: ExecutionTaskRecord): string {
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
  if (record.needsClarification !== undefined) {
    ordered.needsClarification = record.needsClarification;
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function sanitizeStoredRecord(raw: unknown, expectedTaskId: string): ExecutionTaskRecord {
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
  return record;
}

function validatePathSegment(
  value: unknown,
  label: string,
  code: ExecutionTaskStoreErrorCode
): string {
  if (typeof value !== 'string') {
    throw new ExecutionTaskStoreError(code, `${label} must be a string`);
  }
  if (!value.trim()) {
    throw new ExecutionTaskStoreError(code, `${label} must not be blank`);
  }
  if (value !== value.trim()) {
    throw new ExecutionTaskStoreError(code, `${label} must not have surrounding whitespace`);
  }
  if (value.length > MAX_PATH_SEGMENT_LENGTH) {
    throw new ExecutionTaskStoreError(code, `${label} is too long`);
  }
  if (value === '.' || value === '..') {
    throw new ExecutionTaskStoreError(code, `${label} cannot be a relative path segment`);
  }
  if (/[\\/]/.test(value)) {
    throw new ExecutionTaskStoreError(code, `${label} must not contain path separators`);
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new ExecutionTaskStoreError(code, `${label} must not contain control characters`);
  }
  if (/[. ]$/.test(value)) {
    throw new ExecutionTaskStoreError(code, `${label} must not end with a dot or space`);
  }
  if (WINDOWS_RESERVED_SEGMENT.test(value)) {
    throw new ExecutionTaskStoreError(code, `${label} is a reserved filesystem name`);
  }
  return value;
}

function assertContainedIn(basePath: string, candidatePath: string, label: string): void {
  const relative = path.relative(basePath, candidatePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new ExecutionTaskStoreError(
      'invalid_team',
      `${label} escapes the execution task directory`
    );
  }
}

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Synchronous readers retry Windows transient handle refusals.
  }
}

export class ExecutionTaskStore {
  private readonly basePathOption: string | undefined;
  private readonly clock: () => Date;
  private readonly lockOptions: FileLockOptions;

  constructor(options: ExecutionTaskStoreOptions = {}) {
    this.basePathOption = options.basePath;
    this.clock = options.clock ?? (() => new Date());
    this.lockOptions = options.lockOptions ?? {};
  }

  /** Absolute path of the store directory currently in use. */
  getBasePath(): string {
    return this.basePathOption ?? getLocalTasksBasePath();
  }

  /** Absolute path of a team's execution task directory. */
  getTeamPath(team: string): string {
    const teamPath = path.join(
      this.getBasePath(),
      validatePathSegment(team, 'team', 'invalid_team')
    );
    assertContainedIn(this.getBasePath(), teamPath, 'team');
    return teamPath;
  }

  /** Absolute path of one task's execution record. */
  getRecordPath(team: string, taskId: string): string {
    const teamPath = this.getTeamPath(team);
    const recordPath = path.join(
      teamPath,
      `${validatePathSegment(taskId, 'taskId', 'invalid_task_id')}${RECORD_EXTENSION}`
    );
    assertContainedIn(teamPath, recordPath, 'taskId');
    return recordPath;
  }

  /** Returns `null` when the team has no local execution record for the task. */
  read(team: string, taskId: string): ExecutionTaskRecord | null {
    return this.readRecordFile(taskId, this.getRecordPath(team, taskId));
  }

  /** Merges an execution-field patch into the task's record, creating it when absent. */
  write(team: string, taskId: string, patch: ExecutionTaskPatch): ExecutionTaskRecord {
    const normalizedPatch = normalizePatch(patch);
    return this.mutate(team, taskId, (record) => applyPatch(record, normalizedPatch));
  }

  /** Appends one workflow event. Re-appending an event with a known id is a no-op. */
  appendHistoryEvent(team: string, taskId: string, event: TaskHistoryEvent): ExecutionTaskRecord {
    const normalized = mapInvalidValue('invalid_entry', () =>
      sanitizeHistoryEvent(event, 'historyEvent')
    );
    return this.mutate(team, taskId, (record) => ({
      ...record,
      historyEvents: appendUnique(record.historyEvents, normalized),
    }));
  }

  /** Appends one comment. Re-appending a comment with a known id is a no-op. */
  addComment(team: string, taskId: string, comment: TaskComment): ExecutionTaskRecord {
    const normalized = mapInvalidValue('invalid_entry', () => sanitizeComment(comment, 'comment'));
    return this.mutate(team, taskId, (record) => ({
      ...record,
      comments: appendUnique(record.comments, normalized),
    }));
  }

  /** Appends one attachment's metadata. Re-appending an attachment with a known id is a no-op. */
  addAttachmentMeta(
    team: string,
    taskId: string,
    attachment: TaskAttachmentMeta
  ): ExecutionTaskRecord {
    const normalized = mapInvalidValue('invalid_entry', () =>
      sanitizeAttachmentMeta(attachment, 'attachment')
    );
    return this.mutate(team, taskId, (record) => ({
      ...record,
      attachments: appendUnique(record.attachments, normalized),
    }));
  }

  /** All execution records of a team, most recently updated first. */
  list(team: string): ExecutionTaskRecord[] {
    const teamPath = this.getTeamPath(team);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(teamPath, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const records: ExecutionTaskRecord[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(RECORD_EXTENSION)) continue;
      const taskId = entry.name.slice(0, -RECORD_EXTENSION.length);
      if (!taskId) continue;
      const record = this.readRecordFile(taskId, path.join(teamPath, entry.name));
      if (record) records.push(record);
    }

    return records.sort((left, right) => {
      const byUpdatedAt = right.updatedAt.localeCompare(left.updatedAt);
      return byUpdatedAt !== 0 ? byUpdatedAt : left.taskId.localeCompare(right.taskId);
    });
  }

  private mutate(
    team: string,
    taskId: string,
    update: (record: ExecutionTaskRecord) => ExecutionTaskRecord
  ): ExecutionTaskRecord {
    const recordPath = this.getRecordPath(team, taskId);
    return withFileLockSync(
      recordPath,
      () => {
        const current =
          this.readRecordFile(taskId, recordPath) ??
          createEmptyRecord(taskId, this.clock().toISOString());
        const next = update(current);
        const stamped: ExecutionTaskRecord = {
          ...next,
          schemaVersion: EXECUTION_TASK_SCHEMA_VERSION,
          taskId,
          updatedAt: this.clock().toISOString(),
        };
        atomicWriteSync(recordPath, serializeRecord(stamped));
        return stamped;
      },
      this.lockOptions
    );
  }

  private readRecordFile(taskId: string, recordPath: string): ExecutionTaskRecord | null {
    let raw: string | null = null;
    for (let attempt = 1; raw === null; attempt += 1) {
      try {
        raw = fs.readFileSync(recordPath, 'utf8');
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return null;
        if (!isTransientFsErrorCode(code) || attempt >= READ_MAX_ATTEMPTS) throw error;
        sleepSync(READ_RETRY_DELAY_MS);
      }
    }
    return this.parseRecordFile(raw, taskId, recordPath);
  }

  private parseRecordFile(raw: string, taskId: string, recordPath: string): ExecutionTaskRecord {
    if (raw.length > MAX_RECORD_BYTES) {
      throw new ExecutionTaskStoreError(
        'corrupt_record',
        `Execution record exceeds ${MAX_RECORD_BYTES} bytes: ${recordPath}`,
        recordPath
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new ExecutionTaskStoreError(
        'corrupt_record',
        `Execution record is not valid JSON: ${recordPath}`,
        recordPath
      );
    }
    try {
      return sanitizeStoredRecord(parsed, taskId);
    } catch (error) {
      if (error instanceof ExecutionTaskStoreError) {
        throw new ExecutionTaskStoreError(
          error.code,
          `${error.message} (${recordPath})`,
          recordPath
        );
      }
      if (error instanceof InvalidExecutionValueError) {
        throw new ExecutionTaskStoreError(
          'corrupt_record',
          `Invalid execution record: ${error.message} (${recordPath})`,
          recordPath
        );
      }
      throw error;
    }
  }
}
