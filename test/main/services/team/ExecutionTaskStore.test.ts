// @vitest-environment node
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EXECUTION_TASK_CANONICAL_FIELDS,
  ExecutionTaskStore,
  ExecutionTaskStoreError,
} from '@main/services/team/execution/ExecutionTaskStore';

import type {
  ExecutionTaskPatch,
  ExecutionTaskRecord,
} from '@main/services/team/execution/ExecutionTaskStore';
import type { TaskComment, TaskHistoryEvent, TaskWorkInterval } from '@shared/types';

// Keep the real filesystem while allowing a single rename to be made to fail;
// native ESM namespace exports themselves are not configurable.
vi.mock('fs', async () => ({ ...(await vi.importActual<typeof import('fs')>('fs')) }));

const execFileAsync = promisify(execFile);
const requireFromTest = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const TEAM = 'team-a';
const TASK_ID = '3f2b9d1e-1111-4222-8333-444455556666';
const OTHER_TASK_ID = '7a1c2b3d-4444-4555-8666-777788889999';
const FIXTURE_PATH = path.join(
  root,
  'test/main/services/team/fixtures/executionTaskStoreWriter.ts'
);

const RECORD_KEYS = [
  'schemaVersion',
  'taskId',
  'updatedAt',
  'workIntervals',
  'reviewIntervals',
  'comments',
  'attachments',
  'historyEvents',
];

let tempDir: string;
let basePath: string;
let nowMs: number;

function clock(): Date {
  return new Date(nowMs);
}

function advance(ms: number): void {
  nowMs += ms;
}

function recordPath(team: string, taskId: string): string {
  return path.join(basePath, team, `${taskId}.json`);
}

function readRawRecord(team: string, taskId: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(recordPath(team, taskId), 'utf8')) as Record<string, unknown>;
}

function captureError(run: () => unknown): ExecutionTaskStoreError {
  try {
    run();
  } catch (error) {
    if (error instanceof ExecutionTaskStoreError) return error;
    throw error;
  }
  throw new Error('expected the call to throw');
}

function workInterval(startedAt: string, completedAt?: string): TaskWorkInterval {
  return completedAt === undefined ? { startedAt } : { startedAt, completedAt };
}

function comment(id: string, overrides: Partial<TaskComment> = {}): TaskComment {
  return {
    id,
    author: 'alice',
    text: `comment ${id}`,
    createdAt: '2026-01-01T00:00:00.000Z',
    type: 'regular',
    ...overrides,
  };
}

function historyEvent(id: string): TaskHistoryEvent {
  return {
    id,
    timestamp: '2026-01-01T00:00:00.000Z',
    type: 'review_started',
    from: 'none',
    to: 'review',
  };
}

function createStore(): ExecutionTaskStore {
  return new ExecutionTaskStore({ basePath, clock, lockOptions: { acquireTimeoutMs: 30_000 } });
}

