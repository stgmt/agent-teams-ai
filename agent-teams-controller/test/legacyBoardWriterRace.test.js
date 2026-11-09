const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { createController } = require('../src/index.js');
const taskStore = require('../src/internal/taskStore.js');

describe('legacy Kanban writer during a review transition', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-board-race-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    const parent = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(parent, target);
    if (!relative.startsWith('legacy-board-race-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it('retains a legacy writer change observed after task commit and reports uncertainty', () => {
    const team = path.join(root, 'teams', 'fixture');
    fs.mkdirSync(team, { recursive: true });
    fs.writeFileSync(
      path.join(team, 'config.json'),
      JSON.stringify({
        name: 'fixture',
        members: [
          { name: 'alice', role: 'team-lead' },
          { name: 'bob', role: 'developer' },
        ],
      })
    );
    const board = createController({
      teamName: 'fixture',
      claudeDir: root,
      localTaskBoard: true,
    }).taskBoard;
    const first = board.createTask({ subject: 'transition', owner: 'bob' });
    const other = board.createTask({ subject: 'other', owner: 'bob' });
    board.completeTask(first.id, 'bob');
    board.completeTask(other.id, 'bob');
    board.addReviewer('alice');
    board.requestReview(other.id, { from: 'bob', reviewer: 'alice' });
    const boardPath = path.join(team, 'kanban-state.json');
    const update = taskStore.updateTask;
    let injected = false;
    vi.spyOn(taskStore, 'updateTask').mockImplementation((...args) => {
      const task = update(...args);
      if (!injected && task.pendingKanbanTransition) {
        injected = true;
        const code =
          "const fs=require('fs');const s=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));s.columnOrder={review:[process.argv[2]]};const tmp=process.argv[1]+'.legacy-test';fs.writeFileSync(tmp,JSON.stringify(s));fs.renameSync(tmp,process.argv[1]);";
        const child = spawnSync(process.execPath, ['-e', code, boardPath, other.id], {
          encoding: 'utf8',
        });
        expect(child.status, child.stderr).toBe(0);
      }
      return task;
    });
    expect(() => board.requestReview(first.id, { from: 'bob', reviewer: 'alice' })).toThrow(
      /KANBAN_TRANSITION_UNCERTAIN/
    );
    expect(injected).toBe(true);
    const actual = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    expect(actual.columnOrder).toEqual({ review: [other.id] });
    expect(actual.tasks[first.id]).toBeUndefined();
    expect(actual.tasks[other.id].column).toBe('review');
    const task = JSON.parse(
      fs.readFileSync(path.join(root, 'tasks', 'fixture', `${first.id}.json`), 'utf8')
    );
    expect(task.pendingKanbanTransition?.id).toBeTruthy();
  });
});
