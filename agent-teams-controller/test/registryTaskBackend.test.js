const { startControlServer } = require('./helpers/controlServer.js');
const { createRegistryTaskBackend } = require('../src/internal/registryTaskBackend.js');
const { resetSyncControlRequestChannel } = require('../src/internal/syncControlRequest.js');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** Minimal stand-in for the HTTP client, so field semantics stay unit-testable. */
function createFakeClient(initialTasks = []) {
  const calls = [];
  const tasks = initialTasks.map(clone);
  let nextId = tasks.length + 1;

  function find(taskId) {
    return tasks.find((task) => String(task.id) === String(taskId));
  }

  return {
    calls,
    tasks,
    listTasks() {
      calls.push({ operation: 'listTasks' });
      return tasks.map(clone);
    },
    createTask(body) {
      calls.push({ operation: 'createTask', body: clone(body) });
      const task = {
        id: String(nextId),
        displayId: `#${nextId}`,
        subject: body.subject,
        status: 'pending',
        ...(body.owner ? { owner: body.owner } : {}),
      };
      nextId += 1;
      tasks.push(task);
      return clone(task);
    },
    setTaskStatus(taskId, body) {
      calls.push({ operation: 'setTaskStatus', taskId, body: clone(body) });
      const task = find(taskId);
      if (!task) {
        throw Object.assign(new Error('Task not found'), { code: 'TASK_NOT_FOUND' });
      }
      task.status = body.status;
      return clone(task);
    },
    patchTask(taskId, patch) {
      calls.push({ operation: 'patchTask', taskId, patch: clone(patch) });
      const task = find(taskId);
      if (!task) {
        throw Object.assign(new Error('Task not found'), { code: 'TASK_NOT_FOUND' });
      }
      Object.assign(task, clone(patch));
      return clone(task);
    },
  };
}

