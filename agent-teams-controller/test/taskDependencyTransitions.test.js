const { startControlServer } = require('./helpers/controlServer.js');
const { resetTaskBackendCache } = require('../src/internal/taskBackendSelection.js');
const { resetSyncControlRequestChannel } = require('../src/internal/syncControlRequest.js');

let registryServer;
let registryPreviousEnv;
const registryEnvKeys = ['AGENT_TEAMS_BOUND_CONTROL_URL', 'AGENT_TEAMS_BOUND_CONTEXT_JSON', 'AGENT_TEAMS_MCP_CLAUDE_DIR'];
beforeEach(async () => {
  registryPreviousEnv = Object.fromEntries(registryEnvKeys.map((key) => [key, process.env[key]]));
  registryServer = await startControlServer();
  process.env.AGENT_TEAMS_BOUND_CONTROL_URL = registryServer.url;
  process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = JSON.stringify({ appInstanceId: 'controller-consumer-test', dataRootFingerprint: 'controller-consumer-root', connectionGeneration: 1 });
  resetTaskBackendCache();
});
afterEach(async () => {
  resetTaskBackendCache();
  resetSyncControlRequestChannel();
  if (registryServer) await registryServer.stop();
  for (const key of registryEnvKeys) {
    if (registryPreviousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = registryPreviousEnv[key];
  }
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createController } = require('../src/index.js');

const transitions = [
  ['start', 'in_progress', (tasks, id) => tasks.startTask(id, 'bob')],
  ['complete', 'completed', (tasks, id) => tasks.completeTask(id, 'bob')],
  ['set in_progress', 'in_progress', (tasks, id) => tasks.setTaskStatus(id, 'in_progress', 'bob')],
  ['set completed', 'completed', (tasks, id) => tasks.setTaskStatus(id, 'completed', 'bob')],
];

describe('issue-618 dependency transitions', () => {
  let dir;
  let tasks;
  let sequence = 0;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue618-controller-'));
    process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = dir;
    fs.mkdirSync(path.join(dir, 'teams', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'teams', 'fixture', 'config.json'), JSON.stringify({
      name: 'fixture', members: [{ name: 'alice', role: 'team-lead' }, { name: 'bob', role: 'developer' }],
    }));
    tasks = createController({ teamName: 'fixture', claudeDir: dir }).taskBoard;
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const snapshot = () => ({
    tasks: tasks.listTasks({ includeDeleted: true }),
    files: Object.fromEntries(fs.readdirSync(dir, { recursive: true })
      .filter((file) => fs.statSync(path.join(dir, file)).isFile())
      .map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')])),
  });
  const create = (blockedBy = []) => tasks.createTask({ requirements: ['FR-1'], subject: `Fixture task ${++sequence}`, owner: 'bob', blockedBy });
  const inbox = (owner) => {
    const file = path.join(dir, 'teams', 'fixture', 'inboxes', `${owner}.json`);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  };
  const rewrite = async (task, patch) => {
    const response = await fetch(`${registryServer.url}/api/teams/fixture/tasks/${task.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
    });
    expect(response.ok).toBe(true);
  };

  describe.each(transitions)('%s', (_name, status, transition) => {
    it.each(['pending', 'in_progress'])('refuses %s blockers without changing registry tasks or fixture files', async (blockerStatus) => {
      const blocker = create();
      tasks.setTaskStatus(blocker.id, blockerStatus, 'bob');
      const dependent = create([blocker.id]);
      // Include kanban and already-inconsistent protected states in the snapshot.
      await rewrite(dependent, { status });
      fs.writeFileSync(path.join(dir, 'teams', 'fixture', 'kanban-state.json'), JSON.stringify({
        tasks: { [dependent.id]: { column: 'review' } }, columnOrder: { review: [dependent.id] },
      }));
      const before = snapshot();
      expect(() => transition(tasks, dependent.id)).toThrow(`to ${status}: unresolved dependencies #${blocker.displayId} (${blockerStatus})`);
      expect(snapshot()).toEqual(before);
    });

    it.each(['review', 'needsFix'])('keeps completed blockers in %s open', async (reviewState) => {
      const blocker = create();
      const dependent = create([blocker.id]);
      await rewrite(blocker, { status: 'completed', reviewState });
      const before = snapshot();
      expect(() => transition(tasks, dependent.id)).toThrow(/unresolved dependencies/);
      expect(snapshot()).toEqual(before);
    });


    it.each(['completed', 'deleted', 'missing', 'empty'])('allows %s dependencies', async (resolution) => {
      const blocker = create();
      const dependent = create(resolution === 'empty' ? [] : [blocker.id]);
      if (resolution === 'completed' || resolution === 'deleted') tasks.setTaskStatus(blocker.id, resolution, 'bob');
      if (resolution === 'missing') await rewrite(dependent, { blockedBy: ['999999'] });
      expect(transition(tasks, dependent.id).status).toBe(status);
    });

    it('lists only remaining open blockers', () => {
      const first = create();
      const second = create();
      const dependent = create([first.id, second.id]);
      tasks.completeTask(first.id, 'bob');
      const before = snapshot();
      let error;
      try { transition(tasks, dependent.id); } catch (caught) { error = caught; }
      expect(error.message).toContain(`#${second.displayId} (pending)`);
      expect(error.message).not.toContain(`#${first.displayId}`);
      expect(snapshot()).toEqual(before);
    });
  });

  it('wakes dependents again after approval and deduplicates approval retries', () => {
    const blocker = create();
    const dependent = create([blocker.id]);
    tasks.completeTask(blocker.id, 'bob');
    expect(tasks.getTask(dependent.id).comments).toHaveLength(1);
    tasks.requestReview(blocker.id, { from: 'bob', reviewer: 'alice' });
    expect(() => tasks.startTask(dependent.id, 'bob')).toThrow(/unresolved dependencies/);
    tasks.completeTask(blocker.id, 'bob');
    expect(tasks.getTask(dependent.id).comments).toHaveLength(1);
    const assignedDuringReview = create([blocker.id]);
    const beforeInbox = inbox('bob').length;
    tasks.approveReview(blocker.id, { from: 'alice' });
    expect(tasks.getTask(dependent.id).comments).toHaveLength(2);
    expect(tasks.getTask(assignedDuringReview.id).comments).toHaveLength(1);
    expect(inbox('bob').length).toBeGreaterThan(beforeInbox);
    const afterInbox = inbox('bob').length;
    tasks.approveReview(blocker.id, { from: 'alice' });
    expect(tasks.getTask(dependent.id).comments).toHaveLength(2);
    expect(inbox('bob')).toHaveLength(afterInbox);
    expect(tasks.startTask(dependent.id, 'bob').status).toBe('in_progress');
  });


  it('preserves administrative transitions, restore and owner checks', () => {
    const blocker = create();
    const dependent = create([blocker.id]);
    tasks = createController({ teamName: 'fixture', claudeDir: dir, allowUserMessageSender: false }).taskBoard;
    expect(() => tasks.startTask(dependent.id, 'alice')).toThrow(/owned/i);
    expect(() => tasks.completeTask(dependent.id, 'alice')).toThrow(/owned/i);
    expect(() => tasks.setTaskStatus(dependent.id, 'completed', 'alice')).toThrow(/owned/i);
    expect(tasks.setTaskStatus(dependent.id, 'pending', 'alice').status).toBe('pending');
    expect(tasks.setTaskStatus(dependent.id, 'deleted', 'alice').status).toBe('deleted');
    expect(() => tasks.startTask(dependent.id, 'bob')).toThrow(/deleted/);
    expect(tasks.restoreTask(dependent.id, 'alice').status).toBe('pending');
    expect(() => tasks.startTask(dependent.id, 'bob')).toThrow(/unresolved dependencies/);
  });

  it.each(['complete', 'set completed'])('%s preserves partial/final notices and retry deduplication', (method) => {
    const finish = method === 'complete' ? transitions[1][2] : transitions[3][2];
    const first = create();
    const second = create();
    const dependent = create([first.id, second.id]);
    tasks.startTask(first.id, 'bob');
    finish(tasks, first.id);
    const partial = tasks.getTask(dependent.id).comments;
    expect(partial).toHaveLength(1);
    expect(partial[0].text).toContain('Still waiting on:');
    expect(partial[0].text).not.toContain('task_start');
    tasks.startTask(second.id, 'bob');
    finish(tasks, second.id);
    const completed = tasks.getTask(second.id);
    finish(tasks, second.id);
    tasks.completeTask(second.id, 'bob');
    tasks.setTaskStatus(second.id, 'completed', 'bob');
    expect(tasks.getTask(second.id).historyEvents).toEqual(completed.historyEvents);
    expect(tasks.getTask(second.id).workIntervals).toEqual(completed.workIntervals);
    const comments = tasks.getTask(dependent.id).comments;
    expect(comments).toHaveLength(2);
    expect(comments[1].text).toContain('task_get');
    expect(comments[1].text).toContain('task_start');
    expect(inbox('bob').filter((row) => row.text.includes('Dependency resolved'))).toHaveLength(2);
    expect(inbox('alice').filter((row) => row.text.includes('Dependency resolved'))).toHaveLength(0);
    tasks.startTask(dependent.id, 'bob');
    finish(tasks, dependent.id);
    tasks.completeTask(dependent.id, 'bob');
    tasks.setTaskStatus(dependent.id, 'completed', 'bob');
    expect(inbox('alice').filter((row) => String(row.messageId).startsWith('board-complete:'))).toHaveLength(1);
    tasks.setTaskStatus(second.id, 'deleted', 'bob');
    expect(tasks.getTask(dependent.id).comments).toEqual(comments);
  });
});
