const { startControlServer } = require('./helpers/controlServer.js');
const {
  createRegistryTaskClient,
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
