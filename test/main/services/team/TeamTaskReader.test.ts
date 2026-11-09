import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamTaskReader } from '../../../../src/main/services/team/TeamTaskReader';
import { setClaudeBasePathOverride } from '../../../../src/main/utils/pathDecoder';

import type { TeamTask } from '../../../../src/shared/types/team';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeTask(id: string): TeamTask & { teamName: string } {
  return {
    id,
    subject: id,
    owner: 'alice',
    status: 'pending',
    createdAt: '2026-05-02T12:00:00.000Z',
    updatedAt: '2026-05-02T12:00:00.000Z',
    teamName: 'atlas-hq',
  };
}

describe('TeamTaskReader', () => {
  let tmpDir: string | null = null;

  afterEach(async () => {
    vi.restoreAllMocks();
    TeamTaskReader.invalidateAllTasksCache();
    setClaudeBasePathOverride(null);
    if (tmpDir) {
      await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
      tmpDir = null;
    }
  });

  async function setupTasksRoot(): Promise<string> {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'team-task-reader-'));
    setClaudeBasePathOverride(tmpDir);
    await fsp.mkdir(path.join(tmpDir, 'tasks'), { recursive: true });
    return tmpDir;
  }

  async function writeTaskFile(teamName: string, task: Record<string, unknown>): Promise<string> {
    const tasksDir = path.join(tmpDir!, 'tasks', teamName);
    await fsp.mkdir(tasksDir, { recursive: true });
    const taskPath = path.join(tasksDir, `${String(task.id)}.json`);
    await fsp.writeFile(taskPath, JSON.stringify(task, null, 2), 'utf8');
    return taskPath;
  }

  it('does not reuse or cache a stale in-flight getAllTasks scan after invalidation', async () => {
    const firstRead = createDeferred<(TeamTask & { teamName: string })[]>();
    const secondRead = createDeferred<(TeamTask & { teamName: string })[]>();
    const readAllTasksUncached = vi
      .spyOn(
        TeamTaskReader.prototype as unknown as {
          readAllTasksUncached: () => Promise<(TeamTask & { teamName: string })[]>;
        },
        'readAllTasksUncached'
      )
      .mockImplementationOnce(() => firstRead.promise)
      .mockImplementationOnce(() => secondRead.promise);

    const reader = new TeamTaskReader();
    const staleRequest = reader.getAllTasks();
    await Promise.resolve();
    expect(readAllTasksUncached).toHaveBeenCalledTimes(1);

    TeamTaskReader.invalidateAllTasksCache();
    const freshRequest = reader.getAllTasks();
    await Promise.resolve();
    expect(readAllTasksUncached).toHaveBeenCalledTimes(2);

    secondRead.resolve([makeTask('fresh-task')]);
    await expect(freshRequest).resolves.toEqual([makeTask('fresh-task')]);

    firstRead.resolve([makeTask('stale-task')]);
    await staleRequest;

    await expect(reader.getAllTasks()).resolves.toEqual([makeTask('fresh-task')]);
    expect(readAllTasksUncached).toHaveBeenCalledTimes(2);
  });

  it('keeps cached getAllTasks data isolated from caller mutations', async () => {
    const readAllTasksUncached = vi
      .spyOn(
        TeamTaskReader.prototype as unknown as {
          readAllTasksUncached: () => Promise<(TeamTask & { teamName: string })[]>;
        },
        'readAllTasksUncached'
      )
      .mockResolvedValueOnce([makeTask('cached-task')]);

    const reader = new TeamTaskReader();
    const firstRead = await reader.getAllTasks();
    firstRead[0]!.subject = 'mutated caller copy';

    await expect(reader.getAllTasks()).resolves.toEqual([makeTask('cached-task')]);
    expect(readAllTasksUncached).toHaveBeenCalledTimes(1);
  });

  it('preserves blockers in the global projection snapshot', async () => {
    await setupTasksRoot();
    await writeTaskFile('atlas-hq', {
      id: 'blocked-task',
      subject: 'Blocked task',
      status: 'pending',
      createdAt: '2026-05-02T12:00:00.000Z',
      blockedBy: ['old-blocker'],
      groupChatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });

    const tasks = await new TeamTaskReader().getAllTasksProjectionSnapshot();

    expect(tasks).toMatchObject([
      {
        id: 'blocked-task',
        teamName: 'atlas-hq',
        blockedBy: ['old-blocker'],
        groupChatId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    ]);
  });

  it('projects a required artifact and its attachment to the task detail', async () => {
    await setupTasksRoot();
    const artifactRequirement = {
      required: true,
      proof: { attachmentId: 'artifact-1', sha256: 'a'.repeat(64), size: 8 },
      expectedFilename: 'result.mp4',
    };
    await writeTaskFile('atlas-hq', {
      id: 'artifact-task', subject: 'Artifact task', status: 'pending',
      artifactRequirement,
      attachments: [{ id: 'artifact-1', filename: 'result.mp4', mimeType: 'application/octet-stream', size: 8, addedAt: '2026-05-02T12:00:00.000Z' }],
    });
    const tasks = await new TeamTaskReader().getTasks('atlas-hq');
    expect(tasks[0]).toMatchObject({ artifactRequirement, attachments: [{ id: 'artifact-1' }] });
  });

  it('preserves registry fields and existing artifact metadata on task reads', async () => {
    await setupTasksRoot();
    const registryFields = {
      specProject: 'owner/project',
      specSlug: 'example',
      registryLocalId: 'TASK-1',
      registryStatus: 'blocked',
      registryTask: {
        canonicalId: 'example:TASK-1', specSlug: 'example', localId: '1', title: 'Registry task',
        description: null, creationToken: null, status: 'blocked', phase: null, owner: null,
        tracking: null, contentHash: null,
        source: { path: null, startLine: null, startColumn: null, endLine: null, endColumn: null },
        requirements: ['FR-1'], dependsOn: [], blocks: [], blockedBy: [],
      },
      registryEntity: {
        canonicalId: 'example:TASK-1', specSlug: 'example', localId: '1', kind: 'TASK',
        title: 'Registry task', body: 'body', attributes: {}, contentHash: null, span: null,
      },
      registrySource: { path: null, startLine: null, startColumn: null, endLine: null, endColumn: null },
      requirements: ['FR-1'],
      dependsOn: ['TASK-2'],
      registryRefs: ['example:TASK-2'],
      registryPhase: null,
      tracking: 'work',
      contentHash: null,
      registryBody: 'body',
      registryAttributes: { priority: 'high' },
      doneWhen: null,
      creationCommand: { namespace: 'agent', scopeKey: 'scope', operation: 'create', commandId: 'cmd', payloadHash: 'hash' },
    };
    const artifactRequirement = { required: true, expectedFilename: 'output.txt' };
    await writeTaskFile('atlas-hq', {
      id: '1', subject: 'Registry task', status: 'pending', ...registryFields, artifactRequirement,
    });
    const tasks = await new TeamTaskReader().getTasks('atlas-hq');
    expect(tasks[0]).toMatchObject({ ...registryFields, artifactRequirement });
  });

  it('does not invent registry values for a legacy task', async () => {
    await setupTasksRoot();
    await writeTaskFile('atlas-hq', { id: '1', subject: 'Legacy task', status: 'pending' });
    const [task] = await new TeamTaskReader().getTasks('atlas-hq');
    expect(task?.specProject).toBeUndefined();
    expect(task?.requirements).toBeUndefined();
    expect(task?.registryStatus).toBeUndefined();
  });

  it('does not promote malformed registry snapshots to typed task data', async () => {
    await setupTasksRoot();
    await writeTaskFile('atlas-hq', {
      id: '1', subject: 'Invalid registry data', status: 'pending',
      registryStatus: 'not-a-status', registryTask: {}, registryEntity: {}, registrySource: {},
    });
    const [task] = await new TeamTaskReader().getTasks('atlas-hq');
    expect(task?.registryStatus).toBeUndefined();
    expect(task?.registryTask).toBeUndefined();
    expect(task?.registryEntity).toBeUndefined();
    expect(task?.registrySource).toBeUndefined();
  });

  it('does not retain full parsed task payloads in the projection cache', async () => {
    await setupTasksRoot();
    await writeTaskFile('atlas-hq', {
      id: '1',
      subject: 'Cached task',
      status: 'pending',
      createdAt: '2026-05-02T12:00:00.000Z',
    });

    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const reader = new TeamTaskReader();

    const firstRead = await reader.getTasks('atlas-hq');
    expect(firstRead).toMatchObject([{ id: '1', subject: 'Cached task' }]);
    firstRead[0]!.subject = 'Mutated caller copy';
    await expect(reader.getTasks('atlas-hq')).resolves.toMatchObject([
      { id: '1', subject: 'Cached task' },
    ]);
    expect(readFileSpy).toHaveBeenCalledTimes(2);

    await writeTaskFile('atlas-hq', {
      id: '1',
      subject: 'Changed cached task',
      status: 'pending',
      createdAt: '2026-05-02T12:00:00.000Z',
    });

    await expect(reader.getTasks('atlas-hq')).resolves.toMatchObject([
      { id: '1', subject: 'Changed cached task' },
    ]);
    expect(readFileSpy).toHaveBeenCalledTimes(3);
  });

  it('reuses read-only team task projection snapshots until a file signature changes', async () => {
    await setupTasksRoot();
    const taskPath = await writeTaskFile('atlas-hq', {
      id: '1',
      subject: 'Projection cached task',
      status: 'pending',
      createdAt: '2026-05-02T12:00:00.000Z',
    });

    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const reader = new TeamTaskReader();

    const firstRead = await reader.getTasksProjectionSnapshot('atlas-hq');
    const secondRead = await reader.getTasksProjectionSnapshot('atlas-hq');

    expect(secondRead).toBe(firstRead);
    expect(secondRead).toMatchObject([{ id: '1', subject: 'Projection cached task' }]);
    expect(readFileSpy).toHaveBeenCalledTimes(1);

    await fsp.writeFile(
      taskPath,
      JSON.stringify(
        {
          id: '1',
          subject: 'Projection changed task',
          status: 'pending',
          createdAt: '2026-05-02T12:00:00.000Z',
        },
        null,
        2
      ),
      'utf8'
    );
    const changedTime = new Date(Date.now() + 2_000);
    await fsp.utimes(taskPath, changedTime, changedTime);

    const thirdRead = await reader.getTasksProjectionSnapshot('atlas-hq');
    expect(thirdRead).not.toBe(firstRead);
    expect(thirdRead).toMatchObject([{ id: '1', subject: 'Projection changed task' }]);
    expect(readFileSpy).toHaveBeenCalledTimes(2);
  });

  it('compacts heavy task fields before caching projection snapshots', async () => {
    await setupTasksRoot();
    for (let index = 0; index < 5; index++) {
      await writeTaskFile('atlas-hq', {
        id: String(index + 1),
        subject: `Large task ${index + 1}`,
        status: 'pending',
        createdAt: '2026-05-02T12:00:00.000Z',
        description: 'description '.repeat(500),
        prompt: 'prompt '.repeat(500),
        comments: [
          {
            id: `comment-${index + 1}`,
            type: 'regular',
            author: 'alice',
            text: 'x'.repeat(10_000),
            createdAt: '2026-05-02T12:00:00.000Z',
          },
        ],
        historyEvents: [
          {
            id: `event-${index + 1}`,
            type: 'review_requested',
            from: 'none',
            to: 'review',
            timestamp: '2026-05-02T12:00:00.000Z',
            note: 'note '.repeat(500),
          },
        ],
        sourceMessage: {
          text: 'source '.repeat(500),
          from: 'user',
          timestamp: '2026-05-02T11:59:00.000Z',
        },
      });
    }

    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const reader = new TeamTaskReader();

    const firstRead = await reader.getTasksProjectionSnapshot('atlas-hq');
    const secondRead = await reader.getTasksProjectionSnapshot('atlas-hq');

    expect(secondRead).toBe(firstRead);
    expect(firstRead).toHaveLength(5);
    expect(firstRead[0]?.description).toHaveLength(2_000);
    expect(firstRead[0]?.prompt).toHaveLength(2_000);
    expect(firstRead[0]?.comments?.[0]?.text).toHaveLength(120);
    expect((firstRead[0]?.historyEvents?.[0] as { note?: string } | undefined)?.note).toHaveLength(
      500
    );
    expect(firstRead[0]?.sourceMessage?.text).toHaveLength(1_000);
    expect(readFileSpy).toHaveBeenCalledTimes(5);
  });

  it('keeps full getTasks reads independent from compact projection cache', async () => {
    await setupTasksRoot();
    const fullComment = 'full comment '.repeat(500);
    await writeTaskFile('atlas-hq', {
      id: '1',
      subject: 'Full task',
      status: 'pending',
      createdAt: '2026-05-02T12:00:00.000Z',
      comments: [
        {
          id: 'comment-1',
          type: 'regular',
          author: 'alice',
          text: fullComment,
          createdAt: '2026-05-02T12:00:00.000Z',
        },
      ],
    });

    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const reader = new TeamTaskReader();

    const fullBeforeProjection = await reader.getTasks('atlas-hq');
    const projection = await reader.getTasksProjectionSnapshot('atlas-hq');
    const fullAfterProjection = await reader.getTasks('atlas-hq');

    expect(fullBeforeProjection[0]?.comments?.[0]?.text).toBe(fullComment);
    expect(projection[0]?.comments?.[0]?.text).toHaveLength(120);
    expect(fullAfterProjection[0]?.comments?.[0]?.text).toBe(fullComment);
    expect(readFileSpy).toHaveBeenCalledTimes(3);
  });
});
