const fs = require('fs');
const os = require('os');
const path = require('path');
const { startControlServer } = require('./helpers/controlServer.js');
const taskStore = require('../src/internal/taskStore.js');
const { resetTaskBackendCache } = require('../src/internal/taskBackendSelection.js');
const { resetSyncControlRequestChannel } = require('../src/internal/syncControlRequest.js');

// Filesystem scan counts, TTL/LRU snapshots, filename identities and atomic
// replacement belong to the removed file backend. Keep its consumer contracts
// here against the independent HTTP server instead of preserving that backend.
describe('taskStore registry consumer contracts', () => {
  const envKeys = ['AGENT_TEAMS_BOUND_CONTROL_URL', 'AGENT_TEAMS_BOUND_CONTEXT_JSON', 'AGENT_TEAMS_MCP_CLAUDE_DIR'];
  let previousEnv;
  let root;
  let paths;
  let server;

  beforeEach(async () => {
    previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-task-store-'));
    paths = { claudeDir: root, teamDir: path.join(root, 'teams', 'test-team'), tasksDir: path.join(root, 'tasks', 'test-team') };
    fs.mkdirSync(paths.teamDir, { recursive: true });
    server = await startControlServer();
    process.env.AGENT_TEAMS_BOUND_CONTROL_URL = server.url;
    process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = JSON.stringify({ appInstanceId: 'task-store-test', dataRootFingerprint: 'task-store-root', connectionGeneration: 1 });
    process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = root;
    resetTaskBackendCache();
  });

  afterEach(async () => {
    resetTaskBackendCache();
    resetSyncControlRequestChannel();
    if (server) await server.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    for (const key of envKeys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  const create = (fields = {}) => taskStore.createTask(paths, { subject: 'Registry work', requirements: ['FR-1'], ...fields });

  it('persists group association, preserves omitted edits and deletes explicit unlink', () => {
    const groupChatId = '00000000-0000-4000-8000-000000000001';
    const task = create({ groupChatId });
    expect(taskStore.readTask(paths, task.id).groupChatId).toBe(groupChatId);
    taskStore.updateTaskFields(paths, task.id, { description: 'Updated independently' });
    expect(taskStore.readTask(paths, task.id).groupChatId).toBe(groupChatId);
    const before = taskStore.readTask(paths, task.id);
    expect(() => taskStore.updateTaskFields(paths, task.id, { subject: 'Must not persist', groupChatId: 'invalid' })).toThrow('Invalid task groupChatId');
    expect(taskStore.readTask(paths, task.id)).toEqual(before);
    taskStore.updateTaskFields(paths, task.id, { groupChatId: null });
    expect(taskStore.readTask(paths, task.id)).not.toHaveProperty('groupChatId');
    expect(taskStore.readTask(paths, task.id).description).toBe('Updated independently');
    const unassociated = create({ subject: 'Unassociated task' });
    expect(taskStore.readTask(paths, unassociated.id)).not.toHaveProperty('groupChatId');
    expect(() => create({ subject: 'Invalid', groupChatId: null })).toThrow('Invalid task groupChatId');
  });

  it('isolates returned nested task data and observes later writes', () => {
    const task = create();
    taskStore.addTaskComment(paths, task.id, 'Original comment', { id: 'comment-1', author: 'alice' });
    const returned = taskStore.readTask(paths, task.id);
    returned.comments[0].text = 'Poisoned nested field';
    const listed = taskStore.listTaskRows(paths);
    listed.tasks[0].comments[0].text = 'Poisoned list result';
    expect(taskStore.readTask(paths, task.id).comments[0].text).toBe('Original comment');
    taskStore.updateTaskFields(paths, task.id, { description: 'Fresh after write' });
    expect(taskStore.readTask(paths, task.id)).toMatchObject({ id: task.id, description: 'Fresh after write', comments: [{ text: 'Original comment' }] });
  });

  it('resolves numeric display references and preserves deleted filtering', () => {
    const first = create({ subject: 'First' });
    const second = create({ subject: 'Second' });
    const deleted = create({ subject: 'Deleted' });
    taskStore.setTaskStatus(paths, deleted.id, 'deleted');
    expect(taskStore.resolveTaskRef(paths, `#${first.id}`)).toBe(first.id);
    expect(() => taskStore.readTask(paths, deleted.id)).toThrow(`Task not found: ${deleted.id}`);
    expect(taskStore.readTask(paths, deleted.id, { includeDeleted: true }).id).toBe(deleted.id);
    expect(taskStore.listTasks(paths).map((task) => task.id)).toEqual([first.id, second.id]);
  });
});