describe('ExecutionTaskStore', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-task-store-'));
    basePath = path.join(tempDir, 'tasks-local');
    nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads a missing record as null without creating the store directory', () => {
    const store = createStore();

    expect(store.read(TEAM, TASK_ID)).toBeNull();
    expect(fs.existsSync(basePath)).toBe(false);
  });

  it('writes execution fields only and never persists canonical task fields', () => {
    const store = createStore();

    const written = store.write(TEAM, TASK_ID, {
      workIntervals: [workInterval('2026-01-01T00:00:00.000Z')],
      comments: [comment('c-1')],
      needsClarification: 'lead',
    });

    expect(written).toMatchObject({
      schemaVersion: 1,
      taskId: TASK_ID,
      updatedAt: '2026-01-01T00:00:00.000Z',
      needsClarification: 'lead',
    });
    expect(written.comments).toEqual([comment('c-1')]);
    expect(fs.existsSync(recordPath(TEAM, TASK_ID))).toBe(true);

    const raw = readRawRecord(TEAM, TASK_ID);
    expect(Object.keys(raw).sort()).toEqual([...RECORD_KEYS, 'needsClarification'].sort());
    for (const canonicalField of EXECUTION_TASK_CANONICAL_FIELDS) {
      expect(raw).not.toHaveProperty(canonicalField);
    }
  });

  it('round-trips artifact requirements and attachments together and clears them together', () => {
    const store = createStore();
    const attachments = [{
      id: 'proof-1',
      filename: 'result.txt',
      mimeType: 'text/plain' as const,
      size: 4,
      addedAt: '2026-01-01T00:00:00.000Z',
      filePath: '/tmp/result.txt',
    }];
    const artifactRequirement = {
      required: true,
      expectedFilename: 'result.txt',
      proof: { attachmentId: 'proof-1', sha256: 'a'.repeat(64), size: 4 },
    };
    store.write(TEAM, TASK_ID, { artifactRequirement, attachments });
    expect(createStore().read(TEAM, TASK_ID)).toMatchObject({ artifactRequirement, attachments });

    expect(() =>
      store.write(TEAM, TASK_ID, {
        artifactRequirement: { required: true, proof: { ...artifactRequirement.proof, size: -1 } },
        attachments: null,
      })
    ).toThrow();
    expect(createStore().read(TEAM, TASK_ID)).toMatchObject({ artifactRequirement, attachments });

    store.write(TEAM, TASK_ID, { artifactRequirement: null, attachments: null });
    const cleared = createStore().read(TEAM, TASK_ID);
    expect(cleared?.artifactRequirement).toBeUndefined();
    expect(cleared?.attachments).toEqual([]);
  });

  it('rejects canonical and non-execution fields in a patch', () => {
    const store = createStore();

    for (const canonicalField of EXECUTION_TASK_CANONICAL_FIELDS) {
      const error = captureError(() =>
        store.write(TEAM, TASK_ID, { [canonicalField]: 'nope' } as ExecutionTaskPatch)
      );
      expect(error.code).toBe('canonical_field_rejected');
      expect(error.message).toContain(canonicalField);
    }

    for (const foreignField of ['id', 'description', 'displayId', 'createdAt']) {
      const error = captureError(() =>
        store.write(TEAM, TASK_ID, { [foreignField]: 'nope' } as ExecutionTaskPatch)
      );
      expect(error.code).toBe('unknown_field');
      expect(error.message).toContain(foreignField);
    }

    expect(store.read(TEAM, TASK_ID)).toBeNull();
  });

  it('merges patches, replaces arrays, and clears clarification with null', () => {
    const store = createStore();
    store.write(TEAM, TASK_ID, {
      workIntervals: [workInterval('2026-01-01T00:00:00.000Z')],
      needsClarification: 'user',
    });

    advance(1_000);
    const withComment = store.write(TEAM, TASK_ID, { comments: [comment('c-1')] });
    expect(withComment.workIntervals).toEqual([workInterval('2026-01-01T00:00:00.000Z')]);
    expect(withComment.needsClarification).toBe('user');
    expect(withComment.updatedAt).toBe('2026-01-01T00:00:01.000Z');

    advance(1_000);
    const narrowed = store.write(TEAM, TASK_ID, { comments: [] });
    expect(narrowed.comments).toEqual([]);
    expect(narrowed.workIntervals).toHaveLength(1);

    advance(1_000);
    store.write(TEAM, TASK_ID, { needsClarification: null });
    expect(readRawRecord(TEAM, TASK_ID)).not.toHaveProperty('needsClarification');
  });

  it('appends comments, attachments, and history events idempotently by id', () => {
    const store = createStore();

    store.addComment(TEAM, TASK_ID, comment('c-1'));
    store.addComment(TEAM, TASK_ID, comment('c-1'));
    store.addComment(TEAM, TASK_ID, comment('c-2'));
    store.addAttachmentMeta(TEAM, TASK_ID, {
      id: 'a-1',
      filename: 'spec.md',
      mimeType: 'text/markdown',
      size: 12,
      addedAt: '2026-01-01T00:00:00.000Z',
      filePath: 'C:/tmp/spec.md',
    });
    store.addAttachmentMeta(TEAM, TASK_ID, {
      id: 'a-2',
      filename: 'log.txt',
      mimeType: 'text/plain',
      size: 3,
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    store.addAttachmentMeta(TEAM, TASK_ID, {
      id: 'a-1',
      filename: 'spec.md',
      mimeType: 'text/markdown',
      size: 12,
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    store.appendHistoryEvent(TEAM, TASK_ID, historyEvent('h-1'));
    const finalRecord = store.appendHistoryEvent(TEAM, TASK_ID, historyEvent('h-1'));

    expect(finalRecord.comments.map((entry) => entry.id)).toEqual(['c-1', 'c-2']);
    expect(finalRecord.attachments.map((entry) => entry.id)).toEqual(['a-1', 'a-2']);
    expect(finalRecord.attachments[0]?.filePath).toBe('C:/tmp/spec.md');
    expect(finalRecord.attachments[1]?.filePath).toBeUndefined();
    expect(finalRecord.historyEvents.map((entry) => entry.id)).toEqual(['h-1']);
  });

  it('lists team records most recently updated first', () => {
    const store = createStore();
    store.write(TEAM, OTHER_TASK_ID, { comments: [comment('c-1')] });
    advance(1_000);
    store.write(TEAM, TASK_ID, { comments: [comment('c-2')] });
    store.write('team-b', TASK_ID, { comments: [comment('c-3')] });

    const records: ExecutionTaskRecord[] = store.list(TEAM);
    expect(records.map((record) => record.taskId)).toEqual([TASK_ID, OTHER_TASK_ID]);
    expect(store.list('team-without-records')).toEqual([]);
  });

  it('leaves no temporary files behind after a write', () => {
    const store = createStore();
    store.write(TEAM, TASK_ID, { comments: [comment('c-1')] });

    expect(fs.readdirSync(path.join(basePath, TEAM)).sort()).toEqual([`${TASK_ID}.json`]);
  });

  it('keeps the previous record intact when publishing the new one fails', () => {
    const store = createStore();
    store.write(TEAM, TASK_ID, { comments: [comment('c-1')] });
    const before = fs.readFileSync(recordPath(TEAM, TASK_ID), 'utf8');
    const originalRenameSync = fs.renameSync;

    vi.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      if (String(to) === recordPath(TEAM, TASK_ID)) {
        const error = new Error('simulated publish failure') as NodeJS.ErrnoException;
        error.code = 'EIO';
        throw error;
      }
      originalRenameSync(from, to);
    }) as typeof fs.renameSync);

    expect(() => store.write(TEAM, TASK_ID, { comments: [comment('c-2')] })).toThrow(
      'simulated publish failure'
    );

    expect(fs.readFileSync(recordPath(TEAM, TASK_ID), 'utf8')).toBe(before);
    expect(fs.readdirSync(path.join(basePath, TEAM)).sort()).toEqual([`${TASK_ID}.json`]);
  });

  it('reports corrupt, mismatched, and unsupported records', () => {
    const store = createStore();
    fs.mkdirSync(path.join(basePath, TEAM), { recursive: true });

    fs.writeFileSync(recordPath(TEAM, TASK_ID), '{ not json', 'utf8');
    expect(captureError(() => store.read(TEAM, TASK_ID)).code).toBe('corrupt_record');

    fs.writeFileSync(
      recordPath(TEAM, TASK_ID),
      JSON.stringify({ schemaVersion: 1, taskId: OTHER_TASK_ID, updatedAt: nowMs }),
      'utf8'
    );
    expect(captureError(() => store.read(TEAM, TASK_ID)).code).toBe('corrupt_record');

    fs.writeFileSync(
      recordPath(TEAM, TASK_ID),
      JSON.stringify({ schemaVersion: 99, taskId: TASK_ID, updatedAt: nowMs }),
      'utf8'
    );
    expect(captureError(() => store.read(TEAM, TASK_ID)).code).toBe('unsupported_schema');
  });

  it('rejects team and task identifiers that could escape the store directory', () => {
    const store = createStore();

    for (const team of ['', '..', 'a/b', 'a\\b', 'team ', 'CON', 'team.']) {
      expect(captureError(() => store.read(team, TASK_ID)).code).toBe('invalid_team');
    }
    for (const taskId of ['', '..', 'a/b', 'a\\b', 'task ', 'task.']) {
      expect(captureError(() => store.read(TEAM, taskId)).code).toBe('invalid_task_id');
    }
  });

  it(
    'serializes concurrent writers across processes without losing events',
    async () => {
      const store = createStore();
      const tsxCli = requireFromTest.resolve('tsx/cli');
      const workers = 4;
      const eventsPerWorker = 5;

      await Promise.all(
        Array.from({ length: workers }, async (_unused, worker) => {
          await execFileAsync(
            process.execPath,
            [
              tsxCli,
              FIXTURE_PATH,
              basePath,
              TEAM,
              TASK_ID,
              `w${worker}`,
              String(eventsPerWorker),
            ],
            { timeout: 60_000 }
          );
        })
      );

      const record = store.read(TEAM, TASK_ID);
      expect(record).not.toBeNull();
      const eventIds = (record?.historyEvents ?? []).map((event) => event.id);
      expect(eventIds).toHaveLength(workers * eventsPerWorker);
      expect(new Set(eventIds).size).toBe(workers * eventsPerWorker);

      expect(Object.keys(readRawRecord(TEAM, TASK_ID)).sort()).toEqual(RECORD_KEYS.slice().sort());
      expect(fs.readdirSync(path.join(basePath, TEAM)).sort()).toEqual([`${TASK_ID}.json`]);
    },
    90_000
  );
});
