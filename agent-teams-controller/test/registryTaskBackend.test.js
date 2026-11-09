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
    listTasks(scope) {
      calls.push({ operation: 'listTasks', ...(scope ? { scope: clone(scope) } : {}) });
      return tasks
        .filter(
          (task) =>
            !scope || (task.specProject === scope.project && task.specSlug === scope.spec)
        )
        .map(clone);
    },
    getTask(taskId, scope) {
      calls.push({ operation: 'getTask', taskId, ...(scope ? { scope: clone(scope) } : {}) });
      const task = tasks.find(
        (entry) =>
          String(entry.id) === String(taskId) &&
          (!scope || (entry.specProject === scope.project && entry.specSlug === scope.spec))
      );
      if (!task) throw Object.assign(new Error('Task not found'), { code: 'TASK_NOT_FOUND' });
      return clone(task);
    },
    createTaskWithOutcome(body) {
      calls.push({ operation: 'createTask', body: clone(body) });
      const task = {
        id: String(nextId),
        displayId: `#${nextId}`,
        subject: body.subject,
        status: body.status || (body.startImmediately ? 'in_progress' : 'pending'),
        ...(body.specProject ? { specProject: body.specProject } : {}),
        ...(body.specSlug ? { specSlug: body.specSlug } : {}),
        ...(body.requirements ? { requirements: body.requirements } : {}),
        ...(body.owner ? { owner: body.owner } : {}),
        ...(body.blockedBy ? { blockedBy: body.blockedBy } : {}),
        ...(body.related ? { related: body.related } : {}),
      };
      nextId += 1;
      tasks.push(task);
      return { task: clone(task), outcome: 'APPLIED' };
    },
    setTaskStatus(taskId, body, scope) {
      calls.push({
        operation: 'setTaskStatus',
        taskId,
        body: clone(body),
        ...(scope ? { scope: clone(scope) } : {}),
      });
      const task = find(taskId);
      if (!task) {
        throw Object.assign(new Error('Task not found'), { code: 'TASK_NOT_FOUND' });
      }
      task.status = body.status;
      return clone(task);
    },
    patchTask(taskId, patch, scope) {
      calls.push({
        operation: 'patchTask',
        taskId,
        patch: clone(patch),
        ...(scope ? { scope: clone(scope) } : {}),
      });
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
  it('persists artifact requirement and attachments together in the scoped task patch', () => {
    const scope = { project: 'project-a', spec: 'spec-a' };
    const client = createFakeClient([
      { id: '7', subject: 'Seven', status: 'pending', specProject: scope.project, specSlug: scope.spec },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });
    const artifactRequirement = {
      required: true,
      expectedFilename: 'result.txt',
      proof: { attachmentId: 'attachment-1', sha256: 'a'.repeat(64), size: 3 },
    };
    const attachments = [{ id: 'attachment-1', filename: 'result.txt', size: 3 }];
    const updated = backend.updateTask('7', (task) => {
      task.artifactRequirement = artifactRequirement;
      task.attachments = attachments;
      return task;
    }, scope);
    expect(client.calls.filter((call) => call.operation === 'patchTask')).toEqual([
      { operation: 'patchTask', taskId: '7', patch: { attachments, artifactRequirement }, scope },
    ]);
    expect(updated.artifactRequirement).toEqual(artifactRequirement);
    expect(updated.attachments).toEqual(attachments);
  });
  it('sends artifact bytes only to the app-bound patch and strips local paths', () => {
    const scope = { project: 'project-a', spec: 'spec-a' };
    const client = createFakeClient([
      {
        id: '7',
        subject: 'Seven',
        status: 'pending',
        specProject: scope.project,
        specSlug: scope.spec,
        artifactRequirement: { required: true, expectedFilename: 'proof.txt' },
      },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });
    const updated = backend.updateTaskArtifactFields(
      '7',
      {
        artifactRequired: true,
        artifactFile: {
          filename: 'proof.txt',
          base64Data: 'YWJj',
          filePath: '/untrusted/local/path',
        },
        attachments: [{ filePath: '/untrusted/local/path' }],
      },
      scope
    );

    expect(client.calls.filter((call) => call.operation === 'patchTask')).toEqual([
      {
        operation: 'patchTask',
        taskId: '7',
        patch: {
          artifactRequired: true,
          artifactFile: { filename: 'proof.txt', base64Data: 'YWJj' },
        },
        scope,
      },
    ]);
    const artifactPatch = client.calls.find((call) => call.operation === 'patchTask');
    expect(JSON.stringify(artifactPatch)).not.toContain('filePath');
    expect(updated.id).toBe('7');
  });

  it('reads app-owned artifact data by the verified attachment ID', () => {
    const attachmentId = 'artifact-1';
    const artifact = {
      filename: 'proof.txt',
      mimeType: 'text/plain',
      size: 3,
      sha256: 'a'.repeat(64),
      base64Data: 'YWJj',
    };
    const client = createFakeClient([
      {
        id: '7',
        subject: 'Seven',
        status: 'pending',
        artifactRequirement: {
          required: true,
          proof: { attachmentId, sha256: artifact.sha256, size: artifact.size },
        },
        attachments: [{ id: attachmentId, filename: 'proof.txt', size: 3 }],
      },
    ]);
    client.readTaskArtifactData = (taskId, requestedAttachmentId) => {
      client.calls.push({
        operation: 'readTaskArtifactData',
        taskId,
        attachmentId: requestedAttachmentId,
      });
      return artifact;
    };
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    expect(backend.readTaskArtifactData('7', attachmentId)).toEqual(artifact);
    expect(client.calls.at(-1)).toEqual({
      operation: 'readTaskArtifactData',
      taskId: '7',
      attachmentId,
    });
  });

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
  it('uses composite registry IDs and scope to disambiguate identical local task IDs', () => {
    const firstId = `registry-${'a'.repeat(64)}`;
    const secondId = `registry-${'b'.repeat(64)}`;
    const scope = { project: 'workspace', spec: 'alpha' };
    const client = createFakeClient([
      {
        id: firstId,
        displayId: 'aaaaaaaaaaaa',
        registryLocalId: 'TASK-1',
        specProject: 'workspace',
        specSlug: 'alpha',
        subject: 'Alpha task',
        status: 'pending',
        registryEntity: { id: 'TASK-1', comments: ['canonical detail'] },
        comments: [{ id: 'comment-a', text: 'execution detail' }],
        attachments: [{ id: 'attachment-a', filePath: '/tmp/a.txt' }],
      },
      {
        id: secondId,
        displayId: 'bbbbbbbbbbbb',
        registryLocalId: 'TASK-1',
        specProject: 'workspace',
        specSlug: 'beta',
        subject: 'Beta task',
        status: 'pending',
      },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    expect(backend.listTasks().map((task) => task.id)).toEqual([firstId, secondId]);
    expect(() => backend.readTask('TASK-1')).toThrowError(/Ambiguous task reference/);
    expect(backend.readTask(firstId).subject).toBe('Alpha task');
    expect(backend.readTask('TASK-1', { scope }).id).toBe(firstId);

    const full = backend.readTask(firstId, { full: true, scope });
    expect(full.registryEntity).toEqual({ id: 'TASK-1', comments: ['canonical detail'] });
    expect(full.comments).toEqual([{ id: 'comment-a', text: 'execution detail' }]);
    expect(full.attachments).toEqual([{ id: 'attachment-a', filePath: '/tmp/a.txt' }]);
    expect(client.calls.find((call) => call.operation === 'getTask')).toMatchObject({
      taskId: firstId,
      scope,
    });
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
  it('keeps a scoped shared-task create on its server-issued composite identity across replay', () => {
    const id = `registry-${'d'.repeat(64)}`;
    const scope = { project: 'workspace', spec: 'alpha' };
    const client = createFakeClient();
    let createCalls = 0;
    client.createTaskWithOutcome = (body) => {
      client.calls.push({ operation: 'createTask', body: clone(body) });
      createCalls += 1;
      const task = {
        id,
        displayId: 'dddddddddddd',
        registryLocalId: 'TASK-1',
        registryEntity: { id: 'TASK-1', requirements: ['FR-1'] },
        specProject: scope.project,
        specSlug: scope.spec,
        subject: body.subject,
        requirements: body.requirements,
        status: 'pending',
      };
      if (client.tasks.length === 0) client.tasks.push(task);
      return { task: clone(task), outcome: createCalls === 1 ? 'APPLIED' : 'REPLAY' };
    };
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });
    const input = {
      subject: 'Shared task',
      requirements: ['FR-1'],
      specProject: scope.project,
      specSlug: scope.spec,
      creationCommand: {
        namespace: 'test',
        scopeKey: 'team-a',
        operation: 'task.create',
        commandId: 'create-shared-task',
        payloadHash: 'payload-hash',
      },
    };

    const first = backend.createTask(input);
    const replay = backend.createTask(input);

    expect(first.id).toBe(id);
    expect(replay.id).toBe(id);
    expect(client.tasks).toHaveLength(1);
    expect(client.calls.filter((call) => call.operation === 'createTask')).toHaveLength(2);
    expect(client.calls.find((call) => call.operation === 'createTask').body).toMatchObject({
      specProject: scope.project,
      specSlug: scope.spec,
      requirements: ['FR-1'],
    });
    expect(client.calls.find((call) => call.operation === 'createTask').body).not.toHaveProperty(
      'teamId'
    );
    expect(replay.registryEntity).toEqual({ id: 'TASK-1', requirements: ['FR-1'] });
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

  it('forwards pending transition marker creation and clearing to the app patch API', () => {
    const transition = {
      id: 'transition-7',
      taskId: '7',
      kind: 'status',
      phase: 'prepared',
      column: 'none',
      operation: 'status',
      targetStatus: 'completed',
      beforeTaskHash: 'a'.repeat(64),
      expectedTaskHash: 'b'.repeat(64),
      beforeBoardHash: 'c'.repeat(64),
      expectedBoardHash: 'd'.repeat(64),
      beforeBoardToken: 'e'.repeat(64),
      targetBoard: { teamName: 'team-a', reviewers: [], tasks: {} },
      contextHash: 'f'.repeat(64),
    };
    const client = createFakeClient([{ id: '7', subject: 'S', status: 'pending' }]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    expect(
      backend.updateTask('7', (task) => ({ ...task, pendingKanbanTransition: transition }))
        .pendingKanbanTransition
    ).toEqual(transition);
    expect(
      backend.updateTask('7', (task) => {
        delete task.pendingKanbanTransition;
        return task;
      }).pendingKanbanTransition
    ).toBeNull();
    expect(
      client.calls
        .filter((call) => call.operation === 'patchTask')
        .map((call) => call.patch.pendingKanbanTransition)
    ).toEqual([transition, null]);
  });

  it('persists requirements and execution metadata through the scoped app patch API', () => {
    const scope = { project: 'workspace', spec: 'alpha' };
    const client = createFakeClient([
      {
        id: '7',
        displayId: '7',
        specProject: scope.project,
        specSlug: scope.spec,
        subject: 'S',
        status: 'pending',
      },
    ]);
    const backend = createRegistryTaskBackend({ teamName: 'team-a', client });

    const updated = backend.updateTask(
      '7',
      (task) => {
        task.requirements = ['FR-1', 'AC-2'];
        task.comments = [{ id: 'c1', text: 'hello' }];
        task.attachments = [{ id: 'a1', filePath: '/tmp/a.txt' }];
        return task;
      },
      scope
    );
    expect(updated.requirements).toEqual(['FR-1', 'AC-2']);
    expect(updated.comments).toEqual([{ id: 'c1', text: 'hello' }]);
    expect(updated.attachments).toEqual([{ id: 'a1', filePath: '/tmp/a.txt' }]);
    expect(client.calls.find((call) => call.operation === 'patchTask')).toMatchObject({
      patch: {
        requirements: ['FR-1', 'AC-2'],
        comments: [{ id: 'c1', text: 'hello' }],
        attachments: [{ id: 'a1', filePath: '/tmp/a.txt' }],
      },
      scope,
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
