const fs = require('fs');
const os = require('os');
const path = require('path');
const { startControlServer } = require('./helpers/controlServer.js');
const taskStore = require('../src/internal/taskStore.js');
const { TaskBackendError } = require('../src/internal/taskBackendErrors.js');
const { resetTaskBackendCache, resolveTaskBackend } = require('../src/internal/taskBackendSelection.js');
const { createControllerContext } = require('../src/controller.js');
const { resetSyncControlRequestChannel } = require('../src/internal/syncControlRequest.js');

const ENV_KEYS = ['AGENT_TEAMS_BOUND_CONTROL_URL', 'AGENT_TEAMS_BOUND_CONTEXT_JSON', 'AGENT_TEAMS_MCP_CLAUDE_DIR'];
const APP_CONTEXT = JSON.stringify({ appInstanceId: 'app-1', dataRootFingerprint: 'root-1', connectionGeneration: 1 });

describe('registry-only canonical tasks', () => {
  const roots = [];
  const servers = [];
  const previousEnv = {};
  beforeAll(() => { for (const key of ENV_KEYS) previousEnv[key] = process.env[key]; });
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
    resetTaskBackendCache();
  });
  afterEach(async () => {
    resetTaskBackendCache();
    resetSyncControlRequestChannel();
    for (const server of servers.splice(0)) await server.stop();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
    for (const key of ENV_KEYS) delete process.env[key];
  });
  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  function makePaths(config) {
    const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-only-controller-'));
    roots.push(claudeDir);
    const paths = { claudeDir, teamDir: path.join(claudeDir, 'teams', 'team-a'), tasksDir: path.join(claudeDir, 'tasks', 'team-a') };
    fs.mkdirSync(paths.teamDir, { recursive: true });
    fs.mkdirSync(paths.tasksDir, { recursive: true });
    if (config !== undefined) fs.writeFileSync(path.join(paths.teamDir, 'config.json'), JSON.stringify(config));
    return paths;
  }
  async function bind(paths, options = {}) {
    const server = await startControlServer(options);
    servers.push(server);
    process.env.AGENT_TEAMS_BOUND_CONTROL_URL = server.url;
    process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = APP_CONTEXT;
    process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = paths.claudeDir;
    return server;
  }

  it('fails with a typed error for every unbound canonical operation', () => {
    const paths = makePaths({ specProject: 'stgmt/spec', specSlug: 'spec' });
    const legacyPath = path.join(paths.tasksDir, '7.json');
    const legacy = JSON.stringify({ id: '7', subject: 'Existing user task', status: 'pending' });
    fs.writeFileSync(legacyPath, legacy);
    const calls = [
      () => resolveTaskBackend(paths),
      () => taskStore.listTasks(paths),
      () => taskStore.listTaskRows(paths),
      () => taskStore.readTask(paths, '7'),
      () => taskStore.resolveTaskRef(paths, '7'),
      () => taskStore.createTask(paths, { subject: 'New', requirements: ['FR-1'] }),
      () => taskStore.reconcileTaskCreation(paths, {}),
      () => taskStore.updateTask(paths, '7', (task) => task),
      () => taskStore.updateTaskFields(paths, '7', { subject: 'New' }),
      () => taskStore.setTaskStatus(paths, '7', 'completed'),
      () => taskStore.setTaskOwner(paths, '7', 'bob'),
      () => taskStore.linkTask(paths, '7', '8', 'related'),
      () => taskStore.unlinkTask(paths, '7', '8', 'related'),
    ];
    for (const call of calls) {
      expect(call).toThrowError(TaskBackendError);
      expect(call).toThrowError(expect.objectContaining({ code: 'APP_BINDING_REQUIRED' }));
    }
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacy);
    expect(fs.readdirSync(paths.tasksDir)).toEqual(['7.json']);
  });

  it.each([undefined, {}, { specSlug: 'spec' }, { specProject: 'project' }])(
    'never uses local config as an opt-in switch: %j', async (config) => {
      const paths = makePaths(config);
      const server = await bind(paths, { initialTasks: [{ id: '7', subject: 'Registry task', status: 'pending' }] });
      expect(resolveTaskBackend(paths).kind).toBe('registry');
      expect(taskStore.listTasks(paths).map((task) => task.id)).toEqual(['7']);
      expect((await server.requests())[0].headers['x-agent-teams-app-context']).toBe(APP_CONTEXT);
      expect(fs.readdirSync(paths.tasksDir)).toEqual([]);
    }
  );

  it('reads and writes through the bound app without touching existing canonical files', async () => {
    const paths = makePaths();
    const legacyPath = path.join(paths.tasksDir, '7.json');
    fs.writeFileSync(legacyPath, 'existing user data, not a registry task');
    const server = await bind(paths, { initialTasks: [{ id: '7', subject: 'Registry task', status: 'pending', owner: 'alice' }] });
    expect(taskStore.readTask(paths, '#7').subject).toBe('Registry task');
    expect(taskStore.listTaskRows(paths).anomalies).toEqual([]);
    expect(taskStore.setTaskStatus(paths, '7', 'in_progress').status).toBe('in_progress');
    expect(taskStore.setTaskOwner(paths, '7', 'bob').owner).toBe('bob');
    expect(taskStore.updateTaskFields(paths, '7', { subject: 'Updated' }).subject).toBe('Updated');
    const created = taskStore.createTask(paths, { subject: 'New', requirements: ['FR-1'] });
    expect(created.subject).toBe('New');
    expect(taskStore.linkTask(paths, created.id, '7', 'blocked-by').blockedBy).toEqual(['7']);
    expect(taskStore.unlinkTask(paths, created.id, '7', 'blocked-by').blockedBy).toEqual([]);
    expect(fs.readFileSync(legacyPath, 'utf8')).toBe('existing user data, not a registry task');
    expect(fs.readdirSync(paths.tasksDir)).toEqual(['7.json']);
    expect((await server.requests()).map((request) => request.method)).toEqual(expect.arrayContaining(['GET', 'POST', 'PATCH']));
  });

  it('surfaces registry unavailability instead of reading existing task files', async () => {
    const paths = makePaths();
    const legacyPath = path.join(paths.tasksDir, '1.json');
    fs.writeFileSync(legacyPath, JSON.stringify({ id: '1', subject: 'Legacy', status: 'pending' }));
    await bind(paths, { failStatus: 503 });
    expect(() => taskStore.listTasks(paths)).toThrowError(expect.objectContaining({ code: 'REGISTRY_UNAVAILABLE' }));
    expect(() => taskStore.createTask(paths, { subject: 'New', requirements: ['FR-1'] })).toThrowError(expect.objectContaining({ code: 'REGISTRY_UNAVAILABLE' }));
    expect(fs.readdirSync(paths.tasksDir)).toEqual(['1.json']);
  });

  it('revalidates the app binding rather than reusing a stale client', async () => {
    const paths = makePaths();
    await bind(paths);
    resolveTaskBackend(paths);
    process.env.AGENT_TEAMS_BOUND_CONTROL_URL = 'http://127.0.0.1:1';
    expect(() => resolveTaskBackend(paths)).toThrowError(
      expect.objectContaining({ code: 'APP_CONTEXT_MISMATCH' })
    );
    delete process.env.AGENT_TEAMS_BOUND_CONTROL_URL;
    delete process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON;
    expect(() => resolveTaskBackend(paths)).toThrowError(
      expect.objectContaining({ code: 'APP_BINDING_REQUIRED' })
    );
  });

  it('does not cache a missing binding as a usable backend', async () => {
    const paths = makePaths();
    expect(() => resolveTaskBackend(paths)).toThrowError(expect.objectContaining({ code: 'APP_BINDING_REQUIRED' }));
    await bind(paths);
    expect(resolveTaskBackend(paths).kind).toBe('registry');
  });

  it('uses an explicit read-only snapshot for isolated task reads without app binding', () => {
    const paths = makePaths();
    const liveTask = {
      id: '41',
      displayId: 'TASK-41',
      subject: 'Snapshot task',
      status: 'pending',
      comments: [{ id: 'comment-1', author: 'worker', text: 'source comment' }],
    };
    const snapshot = [
      liveTask,
      {
        id: '42',
        displayId: 'TASK-42',
        subject: 'Deleted snapshot task',
        status: 'deleted',
      },
    ];
    const context = createControllerContext({
      teamName: 'team-a',
      claudeDir: paths.claudeDir,
      readOnlyTaskSnapshot: snapshot,
    });

    liveTask.subject = 'caller mutation';
    liveTask.comments[0].text = 'caller mutation';
    expect(resolveTaskBackend(context.paths).kind).toBe('registry-snapshot');
    expect(taskStore.listTasks(context.paths).map((task) => task.id)).toEqual(['41']);
    expect(taskStore.listTasks(context.paths, { includeDeleted: true }).map((task) => task.id)).toEqual([
      '41',
      '42',
    ]);
    expect(taskStore.listTaskRows(context.paths).anomalies).toEqual([]);
    expect(taskStore.resolveTaskRef(context.paths, 'sandbox-spec:TASK-41')).toBe('41');
    expect(taskStore.readTask(context.paths, '#TASK-41')).toMatchObject({
      id: '41',
      subject: 'Snapshot task',
      comments: [{ text: 'source comment' }],
    });

    const listed = taskStore.listTaskRows(context.paths).tasks;
    listed[0].comments[0].text = 'result mutation';
    expect(taskStore.readTask(context.paths, '41').comments[0].text).toBe('source comment');
    expect(fs.readdirSync(paths.tasksDir)).toEqual([]);
  });

  it('rejects every canonical task mutation on an explicit snapshot', () => {
    const paths = makePaths();
    const context = createControllerContext({
      teamName: 'team-a',
      claudeDir: paths.claudeDir,
      readOnlyTaskSnapshot: [
        { id: '41', displayId: 'TASK-41', subject: 'Snapshot task', status: 'pending' },
        { id: '42', displayId: 'TASK-42', subject: 'Another task', status: 'pending' },
      ],
    });
    const writes = [
      () => taskStore.createTask(context.paths, { subject: 'New', requirements: ['FR-1'] }),
      () => taskStore.reconcileTaskCreation(context.paths, {}),
      () => taskStore.updateTask(context.paths, '41', (task) => ({ ...task, subject: 'changed' })),
      () => taskStore.updateTaskFields(context.paths, '41', { subject: 'changed' }),
      () => taskStore.setTaskStatus(context.paths, '41', 'completed'),
      () => taskStore.setTaskOwner(context.paths, '41', 'worker'),
      () => taskStore.linkTask(context.paths, '41', '42', 'related'),
      () => taskStore.unlinkTask(context.paths, '41', '42', 'related'),
      () => taskStore.addTaskComment(context.paths, '41', 'comment'),
      () => taskStore.setNeedsClarification(context.paths, '41', 'lead'),
      () => taskStore.addTaskAttachmentMeta(context.paths, '41', { id: 'attachment-1' }),
      () => taskStore.removeTaskAttachment(context.paths, '41', 'attachment-1'),
      () => taskStore.addCommentAttachmentMeta(
        context.paths,
        '41',
        'comment-1',
        { id: 'attachment-1' }
      ),
    ];

    for (const write of writes) {
      expect(write).toThrowError(
        expect.objectContaining({ code: 'READ_ONLY_TASK_SNAPSHOT' })
      );
    }
    expect(taskStore.readTask(context.paths, '41').subject).toBe('Snapshot task');
  });

  it('rejects malformed bindings and foreign team roots', async () => {
    const paths = makePaths();
    process.env.AGENT_TEAMS_BOUND_CONTROL_URL = 'http://127.0.0.1:1';
    process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = JSON.stringify({ appInstanceId: 'app-1' });
    process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = paths.claudeDir;
    expect(() => resolveTaskBackend(paths)).toThrowError(expect.objectContaining({ code: 'APP_CONTEXT_MISMATCH' }));
    await bind(paths);
    expect(() => resolveTaskBackend(makePaths())).toThrowError(expect.objectContaining({ code: 'APP_CONTEXT_MISMATCH' }));
    expect(() => resolveTaskBackend({})).toThrowError(expect.objectContaining({ code: 'APP_BINDING_REQUIRED' }));
  });
});
