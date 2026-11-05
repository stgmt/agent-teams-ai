import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ExecutionTaskStore } from '../../../../src/main/services/team/execution/ExecutionTaskStore';
import { RegistryTeamTaskWriter } from '../../../../src/main/services/team/registry/RegistryTeamTaskWriter';
import type { RegistryTask, RegistryTaskWriteResult } from '../../../../src/main/services/team/registry/RegistryTaskClientTypes';
import type { RegistryTeamTaskClientPort } from '../../../../src/main/services/team/registry/RegistryTeamTaskWriter';

const TEAM = 'my-team';
const SPEC = 'test-spec';
const NOW = '2026-01-01T00:00:00.000Z';
const tempPaths: string[] = [];

afterEach(() => {
  for (const dir of tempPaths.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function task(overrides: Partial<RegistryTask> = {}): RegistryTask {
  return {
    canonicalId: `${SPEC}:TASK-12`, localId: '12', title: 'task', status: 'todo',
    owner: 'alice', tracking: null, requirements: ['FR-1'], dependsOn: [], blocks: [],
    blockedBy: [], refs: [], contentHash: null, ...overrides,
  };
}

function setup(tasks: RegistryTask[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-writer-behavior-'));
  tempPaths.push(dir);
  const store = new ExecutionTaskStore({ basePath: dir });
  const applied = (): RegistryTaskWriteResult => ({ outcome: 'APPLIED', transitions: [], refusal: null });
  const client: RegistryTeamTaskClientPort = {
    readTasksDocumentSha: vi.fn(async () => 'a'.repeat(64)),
    confirmTaskCreation: vi.fn(async () => false),
    listTasks: vi.fn(async () => tasks),
    upsertTask: vi.fn(async () => applied()),
    replaceTaskStatus: vi.fn(async () => ({ outcome: 'APPLIED' as const, transitions: [] })),
    replaceTaskOwner: vi.fn(async () => applied()),
    replaceTaskLinks: vi.fn(async () => applied()),
  };
  const writer = new RegistryTeamTaskWriter({
    teamName: TEAM, binding: { project: 'test/project', spec: SPEC }, client,
    executionStore: store, clock: () => new Date(NOW),
  });
  return { writer, store, client };
}

describe('registry task writer behavior', () => {
  it('creates canonical task details and records creation history separately', async () => {
    const { writer, store, client } = setup();
    const { task: created } = await writer.createTask({
      subject: 'Test task', description: 'Some description', owner: 'bob',
      requirements: ['FR-1'], actor: 'alice',
    });
    expect(created).toMatchObject({ id: '1', subject: 'Test task', owner: 'bob', status: 'pending' });
    expect(client.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      localId: '1', title: 'Test task', description: 'Some description', owner: 'bob',
      status: 'todo', requirements: ['FR-1'],
    }));
    expect(store.read(TEAM, '1')?.historyEvents).toEqual([
      expect.objectContaining({ type: 'task_created', status: 'pending', actor: 'alice', timestamp: NOW }),
    ]);
  });

  it('preserves creation dependencies in canonical task references', async () => {
    const { writer, client, store } = setup();
    await writer.createTask({
      subject: 'With dependencies', requirements: ['FR-1'],
      blockedBy: ['7'], related: ['3'],
    });
    expect(client.upsertTask).toHaveBeenCalledWith(expect.objectContaining({
      dependsOn: [`${SPEC}:TASK-7`], refs: [`${SPEC}:TASK-3`],
    }));
    expect(store.read(TEAM, '1')?.historyEvents).toEqual([
      expect.objectContaining({ type: 'task_created', actor: 'user' }),
    ]);
  });

  it('opens an interval and records creation history when started immediately', async () => {
    const { writer, store } = setup();
    const { task: created } = await writer.createTask({
      subject: 'Start immediately', requirements: ['FR-1'], status: 'in_progress', actor: 'bob',
    });
    const execution = store.read(TEAM, created.id);
    expect(execution?.workIntervals).toEqual([{ startedAt: NOW }]);
    expect(execution?.historyEvents).toEqual([
      expect.objectContaining({ type: 'task_created', status: 'in_progress', actor: 'bob' }),
    ]);
  });

  it('updates status using the canonical precondition and appends execution history', async () => {
    const { writer, store, client } = setup([task()]);
    await writer.replaceStatus({ taskId: '12', to: 'in_progress', actor: 'alice' });
    expect(client.replaceTaskStatus).toHaveBeenCalledWith(expect.objectContaining({
      entity: '12', expectedStatus: 'todo', status: 'in-progress',
    }));
    expect(store.read(TEAM, '12')).toMatchObject({
      workIntervals: [{ startedAt: NOW }],
      historyEvents: [expect.objectContaining({ type: 'status_changed', from: 'pending', to: 'in_progress', actor: 'alice' })],
    });
  });

  it('opens a new interval after a completed interval', async () => {
    const { writer, store } = setup([task()]);
    store.write(TEAM, '12', { workIntervals: [{ startedAt: '2025-12-30T10:00:00.000Z', completedAt: '2025-12-30T11:00:00.000Z' }] });
    await writer.replaceStatus({ taskId: '12', to: 'in_progress' });
    expect(store.read(TEAM, '12')?.workIntervals).toEqual([
      { startedAt: '2025-12-30T10:00:00.000Z', completedAt: '2025-12-30T11:00:00.000Z' },
      { startedAt: NOW },
    ]);
  });

  it('closes the open interval and preserves prior execution history', async () => {
    const { writer, store } = setup([task({ status: 'in-progress' })]);
    store.write(TEAM, '12', {
      workIntervals: [{ startedAt: '2025-12-30T10:00:00.000Z' }],
      historyEvents: [{ id: 'created', type: 'task_created', timestamp: '2025-12-30T10:00:00.000Z', status: 'pending' }],
    });
    await writer.replaceStatus({ taskId: '12', to: 'completed' });
    const record = store.read(TEAM, '12');
    expect(record?.workIntervals).toEqual([{ startedAt: '2025-12-30T10:00:00.000Z', completedAt: NOW }]);
    expect(record?.historyEvents).toEqual([
      expect.objectContaining({ id: 'created', type: 'task_created' }),
      expect.objectContaining({ type: 'status_changed', from: 'in_progress', to: 'completed' }),
    ]);
    expect(record?.historyEvents[1].actor).toBeUndefined();
  });

  it('rejects stale status preconditions without writing execution history', async () => {
    const { writer, store, client } = setup([task()]);
    await expect(writer.replaceStatus({ taskId: '12', to: 'in_progress', expectedStatus: 'completed' }))
      .rejects.toMatchObject({ code: 'STATUS_CONFLICT' });
    expect(client.replaceTaskStatus).not.toHaveBeenCalled();
    expect(store.read(TEAM, '12')).toBeNull();
  });

  it('records an owner change and clears the registry owner', async () => {
    const { writer, store, client } = setup([task()]);
    await writer.replaceOwner({ taskId: '12', owner: 'bob' });
    expect(client.replaceTaskOwner).toHaveBeenCalledWith(expect.objectContaining({ entity: '12', owner: 'bob' }));
    expect(store.read(TEAM, '12')?.historyEvents).toEqual([
      expect.objectContaining({ type: 'owner_changed', from: 'alice', to: 'bob', actor: 'user' }),
    ]);
    await writer.replaceOwner({ taskId: '12', owner: null });
    expect(client.replaceTaskOwner).toHaveBeenLastCalledWith(expect.objectContaining({ entity: '12', owner: null }));
    expect(store.read(TEAM, '12')?.historyEvents.at(-1)).toMatchObject({ type: 'owner_changed', from: 'alice' });
  });

  it('writes deletion to the registry and records the status change locally', async () => {
    const { writer, store, client } = setup([task()]);
    await writer.replaceStatus({ taskId: '12', to: 'deleted' });
    expect(client.replaceTaskStatus).toHaveBeenCalledWith(expect.objectContaining({ status: 'deleted', expectedStatus: 'todo' }));
    expect(store.read(TEAM, '12')?.historyEvents.at(-1)).toMatchObject({ type: 'status_changed', from: 'pending', to: 'deleted' });
  });
});
