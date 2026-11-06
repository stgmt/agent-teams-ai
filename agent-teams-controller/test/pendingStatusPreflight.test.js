const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createController } = require('../src/index.js');

describe('status changes with an unrelated uncertain review', () => {
  let root, teamDir, api, controller;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-status-test-'));
    teamDir = path.join(root, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'fixture',
        members: [
          { name: 'lead', role: 'team-lead' },
          { name: 'worker', role: 'developer' },
        ],
      })
    );
    controller = createController({ teamName: 'fixture', claudeDir: root });
    api = controller.taskBoard;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    const parent = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(parent, target);
    if (!relative.startsWith('pending-status-test-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  function snapshot() {
    const result = {};
    for (const directory of [path.join(root, 'tasks', 'fixture'), path.join(teamDir, 'inboxes')]) {
      if (!fs.existsSync(directory)) continue;
      for (const name of fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .sort()) {
        const file = path.join(directory, name);
        result[path.relative(root, file)] = fs.readFileSync(file, 'utf8');
      }
    }
    const board = path.join(teamDir, 'kanban-state.json');
    result.board = fs.existsSync(board) ? fs.readFileSync(board, 'utf8') : null;
    return result;
  }

  function createUncertainReview() {
    const pending = api.createTask({ subject: 'Review with uncertain outcome', owner: 'worker' });
    api.completeTask(pending.id, 'worker');
    api.addReviewer('lead');
    const write = fs.writeFileSync;
    const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, ...args) => {
      if (
        typeof target === 'string' &&
        path.dirname(target) === teamDir &&
        path.basename(target).startsWith('.tmp.')
      ) {
        throw Object.assign(new Error('board publication EIO'), { code: 'EIO' });
      }
      return write(target, ...args);
    });
    try {
      expect(() => api.requestReview(pending.id, { from: 'worker', reviewer: 'lead' })).toThrow(
        /unknown outcome/i
      );
    } finally {
      spy.mockRestore();
    }
    return pending;
  }

  it.each([
    ['startTask', 'pending', 'in_progress'],
    ['softDeleteTask', 'pending', 'deleted'],
    ['restoreTask', 'deleted', 'pending'],
    ['set in_progress', 'pending', 'in_progress'],
    ['set pending', 'in_progress', 'pending'],
    ['set deleted', 'pending', 'deleted'],
  ])(
    '%s does not change tasks, board, history or inbox before the pending review is resolved',
    (action, initial, expected) => {
      const candidate = api.createTask({ subject: 'Independent task', owner: 'worker' });
      const dependent = api.createTask({
        subject: 'Dependent task',
        owner: 'worker',
        'blocked-by': [candidate.id],
      });
      if (initial === 'deleted') api.softDeleteTask(candidate.id, 'worker');
      if (initial === 'in_progress') api.startTask(candidate.id, 'worker');
      const pending = createUncertainReview();
      const before = snapshot();
      const mutate = () => {
        if (action === 'startTask') return api.startTask(candidate.id, 'worker');
        if (action === 'softDeleteTask') return api.softDeleteTask(candidate.id, 'worker');
        if (action === 'restoreTask') return api.restoreTask(candidate.id, 'worker');
        return api.setTaskStatus(candidate.id, expected, 'worker');
      };
      expect(mutate).toThrow(/KANBAN_TRANSITION_UNCERTAIN/);
      expect(snapshot()).toEqual(before);
      const checked = controller.kanban.inspectPendingTransition(pending.id);
      expect(checked.mode).toBe('publish');
      controller.kanban.resolvePendingTransition(
        pending.id,
        checked.transitionId,
        checked.snapshotHash,
        checked.mode,
        checked.contextHash
      );
      expect(mutate().status).toBe(expected);
      const candidateAfter = api.getTask(candidate.id);
      expect(
        candidateAfter.historyEvents.filter(
          (event) => event.type === 'status_changed' && event.to === expected
        )
      ).toHaveLength(1);
      if (expected === 'deleted' || expected === 'completed') {
        expect(api.getTask(dependent.id).comments).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: `dep-resolved-${candidate.id}-${dependent.id}` }),
          ])
        );
      }
    }
  );

  it.each(['completeTask', 'set completed'])(
    '%s preserves the existing completion contract without a false board-complete message',
    (action) => {
      const candidate = api.createTask({ subject: 'Independent completion', owner: 'worker' });
      api.startTask(candidate.id, 'worker');
      createUncertainReview();
      const result =
        action === 'completeTask'
          ? api.completeTask(candidate.id, 'worker')
          : api.setTaskStatus(candidate.id, 'completed', 'worker');
      expect(result.status).toBe('completed');
      const inbox = path.join(teamDir, 'inboxes', 'lead.json');
      const rows = fs.existsSync(inbox) ? JSON.parse(fs.readFileSync(inbox, 'utf8')) : [];
      expect(rows.some((row) => String(row.messageId || '').startsWith('board-complete:'))).toBe(
        false
      );
    }
  );

  it.each(['startTask', 'softDeleteTask'])(
    '%s preserves a separate review card and its ordering until pending recovery succeeds',
    (action) => {
      const candidate = api.createTask({ subject: 'Already on board', owner: 'worker' });
      api.completeTask(candidate.id, 'worker');
      api.requestReview(candidate.id, { from: 'worker', reviewer: 'lead' });
      api.updateColumnOrder('review', [candidate.id]);
      const pending = createUncertainReview();
      const before = snapshot();
      const mutate = () => api[action](candidate.id, 'worker');
      expect(mutate).toThrow(/KANBAN_TRANSITION_UNCERTAIN/);
      expect(snapshot()).toEqual(before);
      const checked = controller.kanban.inspectPendingTransition(pending.id);
      controller.kanban.resolvePendingTransition(
        pending.id,
        checked.transitionId,
        checked.snapshotHash,
        checked.mode,
        checked.contextHash
      );
      expect(mutate().status).toBe(action === 'startTask' ? 'in_progress' : 'deleted');
      const board = api.getKanbanState();
      expect(board.tasks[candidate.id]).toBeUndefined();
      expect(board.columnOrder?.review || []).not.toContain(candidate.id);
      expect(board.tasks[pending.id].column).toBe('review');
    }
  );

  it.each(['startTask', 'softDeleteTask', 'restoreTask'])(
    '%s makes no changes if the board cannot be read',
    (action) => {
      const candidate = api.createTask({ subject: 'Board read failure', owner: 'worker' });
      if (action === 'restoreTask') api.softDeleteTask(candidate.id, 'worker');
      api.addReviewer('lead');
      const before = snapshot();
      const boardPath = path.join(teamDir, 'kanban-state.json');
      const read = fs.readFileSync;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...args) => {
        if (String(target) === boardPath)
          throw Object.assign(new Error('board read EIO'), { code: 'EIO' });
        return read(target, ...args);
      });
      try {
        expect(() => api[action](candidate.id, 'worker')).toThrow('board read EIO');
      } finally {
        spy.mockRestore();
      }
      expect(snapshot()).toEqual(before);
    }
  );
});
