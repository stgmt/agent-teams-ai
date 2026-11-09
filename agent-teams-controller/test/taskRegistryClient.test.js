const { startControlServer } = require('./helpers/controlServer.js');
const {
  createRegistryTaskClient,
  createTeamSpecBindingClient,
} = require('../src/internal/taskRegistryClient.js');
const { resetSyncControlRequestChannel } = require('../src/internal/syncControlRequest.js');

const APP_CONTEXT = JSON.stringify({
  appInstanceId: 'app-1',
  dataRootFingerprint: 'fingerprint-1',
  connectionGeneration: 3,
});

describe('registry task client over a real control API', () => {
  const servers = [];

  afterEach(async () => {
    resetSyncControlRequestChannel();
    for (const server of servers.splice(0)) {
      await server.stop();
    }
  });

  async function startServer(options) {
    const server = await startControlServer(options);
    servers.push(server);
    return server;
  }

  function makeClient(server) {
    return createRegistryTaskClient({
      teamName: 'team a',
      baseUrl: server.url,
      headers: { 'x-agent-teams-app-context': APP_CONTEXT },
      timeoutMs: 5_000,
    });
  }

  it('lists tasks and forwards the app-context header on an encoded team path', async () => {
    const server = await startServer({
      initialTasks: [{ id: '7', displayId: '7', subject: 'Registry task', status: 'pending' }],
    });

    const tasks = makeClient(server).listTasks();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: '7', subject: 'Registry task', status: 'pending' });
    const requests = await server.requests();
    expect(requests[0]).toMatchObject({
      method: 'GET',
      pathname: '/api/teams/team%20a/tasks',
    });
    expect(requests[0].headers['x-agent-teams-app-context']).toBe(APP_CONTEXT);
  });

  it('uses an app-issued runtime capability instead of a caller-selected team path', () => {
    const requests = [];
    const existingBindings = [{ project: 'sandbox/project', spec: 'sandbox-spec' }];
    const client = createTeamSpecBindingClient({
      baseUrl: 'http://127.0.0.1:3000',
      headers: { 'x-agent-teams-app-context': APP_CONTEXT, Authorization: 'Bearer forged' },
      scopeCredential: 'app-issued-runtime-capability',
      request(request) {
        requests.push(request);
        const bindings =
          request.method === 'PUT' ? [JSON.parse(request.body)] : existingBindings;
        return { status: 200, ok: true, body: JSON.stringify({ bindings }) };
      },
    });

    expect(client.listTeamSpecBindings()).toEqual(existingBindings);
    expect(() =>
      client.linkTeamSpec({
        project: 'sandbox/linked',
        spec: 'shared-work',
        teamId: 'untrusted',
      })
    ).toThrow('Spec binding accepts only project and spec');
    expect(client.linkTeamSpec({ project: 'sandbox/linked', spec: 'shared-work' })).toEqual([
      { project: 'sandbox/linked', spec: 'shared-work' },
    ]);
    for (const request of requests) {
      expect(request.url).toBe('http://127.0.0.1:3000/api/team-runtime/spec-bindings');
      expect(request.headers.authorization).toBe('Bearer app-issued-runtime-capability');
      expect(request.headers['x-agent-teams-app-context']).toBe(APP_CONTEXT);
    }
    expect(JSON.parse(requests[1].body)).toEqual({
      project: 'sandbox/linked',
      spec: 'shared-work',
    });
    expect(JSON.parse(requests[1].body)).not.toHaveProperty('teamId');
  });

  it('requires an app-issued capability and preserves registry authorization failures', () => {
    expect(() =>
      createTeamSpecBindingClient({
        baseUrl: 'http://127.0.0.1:3000',
      })
    ).toThrow('AGENT_TEAMS_MCP_SCOPE_CREDENTIAL');

    const client = createTeamSpecBindingClient({
      baseUrl: 'http://127.0.0.1:3000',
      scopeCredential: 'app-issued-runtime-capability',
      request: () => ({
        status: 400,
        ok: false,
        body: JSON.stringify({
          code: 'PROJECT_NOT_ALLOWED',
          message: 'Project is not authorized for this registry tenant.',
        }),
      }),
    });

    expect(() =>
      client.linkTeamSpec({ project: 'forbidden/project', spec: 'sandbox-spec' })
    ).toThrow('Project is not authorized for this registry tenant.');
  });
  it('forwards exact project/spec selectors for every operation without inventing team identity', () => {
    const requests = [];
    const taskId = `registry-${'c'.repeat(64)}`;
    const task = {
      id: taskId,
      displayId: 'cccccccccccc',
      subject: 'Shared task',
      status: 'pending',
      registryEntity: { id: 'TASK-1', comments: ['full canonical details'] },
      comments: [
        {
          id: 'comment-1',
          text: 'Complete execution details',
          attachments: [{ id: 'comment-file-1', filename: 'comment.txt', filePath: '/data/comment.txt' }],
        },
      ],
      attachments: [{ id: 'task-file-1', filename: 'task.txt', filePath: '/data/task.txt' }],
    };
    const client = createRegistryTaskClient({
      teamName: 'team-a',
      baseUrl: 'http://127.0.0.1:3000',
      request(request) {
        requests.push(request);
        const payload =
          request.method === 'GET' && new URL(request.url).pathname.endsWith('/tasks')
            ? { tasks: [task] }
            : { task, ...(request.method === 'POST' ? { outcome: 'APPLIED' } : {}) };
        return { status: 200, ok: true, body: JSON.stringify(payload) };
      },
    });
    const scope = { project: 'workspace/alpha', spec: 'auth-flow' };

    expect(client.listTasks(scope)).toEqual([task]);
    expect(client.getTask(taskId, scope)).toEqual(task);
    expect(client.patchTask(taskId, { requirements: ['FR-1'] }, scope)).toEqual(task);
    expect(
      client.setTaskStatus(taskId, { status: 'in_progress', expectedStatus: 'pending' }, scope)
    ).toEqual(task);
    expect(
      client.createTaskWithOutcome(
        { subject: 'Shared task', requirements: ['FR-1'] },
        scope
      )
    ).toEqual({ task, outcome: 'APPLIED' });

    for (const request of requests.slice(0, 4)) {
      const url = new URL(request.url);
      expect(url.searchParams.get('project')).toBe(scope.project);
      expect(url.searchParams.get('spec')).toBe(scope.spec);
    }
    expect(JSON.parse(requests[4].body)).toEqual({
      subject: 'Shared task',
      requirements: ['FR-1'],
      project: scope.project,
      spec: scope.spec,
    });
    expect(JSON.parse(requests[4].body)).not.toHaveProperty('specProject');
    expect(JSON.parse(requests[4].body)).not.toHaveProperty('specSlug');
    expect(JSON.parse(requests[4].body)).not.toHaveProperty('teamId');
  });

  it('maps internal controller spec fields onto the HTTP project/spec create contract', () => {
    const requests = [];
    const client = createRegistryTaskClient({
      teamName: 'team-a',
      baseUrl: 'http://127.0.0.1:3000',
      request(request) {
        requests.push(request);
        return {
          status: 201,
          ok: true,
          body: JSON.stringify({ task: { id: '1' }, outcome: 'APPLIED' }),
        };
      },
    });

    client.createTaskWithOutcome({
      subject: 'Shared task',
      requirements: ['FR-1'],
      specProject: 'workspace/alpha',
      specSlug: 'auth-flow',
    });

    expect(JSON.parse(requests[0].body)).toEqual({
      subject: 'Shared task',
      requirements: ['FR-1'],
      project: 'workspace/alpha',
      spec: 'auth-flow',
    });
  });

  it('creates a task and reports the registry receipt payload', async () => {
    const server = await startServer({ initialTasks: [] });
    const client = makeClient(server);

    const task = client.createTask({ subject: 'New task', requirements: ['FR-1'] });

    expect(task).toMatchObject({ id: '1', subject: 'New task', status: 'pending' });
    const requests = await server.requests();
    const createRequest = requests.find((entry) => entry.method === 'POST');
    expect(createRequest.body).toEqual({ subject: 'New task', requirements: ['FR-1'] });
  });

  it('preserves creation outcomes and returns the existing task on replay', async () => {
    const server = await startServer({ initialTasks: [] });
    const client = makeClient(server);
    const input = {
      subject: 'One intent',
      requirements: ['FR-1'],
      creationCommand: {
        namespace: 'test', scopeKey: 'team a', operation: 'task.create',
        commandId: 'request-1', payloadHash: 'hash-1',
      },
    };
    const first = client.createTaskWithOutcome(input);
    const replay = client.createTaskWithOutcome(input);
    expect(first.outcome).toBe('APPLIED');
    expect(replay.outcome).toBe('REPLAY');
    expect(replay.task.id).toBe(first.task.id);
    expect(client.listTasks()).toHaveLength(1);
  });

  it('maps a missing-requirements refusal to a typed error', async () => {
    const server = await startServer({ initialTasks: [] });

    expect(() => makeClient(server).createTask({ subject: 'No requirements', requirements: [] }))
      .toThrowError(
        expect.objectContaining({ code: 'REQUIREMENTS_REQUIRED', status: 400 })
      );
  });

  it('surfaces a status conflict with the live current status', async () => {
    const server = await startServer({
      initialTasks: [{ id: '7', displayId: '7', subject: 'Task', status: 'pending' }],
    });

    expect(() =>
      makeClient(server).setTaskStatus('7', { status: 'completed', expectedStatus: 'in_progress' })
    ).toThrowError(expect.objectContaining({ code: 'STATUS_CONFLICT', currentStatus: 'pending' }));
  });

  it('reports an unavailable control API as REGISTRY_UNAVAILABLE', async () => {
    const server = await startServer({ initialTasks: [], failStatus: 503 });

    expect(() => makeClient(server).listTasks()).toThrowError(
      expect.objectContaining({ code: 'REGISTRY_UNAVAILABLE', status: 503 })
    );
  });

  it('reports an unreachable control API as REGISTRY_UNAVAILABLE', async () => {
    const server = await startServer({ initialTasks: [] });
    const client = makeClient(server);
    await server.stop();
    servers.splice(servers.indexOf(server), 1);

    expect(() => client.listTasks()).toThrowError(
      expect.objectContaining({ code: 'REGISTRY_UNAVAILABLE' })
    );
  });

  it('reads artifact bytes by task and attachment IDs through the bound app API', () => {
    const requests = [];
    const artifact = {
      filename: 'proof.txt',
      mimeType: 'text/plain',
      size: 3,
      sha256: 'a'.repeat(64),
      base64Data: 'YWJj',
    };
    const client = createRegistryTaskClient({
      teamName: 'team-a',
      baseUrl: 'http://127.0.0.1:3000',
      headers: { 'x-agent-teams-app-context': APP_CONTEXT },
      request(request) {
        requests.push(request);
        return { status: 200, ok: true, body: JSON.stringify(artifact) };
      },
    });

    expect(client.readTaskArtifactData('7', 'artifact-1')).toEqual(artifact);
    expect(requests[0].method).toBe('GET');
    expect(new URL(requests[0].url).pathname).toBe(
      '/api/teams/team-a/tasks/7/artifact/artifact-1'
    );
    expect(new URL(requests[0].url).search).toBe('');
    expect(requests[0].body).toBeUndefined();
    expect(requests[0].headers['x-agent-teams-app-context']).toBe(APP_CONTEXT);
  });

  it('treats a missing app-owned artifact as not found without local fallback', () => {
    const client = createRegistryTaskClient({
      teamName: 'team-a',
      baseUrl: 'http://127.0.0.1:3000',
      request: () => ({
        status: 404,
        ok: false,
        body: JSON.stringify({ code: 'TASK_NOT_FOUND', error: 'Task artifact not found' }),
      }),
    });

    expect(client.readTaskArtifactData('7', 'artifact-1')).toBeNull();
  });

  it('refuses to invent a base URL when no binding or legacy env is present', () => {
    const previousBound = process.env.AGENT_TEAMS_BOUND_CONTROL_URL;
    const previousLegacy = process.env.CLAUDE_TEAM_CONTROL_URL;
    delete process.env.AGENT_TEAMS_BOUND_CONTROL_URL;
    delete process.env.CLAUDE_TEAM_CONTROL_URL;
    try {
      expect(() => createRegistryTaskClient({ teamName: 'team-a' })).toThrowError(
        expect.objectContaining({ code: 'APP_BINDING_REQUIRED' })
      );
    } finally {
      if (previousBound === undefined) delete process.env.AGENT_TEAMS_BOUND_CONTROL_URL;
      else process.env.AGENT_TEAMS_BOUND_CONTROL_URL = previousBound;
      if (previousLegacy === undefined) delete process.env.CLAUDE_TEAM_CONTROL_URL;
      else process.env.CLAUDE_TEAM_CONTROL_URL = previousLegacy;
    }
  });
});
