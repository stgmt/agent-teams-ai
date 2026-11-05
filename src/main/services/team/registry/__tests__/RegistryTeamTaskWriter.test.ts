// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutionTaskStore } from '../../execution/ExecutionTaskStore';
import { RegistryStatusConflictError } from '../RegistryTaskClientErrors';
import { RegistryTeamTaskWriteError, RegistryTeamTaskWriter } from '../RegistryTeamTaskWriter';

import type {
  ListRegistryTasksInput,
  RegistryTask,
  RegistryTaskStatusResult,
  RegistryTaskWriteResult,
  ReplaceRegistryTaskLinksInput,
  ReplaceRegistryTaskOwnerInput,
  ReplaceRegistryTaskStatusInput,
  UpsertRegistryTaskInput,
} from '../RegistryTaskClientTypes';
import type { RegistryTeamTaskClientPort } from '../RegistryTeamTaskWriter';

const PROJECT = 'stgmt/tokenplan';
const SPEC = 'balancer-consistency-hardening';
const TEAM = 'alpha-team';
const NOW = '2026-01-01T00:00:00.000Z';

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

function makeTempBasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-task-writer-'));
  tempPaths.push(dir);
  return dir;
}

function registryTask(localId: string, overrides: Partial<RegistryTask> = {}): RegistryTask {
  return {
    canonicalId: `${SPEC}:TASK-${localId}`,
    localId,
    title: `Task ${localId}`,
    status: 'todo',
    owner: null,
    tracking: null,
    requirements: ['FR-1'],
    dependsOn: [],
    blocks: [],
    blockedBy: [],
    refs: [],
    contentHash: null,
    ...overrides,
  };
}

function applied(): RegistryTaskWriteResult {
  return { outcome: 'APPLIED', transitions: [], refusal: null };
}

class FakeRegistryClient implements RegistryTeamTaskClientPort {
  tasks: RegistryTask[] = [];
  readonly listTasks = vi.fn(async (_input: ListRegistryTasksInput) => this.tasks);
  readonly upsertTask = vi.fn(
    async (_input: UpsertRegistryTaskInput): Promise<RegistryTaskWriteResult> => applied()
  );
  readonly replaceTaskStatus = vi.fn(
    async (_input: ReplaceRegistryTaskStatusInput): Promise<RegistryTaskStatusResult> => ({
      outcome: 'APPLIED' as const,
      transitions: [],
    })
  );
  readonly replaceTaskOwner = vi.fn(
    async (_input: ReplaceRegistryTaskOwnerInput): Promise<RegistryTaskWriteResult> => applied()
  );
  readonly replaceTaskLinks = vi.fn(
    async (_input: ReplaceRegistryTaskLinksInput): Promise<RegistryTaskWriteResult> => applied()
  );
}

function createWriter(client: FakeRegistryClient): {
  writer: RegistryTeamTaskWriter;
  store: ExecutionTaskStore;
} {
  const store = new ExecutionTaskStore({ basePath: makeTempBasePath() });
  return {
    store,
    writer: new RegistryTeamTaskWriter({
      teamName: TEAM,
      binding: { project: PROJECT, spec: SPEC },
      client,
      executionStore: store,
      clock: () => new Date(NOW),
    }),
  };
}

async function expectWriteError(
  run: Promise<unknown>,
  code: RegistryTeamTaskWriteError['code']
): Promise<RegistryTeamTaskWriteError> {
  const error = await run.then(
    () => null,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(RegistryTeamTaskWriteError);
  const typed = error as RegistryTeamTaskWriteError;
  expect(typed.code).toBe(code);
  return typed;
}

describe('RegistryTeamTaskWriter creation', () => {
  it('refuses to create a task without requirements and never writes the registry', async () => {
    const client = new FakeRegistryClient();
    const { writer } = createWriter(client);

    await expectWriteError(
      writer.createTask({ subject: 'Broken task', requirements: [] }),
      'REQUIREMENTS_REQUIRED'
    );
    expect(client.upsertTask).not.toHaveBeenCalled();
  });

  it('creates the task in the registry and records the creation locally', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);

    const { task, createdInAttempt } = await writer.createTask({
      subject: 'Implement balancer cap',
      description: 'Body text',
      requirements: ['FR-11.5'],
      owner: 'lead',
      tracking: 'track-1',
    });

    expect(createdInAttempt).toBe(true);
    expect(task.id).toBe('1');
    expect(task.subject).toBe('Implement balancer cap');
    expect(task.status).toBe('pending');
    expect(task.owner).toBe('lead');
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
    expect(client.upsertTask.mock.calls[0][0]).toMatchObject({
      project: PROJECT,
      spec: SPEC,
      localId: '1',
      title: 'Implement balancer cap',
      requirements: ['FR-11.5'],
      status: 'todo',
      owner: 'lead',
      tracking: 'track-1',
      body: 'Body text',
    });

    const record = store.read(TEAM, '1');
    expect(record?.historyEvents).toHaveLength(1);
    expect(record?.historyEvents[0]).toMatchObject({ type: 'task_created', status: 'pending' });
    expect(record?.workIntervals).toEqual([]);
  });

  it('starts the task and opens a work interval when it is created with an owner', async () => {
    const client = new FakeRegistryClient();
    const { writer, store } = createWriter(client);

    const { task } = await writer.createTask({
      subject: 'Started task',
      requirements: ['FR-1'],
      owner: 'lead',
      startImmediately: true,
    });

    expect(client.upsertTask.mock.calls[0][0]).toMatchObject({ status: 'in-progress' });
    expect(task.status).toBe('in_progress');
    expect(store.read(TEAM, '1')?.workIntervals).toEqual([{ startedAt: NOW }]);
  });

  it('replays an idempotent creation instead of creating a second task', async () => {
    const client = new FakeRegistryClient();
    const { writer } = createWriter(client);

    const first = await writer.createTask({
      subject: 'Once',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'idem-1',
    });
    client.tasks = [registryTask('1')];
    const second = await writer.createTask({
      subject: 'Once',
      requirements: ['FR-1'],
      commandIdempotencyKey: 'idem-1',
    });

    expect(first.task.id).toBe('1');
    expect(second.createdInAttempt).toBe(false);
    expect(second.task.id).toBe('1');
    expect(client.upsertTask).toHaveBeenCalledTimes(1);
  });
});