describe('registry task backend', () => {
  it('reads, resolves and filters tasks from the control API payload', () => {
    const client = createFakeClient([
      { id: '7', displayId: '#7', subject: 'Seven', status: 'pending' },
      { id: '8', displayId: '8', subject: 'Eight', status: 'completed' },
      { id: '9', displayId: '9', subject: 'Gone', status: 'deleted' },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    expect(backend.listTasks().map((task) => task.id)).toEqual(['7', '8']);
    expect(backend.listTasks({ includeDeleted: true }).map((task) => task.id)).toEqual([
      '7',
      '8',
      '9',
    ]);
    expect(backend.listTaskRows().anomalies).toEqual([]);
    expect(backend.readTask('#7').displayId).toBe('7');
    expect(backend.readTask('TASK-8').id).toBe('8');
    expect(backend.resolveTaskRef('8')).toBe('8');
    expect(() => backend.readTask('9')).toThrowError(
      expect.objectContaining({ code: 'TASK_NOT_FOUND' })
    );
    expect(backend.scanTaskRows().rowsByCanonicalId.get('7').task.subject).toBe('Seven');
  });

  it('rejects an ambiguous reference instead of guessing', () => {
    const client = createFakeClient([
      { id: '7', displayId: '7', subject: 'A', status: 'pending' },
      { id: 'TASK-7', displayId: '7', subject: 'B', status: 'pending' },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    expect(() => backend.readTask('7')).toThrowError(/Ambiguous task reference/);
  });

  it('creates a task with requirements, relations and an immediate start', () => {
    const client = createFakeClient([{ id: '1', displayId: '1', subject: 'Blocker', status: 'pending' }]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    const task = backend.createTask({
      subject: 'Child',
      description: 'Do it',
      requirements: ['FR-1', ' FR-1 ', 'AC-2'],
      owner: 'alice',
      startImmediately: true,
      blockedBy: ['1'],
      related: ['#1'],
    });

    expect(task.id).toBe('2');
    expect(client.calls.map((call) => call.operation)).toEqual([
      'createTask',
      'listTasks',
      'listTasks',
      'patchTask',
      'setTaskStatus',
      'listTasks',
    ]);
    expect(client.calls[0].body).toMatchObject({
      subject: 'Child',
      description: 'Do it',
      requirements: ['FR-1', 'AC-2'],
      owner: 'alice',
    });
    expect(client.calls[3].patch).toEqual({ blockedBy: ['1'], related: ['1'] });
    expect(client.calls[4].body).toEqual({ status: 'in_progress', expectedStatus: 'pending' });
  });

  it('refuses to accept a caller-chosen task id', () => {
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client: createFakeClient() });

    expect(() => backend.createTask({ id: '42', subject: 'Pinned' })).toThrowError(
      expect.objectContaining({ code: 'TASK_ID_UNSUPPORTED' })
    );
  });

  it('patches canonical fields and transitions status from the generic updater', () => {
    const client = createFakeClient([
      { id: '7', displayId: '7', subject: 'Old', status: 'pending', owner: 'alice' },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    backend.updateTask('7', (task) => {
      task.subject = 'New';
      task.owner = 'bob';
      task.status = 'in_progress';
      return task;
    });

    expect(client.calls.find((call) => call.operation === 'patchTask').patch).toEqual({
      subject: 'New',
      owner: 'bob',
    });
    expect(client.calls.find((call) => call.operation === 'setTaskStatus').body).toEqual({
      status: 'in_progress',
      expectedStatus: 'pending',
    });
  });

  it('rejects an updater that touches execution-only fields', () => {
    const client = createFakeClient([{ id: '7', displayId: '7', subject: 'S', status: 'pending' }]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    expect(() =>
      backend.updateTask('7', (task) => {
        task.comments = [{ id: 'c1', text: 'hello' }];
        return task;
      })
    ).toThrowError(
      expect.objectContaining({ code: 'REGISTRY_FIELD_UNSUPPORTED', fields: ['comments'] })
    );
    expect(client.calls.some((call) => call.operation === 'patchTask')).toBe(false);
  });

  it('mirrors the file backend owner rules: clearing an owner is refused', () => {
    const client = createFakeClient([
      { id: '7', displayId: '7', subject: 'S', status: 'pending', owner: 'alice' },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    expect(() => backend.setTaskOwner('7', null)).toThrowError(
      expect.objectContaining({ code: 'OWNER_CLEAR_UNSUPPORTED' })
    );
    expect(backend.setTaskOwner('7', ' bob ').owner).toBe('bob');
  });

  it('adds and removes blockedBy and related links through one patch', () => {
    const client = createFakeClient([
      { id: '1', displayId: '1', subject: 'A', status: 'pending' },
      { id: '2', displayId: '2', subject: 'B', status: 'pending' },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    expect(backend.linkTask('1', '2', 'blocked-by').blockedBy).toEqual(['2']);
    expect(backend.linkTask('1', '2', 'related').related).toEqual(['2']);
    expect(backend.unlinkTask('1', '2', 'blocked-by').blockedBy).toEqual([]);
    expect(() => backend.linkTask('1', '1', 'related')).toThrowError(
      'Cannot link a task to itself'
    );
  });

  it('detects a dependency cycle before writing', () => {
    const client = createFakeClient([
      { id: '1', displayId: '1', subject: 'A', status: 'pending', blockedBy: ['2'] },
      { id: '2', displayId: '2', subject: 'B', status: 'pending' },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    expect(() => backend.linkTask('2', '1', 'blocked-by')).toThrowError(/Circular dependency/);
    expect(client.calls.some((call) => call.operation === 'patchTask')).toBe(false);
  });

  it('fails closed: execution-store operations have no registry shape', () => {
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client: createFakeClient() });

    expect(() => backend.reconcileTaskCreation({ id: '1' })).toThrowError(
      expect.objectContaining({ code: 'REGISTRY_OPERATION_UNSUPPORTED' })
    );
  });

  it('drives the real HTTP client against the control API', async () => {
    const server = await startControlServer({
      initialTasks: [
        { id: '7', displayId: '7', subject: 'Registry task', status: 'pending', owner: 'alice' },
      ],
    });
    resetSyncControlRequestChannel();
    try {
      const backend = createRegistryTaskBackend({
        teamName: 'team-a',
        baseUrl: server.url,
        headers: { 'x-agent-teams-app-context': '{"appInstanceId":"app-1"}' },
      });

      expect(backend.listTasks().map((task) => task.id)).toEqual(['7']);
      expect(backend.setTaskStatus('7', 'in_progress').status).toBe('in_progress');
      expect(backend.setTaskOwner('7', 'bob').owner).toBe('bob');

      const created = backend.createTask({ subject: 'Fresh', requirements: ['FR-2'] });
      expect(created).toMatchObject({ subject: 'Fresh', status: 'pending' });
    } finally {
      resetSyncControlRequestChannel();
      await server.stop();
    }
  });
});
