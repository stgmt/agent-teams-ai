const fs = require('fs');
const os = require('os');
const path = require('path');

const { startControlServer } = require('./helpers/controlServer.js');
const taskStore = require('../src/internal/taskStore.js');
const {
  resetTaskBackendCache,
  resolveTaskBackend,
} = require('../src/internal/taskBackendSelection.js');
const { resetSyncControlRequestChannel } = require('../src/internal/syncControlRequest.js');

const BINDING_ENV_KEYS = [
  'AGENT_TEAMS_BOUND_CONTROL_URL',
  'AGENT_TEAMS_BOUND_CONTEXT_JSON',
  'AGENT_TEAMS_MCP_CLAUDE_DIR',
];
const APP_CONTEXT = JSON.stringify({
  appInstanceId: 'app-1',
  dataRootFingerprint: 'root-1',
  connectionGeneration: 1,
});

describe('task backend selection', () => {
  const tempDirs = [];
  const servers = [];
  const previousEnv = {};

  beforeAll(() => {
    for (const key of BINDING_ENV_KEYS) previousEnv[key] = process.env[key];
  });

  afterAll(() => {
    for (const key of BINDING_ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  beforeEach(() => {
    for (const key of BINDING_ENV_KEYS) delete process.env[key];
    resetTaskBackendCache();
  });

  afterEach(async () => {
    resetTaskBackendCache();
    resetSyncControlRequestChannel();
    for (const key of BINDING_ENV_KEYS) delete process.env[key];
    for (const server of servers.splice(0)) {
      await server.stop();
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function makePaths(config) {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-backend-selection-'));
    tempDirs.push(rootDir);
    const paths = {
      teamDir: path.join(rootDir, 'teams', 'team-a'),
      tasksDir: path.join(rootDir, 'tasks', 'team-a'),
    };
    fs.mkdirSync(paths.teamDir, { recursive: true });
    fs.mkdirSync(paths.tasksDir, { recursive: true });
    if (config !== undefined) {
      fs.writeFileSync(path.join(paths.teamDir, 'config.json'), JSON.stringify(config));
    }
    return paths;
  }

  function bindTo(url, claudeDir) {
    process.env.AGENT_TEAMS_BOUND_CONTROL_URL = url;
    process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = APP_CONTEXT;
    process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = claudeDir;
  }

  async function startServer(options) {
    const server = await startControlServer(options);
    servers.push(server);
    return server;
  }

  it('keeps the file store when the child is not bound to an app', () => {
    const paths = makePaths({ specProject: 'stgmt/spec', specSlug: 'spec' });

    expect(resolveTaskBackend(paths)).toBeNull();
    const created = taskStore.createTask(paths, { subject: 'File task' });
    expect(taskStore.readTask(paths, created.id).subject).toBe('File task');
    expect(fs.readdirSync(paths.tasksDir)).toHaveLength(1);
  });

  it('keeps the file store for a bound child whose team has no spec binding', async () => {
    const server = await startServer({ initialTasks: [] });
    const paths = makePaths({ name: 'team-a' });
    bindTo(server.url, paths.teamDir);

    expect(resolveTaskBackend(paths)).toBeNull();
    const created = taskStore.createTask(paths, { subject: 'Local only' });
    expect(taskStore.listTasks(paths).map((task) => task.id)).toEqual([created.id]);
    expect(await server.requests()).toHaveLength(0);
  });

  it('reads and writes a spec-bound team through the control API', async () => {
    const server = await startServer({
      initialTasks: [
        { id: '7', displayId: '7', subject: 'Registry task', status: 'pending', owner: 'alice' },
      ],
    });
    const paths = makePaths({ specProject: 'stgmt/spec', specSlug: 'spec' });
    bindTo(server.url, paths.teamDir);

    const backend = resolveTaskBackend(paths);
    expect(backend).toMatchObject({ kind: 'registry', specProject: 'stgmt/spec' });

    expect(taskStore.listTasks(paths).map((task) => task.id)).toEqual(['7']);
    expect(taskStore.listTaskRows(paths)).toEqual({
      tasks: [expect.objectContaining({ id: '7', subject: 'Registry task' })],
      anomalies: [],
    });
    expect(taskStore.readTask(paths, '#7').subject).toBe('Registry task');
    expect(taskStore.setTaskStatus(paths, '7', 'in_progress').status).toBe('in_progress');
    expect(taskStore.setTaskOwner(paths, '7', 'bob').owner).toBe('bob');

    const created = taskStore.createTask(paths, {
      subject: 'Registry create',
      requirements: ['FR-1'],
    });
    expect(created).toMatchObject({ subject: 'Registry create', status: 'pending' });

    expect(fs.readdirSync(paths.tasksDir)).toEqual([]);

    const requests = await server.requests();
    expect(requests.map((entry) => `${entry.method} ${entry.pathname}`)).toEqual(
      expect.arrayContaining([
        'GET /api/teams/team-a/tasks',
        'POST /api/teams/team-a/tasks',
        'POST /api/teams/team-a/tasks/7/status',
        'PATCH /api/teams/team-a/tasks/7',
      ])
    );
  });

  it('pins the choice for the life of the process until the cache is reset', async () => {
    const server = await startServer({ initialTasks: [] });
    const paths = makePaths({ specProject: 'stgmt/spec', specSlug: 'spec' });

    expect(resolveTaskBackend(paths)).toBeNull();
    bindTo(server.url, paths.teamDir);
    expect(resolveTaskBackend(paths)).toBeNull();

    resetTaskBackendCache();
    expect(resolveTaskBackend(paths)).toMatchObject({ kind: 'registry' });
  });

  it('fails closed when the binding itself is malformed instead of using files', async () => {
    const paths = makePaths({ specProject: 'stgmt/spec', specSlug: 'spec' });
    process.env.AGENT_TEAMS_BOUND_CONTROL_URL = 'http://127.0.0.1:1';
    process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = JSON.stringify({ appInstanceId: 'app-1' });
    process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = paths.teamDir;

    expect(() => resolveTaskBackend(paths)).toThrowError(
      expect.objectContaining({ code: 'APP_CONTEXT_MISMATCH' })
    );
  });

  it('rejects creation reconciliation for a registry-backed team', async () => {
    const server = await startServer({ initialTasks: [] });
    const paths = makePaths({ specProject: 'stgmt/spec', specSlug: 'spec' });
    bindTo(server.url, paths.teamDir);

    expect(() =>
      taskStore.reconcileTaskCreation(paths, {
        id: '1',
        creationCommand: { commandId: '1' },
      })
    ).toThrowError(expect.objectContaining({ code: 'REGISTRY_OPERATION_UNSUPPORTED' }));
  });
});