describe('RegistryTeamTaskWriter status', () => {
  it('sends the last read as expectedStatus', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { status: 'todo' })];
    const { writer } = createWriter(client);

    await writer.replaceStatus({ taskId: '1', to: 'in_progress', actor: 'alice' });

    expect(client.replaceTaskStatus.mock.calls[0][0]).toMatchObject({
      entity: '1',
      status: 'in-progress',
      expectedStatus: 'todo',
    });
  });

  it('raises a typed STATUS_CONFLICT and writes no local status history', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { status: 'todo' })];
    client.replaceTaskStatus.mockRejectedValueOnce(
      new RegistryStatusConflictError({
        operation: 'replaceTaskStatus',
        message: 'STATUS_CONFLICT',
        currentStatus: 'done',
        expectedStatus: 'todo',
        localId: '1',
      })
    );
    const { writer, store } = createWriter(client);

    const error = await expectWriteError(
      writer.replaceStatus({ taskId: '1', to: 'completed' }),
      'STATUS_CONFLICT'
    );

    expect(error.taskId).toBe('1');
    expect(error.details).toMatchObject({ currentStatus: 'done', expectedStatus: 'todo' });
    expect(store.read(TEAM, '1')).toBeNull();
  });

  it('refuses to represent the local "deleted" status in the registry', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1')];
    const { writer } = createWriter(client);

    await expectWriteError(
      writer.replaceStatus({ taskId: '1', to: 'deleted' }),
      'STATUS_UNSUPPORTED'
    );
    expect(client.replaceTaskStatus).not.toHaveBeenCalled();
  });

  it('closes the work interval and records the transition locally', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { status: 'in-progress' })];
    const { writer, store } = createWriter(client);
    store.write(TEAM, '1', { workIntervals: [{ startedAt: '2025-12-31T23:00:00.000Z' }] });

    await writer.replaceStatus({ taskId: '1', to: 'completed', actor: 'alice' });

    const record = store.read(TEAM, '1');
    expect(record?.workIntervals).toEqual([
      { startedAt: '2025-12-31T23:00:00.000Z', completedAt: NOW },
    ]);
    expect(record?.historyEvents.at(-1)).toMatchObject({
      type: 'status_changed',
      from: 'in_progress',
      to: 'completed',
      actor: 'alice',
    });
  });
});

describe('RegistryTeamTaskWriter owner and links', () => {
  it('replaces the owner through the registry and records the change locally', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { owner: 'alice' })];
    const { writer, store } = createWriter(client);

    await writer.replaceOwner({ taskId: '1', owner: 'bob' });

    expect(client.replaceTaskOwner.mock.calls[0][0]).toMatchObject({ entity: '1', owner: 'bob' });
    expect(store.read(TEAM, '1')?.historyEvents.at(-1)).toMatchObject({
      type: 'owner_changed',
      from: 'alice',
      to: 'bob',
    });
  });

  it('refuses to clear an owner instead of writing a bogus empty value', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1', { owner: 'alice' })];
    const { writer } = createWriter(client);

    await expectWriteError(
      writer.replaceOwner({ taskId: '1', owner: null }),
      'OWNER_CLEAR_UNSUPPORTED'
    );
    expect(client.replaceTaskOwner).not.toHaveBeenCalled();
  });

  it('writes blockedBy as a registry dependsOn link', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1'), registryTask('2')];
    const { writer } = createWriter(client);

    await writer.addLink({ taskId: '1', targetId: '2', type: 'blockedBy' });

    expect(client.replaceTaskLinks.mock.calls[0][0]).toMatchObject({
      entity: '1',
      dependsOn: [`${SPEC}:TASK-2`],
    });
  });

  it('writes related as a registry ref and removes it again', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [registryTask('1'), registryTask('2')];
    const { writer } = createWriter(client);

    await writer.addLink({ taskId: '1', targetId: '2', type: 'related' });
    expect(client.replaceTaskLinks.mock.calls[0][0]).toMatchObject({
      entity: '1',
      refs: [`${SPEC}:TASK-2`],
    });

    client.tasks = [registryTask('1', { refs: [`${SPEC}:TASK-2`] }), registryTask('2')];
    await writer.removeLink({ taskId: '1', targetId: '2', type: 'related' });
    expect(client.replaceTaskLinks.mock.calls[1][0]).toMatchObject({ entity: '1', refs: [] });
  });

  it('rejects a blockedBy link that would close a dependency cycle', async () => {
    const client = new FakeRegistryClient();
    client.tasks = [
      registryTask('1'),
      registryTask('2', { dependsOn: [`${SPEC}:TASK-3`] }),
      registryTask('3', { dependsOn: [`${SPEC}:TASK-1`] }),
    ];
    const { writer } = createWriter(client);

    await expectWriteError(
      writer.addLink({ taskId: '1', targetId: '2', type: 'blockedBy' }),
      'LINK_CYCLE'
    );
    expect(client.replaceTaskLinks).not.toHaveBeenCalled();
  });
});
