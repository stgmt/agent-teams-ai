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
    createTaskWithOutcome(body) {
      calls.push({ operation: 'createTask', body: clone(body) });
      const task = {
        id: String(nextId),
        displayId: `#${nextId}`,
        subject: body.subject,
        status: body.status || (body.startImmediately ? 'in_progress' : 'pending'),
        ...(body.owner ? { owner: body.owner } : {}),
        ...(body.blockedBy ? { blockedBy: body.blockedBy } : {}),
        ...(body.related ? { related: body.related } : {}),
      };
      nextId += 1;
      tasks.push(task);
      return { task: clone(task), outcome: 'APPLIED' };
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
      const { actor: _actor, ...fields } = patch;
      Object.assign(task, clone(fields));
      if (fields.owner === null) delete task.owner;
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

  it('creates a blocked task with requirements and relations without starting it', () => {
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
      'listTasks',
      'listTasks',
      'createTask',
      'listTasks',
    ]);
    expect(client.calls[2].body).toMatchObject({
      subject: 'Child',
      description: 'Do it',
      requirements: ['FR-1', 'AC-2'],
      owner: 'alice',
      blockedBy: ['1'],
      related: ['1'],
    });
    expect(client.calls[2].body.startImmediately).toBeUndefined();
    expect(task.status).toBe('pending');
  });

  it('refuses to accept a caller-chosen task id', () => {
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client: createFakeClient() });

    expect(() => backend.createTask({ id: '42', subject: 'Pinned' })).toThrowError(
      expect.objectContaining({ code: 'TASK_ID_UNSUPPORTED' })
    );
  });

  it('sends initial status in the create request without a second transition', () => {
    const client = createFakeClient();
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });
    expect(backend.createTask({ subject: 'Done', requirements: ['FR-1'], status: 'completed' }).status).toBe('completed');
    expect(client.calls.find((call) => call.operation === 'createTask').body.status).toBe('completed');
    expect(client.calls.some((call) => call.operation === 'setTaskStatus')).toBe(false);
    expect(() => backend.createTask({ subject: 'Deleted', status: 'deleted' })).toThrowError(
      expect.objectContaining({ code: 'REGISTRY_FIELD_UNSUPPORTED' })
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

  it('persists execution metadata through the app patch API', () => {
    const client = createFakeClient([{ id: '7', displayId: '7', subject: 'S', status: 'pending' }]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    const updated = backend.updateTask('7', (task) => {
      task.comments = [{ id: 'c1', text: 'hello' }];
      return task;
    });
    expect(updated.comments).toEqual([{ id: 'c1', text: 'hello' }]);
    expect(client.calls.find((call) => call.operation === 'patchTask').patch).toEqual({
      comments: [{ id: 'c1', text: 'hello' }],
    });
  });
 
  it('forwards the status actor to the app', () => {
    const client = createFakeClient([{ id: '7', subject: 'S', status: 'pending' }]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });
    backend.setTaskStatus('7', 'in_progress', 'alice');
    expect(client.calls.find((call) => call.operation === 'setTaskStatus').body).toEqual({
      status: 'in_progress', expectedStatus: 'pending', actor: 'alice',
    });
  });

  it('forwards the owner-change actor to the app', () => {
    const client = createFakeClient([{ id: '7', subject: 'S', status: 'pending', owner: 'alice' }]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });
    backend.setTaskOwner('7', 'bob', 'lead');
    expect(client.calls.find((call) => call.operation === 'patchTask').patch).toEqual({
      owner: 'bob', actor: 'lead',
    });
  });

  it('unassigns an owner and allows a new owner to be assigned', () => {
    const client = createFakeClient([
      { id: '7', displayId: '7', subject: 'S', status: 'pending', owner: 'alice' },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    expect(backend.setTaskOwner('7', null).owner).toBeUndefined();
    expect(client.calls.find((call) => call.operation === 'patchTask').patch).toEqual({ owner: null });
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

  it('requires a creation command for reconciliation', () => {
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client: createFakeClient() });

    expect(() => backend.reconcileTaskCreation({ id: '1' })).toThrow(
      'Task creation reconciliation requires creationCommand'
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
