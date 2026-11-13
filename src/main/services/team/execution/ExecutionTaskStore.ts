import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteSync } from '../../../utils/atomicWrite';
import { getLocalTasksBasePath } from '../../../utils/pathDecoder';
import { isTransientFsErrorCode } from '../../../utils/transientFsRetry';
import { withFileLockSync } from '../fileLock';

import {
  appendUnique,
  applyPatch,
  createEmptyRecord,
  EXECUTION_TASK_CANONICAL_FIELDS,
  EXECUTION_TASK_LOCAL_FIELDS,
  EXECUTION_TASK_SCHEMA_VERSION,
  ExecutionTaskStoreError,
  InvalidExecutionValueError,
  mapInvalidValue,
  normalizePatch,
  sanitizeAttachmentMeta,
  sanitizeComment,
  sanitizeHistoryEvent,
  sanitizeStoredRecord,
  serializeRecord,
  validateExecutionTaskPatch,
} from './ExecutionTaskRecordCodec';

import type { FileLockOptions } from '../fileLock';
import type {
  ExecutionTaskLocalField,
  ExecutionTaskPatch,
  ExecutionTaskRecord,
  ExecutionTaskStoreErrorCode,
} from './ExecutionTaskRecordCodec';
import type { TaskAttachmentMeta, TaskComment, TaskHistoryEvent } from '@shared/types';

export {
  EXECUTION_TASK_CANONICAL_FIELDS,
  EXECUTION_TASK_LOCAL_FIELDS,
  EXECUTION_TASK_SCHEMA_VERSION,
  ExecutionTaskStoreError,
  validateExecutionTaskPatch,
};
export type {
  ExecutionTaskLocalField,
  ExecutionTaskPatch,
  ExecutionTaskRecord,
  ExecutionTaskStoreErrorCode,
};

/**
 * Local store for the execution half of a team task.
 *
 * Canonical task fields stay in the spec registry. Everything that
 * records how the task was worked on - work/review intervals, comments,
 * attachments, workflow history, clarification requests - is owned here, in
 * `~/.claude/tasks-local/<team>/<taskId>.json`.
 *
 * The file layout is intentionally the same field vocabulary as the canonical
 * task file, minus the canonical fields: `subject`, `status`, `owner`,
 * `blocks`, `blockedBy`, `related` are rejected outright, so a caller cannot
 * quietly fork the canonical state into a second location.
 */

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

  /** Atomically transform interval arrays without racing another execution-record writer. */
  updateIntervals(
    team: string,
    taskId: string,
    update: (
      record: ExecutionTaskRecord
    ) => Pick<ExecutionTaskPatch, 'workIntervals' | 'reviewIntervals'> | null
  ): { record: ExecutionTaskRecord; changed: boolean } {
    return this.update(team, taskId, update);
  }

  /** Read and patch one execution record while holding its cross-process lock. */
  update(
    team: string,
    taskId: string,
    update: (record: ExecutionTaskRecord) => ExecutionTaskPatch | null
  ): { record: ExecutionTaskRecord; changed: boolean } {
    const recordPath = this.getRecordPath(team, taskId);
    return withFileLockSync(
      recordPath,
      () => {
        const current =
          this.readRecordFile(taskId, recordPath) ??
          createEmptyRecord(taskId, this.clock().toISOString());
        const patch = update(current);
        if (patch === null) return { record: current, changed: false };
        const next = applyPatch(current, normalizePatch(patch));
        const stamped: ExecutionTaskRecord = {
          ...next,
          schemaVersion: EXECUTION_TASK_SCHEMA_VERSION,
          taskId,
          updatedAt: this.clock().toISOString(),
        };
        atomicWriteSync(recordPath, serializeRecord(stamped));
        return { record: stamped, changed: true };
      },
      this.lockOptions
    );
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

  /** Appends one comment if its id is not already present, atomically. */
  addCommentIfAbsent(
    team: string,
    taskId: string,
    comment: TaskComment
  ): { record: ExecutionTaskRecord; added: boolean } {
    const normalized = mapInvalidValue('invalid_entry', () => sanitizeComment(comment, 'comment'));
    const result = this.update(team, taskId, (record) =>
      record.comments.some((item) => item.id === normalized.id)
        ? null
        : { comments: [...record.comments, normalized] }
    );
    return { record: result.record, added: result.changed };
  }

  /** Appends one comment. Re-appending a comment with a known id is a no-op. */
  addComment(team: string, taskId: string, comment: TaskComment): ExecutionTaskRecord {
    return this.addCommentIfAbsent(team, taskId, comment).record;
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
    let attempt = 0;
    while (raw === null) {
      attempt += 1;
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
