const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createController } = require('../src/index.js');
const runtimeHelpers = require('../src/internal/runtimeHelpers.js');

describe('recoverable status transitions that clear a board card', () => {
  let root, teamDir, controller, api;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-transition-test-'));
    teamDir = path.join(root, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'config.json'), JSON.stringify({
      name: 'fixture',
      members: [{ name: 'lead', role: 'team-lead' }, { name: 'worker', role: 'developer' }],
    }));
    controller = createController({ teamName: 'fixture', claudeDir: root });
    api = controller.taskBoard;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    const parent = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(parent, target);
    if (!relative.startsWith('status-transition-test-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  function setup(action) {
    const task = api.createTask({ subject: 'Target', owner: 'worker' });
    const sibling = api.createTask({ subject: 'Sibling', owner: 'worker' });
    api.completeTask(task.id, 'worker');
    api.completeTask(sibling.id, 'worker');
    api.addReviewer('lead');
    api.requestReview(sibling.id, { from: 'worker', reviewer: 'lead' });
    if (action !== 'clear') api.requestReview(task.id, { from: 'worker', reviewer: 'lead' });
    if (action === 'restore') api.softDeleteTask(task.id, 'worker');
    const boardPath = path.join(teamDir, 'kanban-state.json');
    const board = JSON.parse(fs.readFileSync(boardPath, 'utf8'));
    if (action === 'restore') board.tasks[task.id] = { column: 'review', movedAt: new Date().toISOString() };
    board.columnOrder = { review: [task.id, sibling.id] };
    fs.writeFileSync(boardPath, JSON.stringify(board, null, 2));
    const taskPath = path.join(root, 'tasks', 'fixture', `${task.id}.json`);
    const siblingPath = path.join(root, 'tasks', 'fixture', `${sibling.id}.json`);
    const mutate = () => {
      if (action === 'start') return api.startTask(task.id, 'worker');
      if (action === 'delete') return api.softDeleteTask(task.id, 'worker');
      if (action === 'restore') return api.restoreTask(task.id, 'worker');
      if (action === 'set_in_progress') return api.setTaskStatus(task.id, 'in_progress', 'worker');
      if (action === 'set_pending') return api.setTaskStatus(task.id, 'pending', 'worker');
      if (action === 'set_deleted') return api.setTaskStatus(task.id, 'deleted', 'worker');
      if (action === 'request_changes') return api.requestChanges(task.id, { from: 'lead', comment: 'Fix this' });
      return api.clearKanban(task.id);
    };
    const targetStatus = ({ start: 'in_progress', delete: 'deleted', restore: 'pending',
      set_in_progress: 'in_progress', set_pending: 'pending', set_deleted: 'deleted',
      request_changes: 'pending', clear: 'completed' })[action];
    return { task, sibling, taskPath, siblingPath, boardPath, mutate, targetStatus };
  }

  const actions = ['start', 'delete', 'restore', 'set_in_progress', 'set_pending', 'set_deleted', 'request_changes', 'clear'];
  const failures = ['marker_before', 'marker_after', 'task_before', 'task_after', 'board_before', 'board_after', 'cleanup_before', 'cleanup_after'];
  it.each(actions.flatMap((action) => failures.map((failure) => [action, failure])))(
    '%s preserves recoverable evidence on %s EIO without an automatic repeat',
    (action, failure) => {
      const fixture = setup(action);
      const taskBefore = JSON.parse(fs.readFileSync(fixture.taskPath, 'utf8'));
      const boardBefore = fs.readFileSync(fixture.boardPath, 'utf8');
      const siblingBefore = fs.readFileSync(fixture.siblingPath, 'utf8');
      const inboxPath = path.join(teamDir, 'inboxes', 'worker.json');
      const inboxBefore = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : null;
      const rename = fs.renameSync;
      let taskWrites = 0;
      let injections = 0;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        const isTask = String(destination) === fixture.taskPath;
        const isBoard = String(destination) === fixture.boardPath;
        if (isTask) taskWrites += 1;
        const match = (failure.startsWith('marker') && isTask && taskWrites === 1) ||
          (failure.startsWith('task') && isTask && taskWrites === 2) ||
          (failure.startsWith('cleanup') && isTask && taskWrites === 3) ||
          (failure.startsWith('board') && isBoard);
        if (!match) return rename(source, destination);
        injections += 1;
        if (failure.endsWith('_after')) rename(source, destination);
        throw Object.assign(new Error(`injected ${failure} EIO`), { code: 'EIO' });
      });
      try {
        expect(fixture.mutate).toThrow(/KANBAN_TRANSITION_UNCERTAIN.*Task status transition/);
      } finally {
        spy.mockRestore();
      }
      expect(injections).toBe(1);
      expect(fs.readFileSync(fixture.siblingPath, 'utf8')).toBe(siblingBefore);
      expect(fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : null).toBe(inboxBefore);
      const taskAfterFailure = JSON.parse(fs.readFileSync(fixture.taskPath, 'utf8'));
      if (failure === 'marker_before') {
        expect(taskAfterFailure).toEqual(taskBefore);
        expect(fs.readFileSync(fixture.boardPath, 'utf8')).toBe(boardBefore);
        expect(() => controller.kanban.inspectPendingTransition(fixture.task.id)).toThrow(/No pending/);
        return;
      }
      if (failure === 'cleanup_after') {
        expect(taskAfterFailure.pendingKanbanTransition).toBeUndefined();
        expect(taskAfterFailure.status).toBe(fixture.targetStatus);
        expect(api.getKanbanState().tasks[fixture.task.id]).toBeUndefined();
        return;
      }
      const checked = controller.kanban.inspectPendingTransition(fixture.task.id);
      const expectedMode = ['marker_after', 'task_before'].includes(failure) ? 'cancel'
        : ['task_after', 'board_before'].includes(failure) ? 'publish' : 'clear';
      expect(checked).toMatchObject({ column: 'none', targetStatus: fixture.targetStatus, mode: expectedMode });
      controller.kanban.resolvePendingTransition(
        fixture.task.id, checked.transitionId, checked.snapshotHash, checked.mode, checked.contextHash
      );
      const recovered = JSON.parse(fs.readFileSync(fixture.taskPath, 'utf8'));
      expect(recovered.pendingKanbanTransition).toBeUndefined();
      expect(fs.readFileSync(fixture.siblingPath, 'utf8')).toBe(siblingBefore);
      expect(fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : null).toBe(inboxBefore);
      if (expectedMode === 'cancel') {
        expect(recovered).toEqual(taskBefore);
        expect(fs.readFileSync(fixture.boardPath, 'utf8')).toBe(boardBefore);
      } else {
        expect(recovered.status).toBe(fixture.targetStatus);
        const board = api.getKanbanState();
        expect(board.tasks[fixture.task.id]).toBeUndefined();
        expect(board.tasks[fixture.sibling.id].column).toBe('review');
        expect(board.columnOrder?.review || []).toContain(fixture.sibling.id);
        expect(board.columnOrder?.review || []).not.toContain(fixture.task.id);
        if (action === 'request_changes') {
          expect(recovered.historyEvents.filter((event) => event.type === 'review_changes_requested')).toHaveLength(1);
          expect(recovered.comments.filter((comment) => comment.type === 'review_request' && comment.text === 'Fix this')).toHaveLength(1);
        }
      }
    }
  );

  it.each([2, 3])('handles board read EIO number %s at the correct transaction boundary', (failAt) => {
    const fixture = setup('start');
    const beforeTask = fs.readFileSync(fixture.taskPath, 'utf8');
    const beforeBoard = fs.readFileSync(fixture.boardPath, 'utf8');
    const read = fs.readFileSync;
    let reads = 0;
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((target, ...args) => {
      if (String(target) === fixture.boardPath && ++reads === failAt) {
        throw Object.assign(new Error('injected board read EIO'), { code: 'EIO' });
      }
      return read(target, ...args);
    });
    try {
      expect(fixture.mutate).toThrow(/board read EIO/);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readFileSync(fixture.boardPath, 'utf8')).toBe(beforeBoard);
    if (failAt === 2) {
      expect(fs.readFileSync(fixture.taskPath, 'utf8')).toBe(beforeTask);
    } else {
      const checked = controller.kanban.inspectPendingTransition(fixture.task.id);
      expect(checked).toMatchObject({ phase: 'applied', mode: 'publish' });
      controller.kanban.resolvePendingTransition(
        fixture.task.id, checked.transitionId, checked.snapshotHash, checked.mode, checked.contextHash
      );
      expect(api.getTask(fixture.task.id).status).toBe('in_progress');
    }
  });

  it('reads the notification session before changing the task when config read fails', () => {
    const fixture = setup('request_changes');
    const beforeTask = fs.readFileSync(fixture.taskPath, 'utf8');
    const beforeBoard = fs.readFileSync(fixture.boardPath, 'utf8');
    const inboxPath = path.join(teamDir, 'inboxes', 'worker.json');
    const beforeInbox = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : null;
    const read = fs.readFileSync;
    const resolveSession = runtimeHelpers.resolveCanonicalLeadSessionId;
    let resolvingSession = false;
    let injections = 0;
    const resolveSpy = vi.spyOn(runtimeHelpers, 'resolveCanonicalLeadSessionId')
      .mockImplementation((...args) => {
        resolvingSession = true;
        try {
          return resolveSession(...args);
        } finally {
          resolvingSession = false;
        }
      });
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((file, ...args) => {
      if (resolvingSession && String(file) === path.join(teamDir, 'config.json')) {
        injections += 1;
        throw Object.assign(new Error('injected session config EIO'), { code: 'EIO' });
      }
      return read(file, ...args);
    });
    try {
      expect(fixture.mutate).toThrow(/injected session config EIO/);
    } finally {
      readSpy.mockRestore();
      resolveSpy.mockRestore();
    }
    expect(injections).toBe(1);
    expect(fs.readFileSync(fixture.taskPath, 'utf8')).toBe(beforeTask);
    expect(fs.readFileSync(fixture.boardPath, 'utf8')).toBe(beforeBoard);
    expect(fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : null).toBe(beforeInbox);
  });

  it.each(['task', 'board', 'marker'])(
    'rejects stale or tampered %s evidence without modifying either file',
    (tamper) => {
      const fixture = setup('start');
      const rename = fs.renameSync;
      const spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (String(destination) === fixture.boardPath) {
          throw Object.assign(new Error('board write EIO'), { code: 'EIO' });
        }
        return rename(source, destination);
      });
      try {
        expect(fixture.mutate).toThrow(/KANBAN_TRANSITION_UNCERTAIN/);
      } finally {
        spy.mockRestore();
      }
      const checked = controller.kanban.inspectPendingTransition(fixture.task.id);
      expect(checked.mode).toBe('publish');
      if (tamper === 'board') {
        const board = JSON.parse(fs.readFileSync(fixture.boardPath, 'utf8'));
        board.columnOrder.review.reverse();
        fs.writeFileSync(fixture.boardPath, JSON.stringify(board, null, 2));
      } else {
        const task = JSON.parse(fs.readFileSync(fixture.taskPath, 'utf8'));
        if (tamper === 'task') task.workIntervals.push({ startedAt: '2026-01-01T00:00:00.000Z' });
        else task.pendingKanbanTransition.expectedBoardHash = '0'.repeat(64);
        fs.writeFileSync(fixture.taskPath, JSON.stringify(task, null, 2));
      }
      const beforeTask = fs.readFileSync(fixture.taskPath, 'utf8');
      const beforeBoard = fs.readFileSync(fixture.boardPath, 'utf8');
      expect(controller.kanban.inspectPendingTransition(fixture.task.id).mode).toBe('conflict');
      expect(() => controller.kanban.resolvePendingTransition(
        fixture.task.id, checked.transitionId, checked.snapshotHash, checked.mode, checked.contextHash
      )).toThrow(/changed since inspection/);
      expect(fs.readFileSync(fixture.taskPath, 'utf8')).toBe(beforeTask);
      expect(fs.readFileSync(fixture.boardPath, 'utf8')).toBe(beforeBoard);
    }
  );

  it('recovers a legacy board without a revision', () => {
    const fixture = setup('start');
    const board = JSON.parse(fs.readFileSync(fixture.boardPath, 'utf8'));
    delete board.revision;
    fs.writeFileSync(fixture.boardPath, JSON.stringify(board, null, 2));
    const rename = fs.renameSync;
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
      if (String(destination) === fixture.boardPath) throw Object.assign(new Error('board EIO'), { code: 'EIO' });
      return rename(source, destination);
    });
    try {
      expect(fixture.mutate).toThrow(/KANBAN_TRANSITION_UNCERTAIN/);
    } finally {
      spy.mockRestore();
    }
    const checked = controller.kanban.inspectPendingTransition(fixture.task.id);
    expect(checked.mode).toBe('publish');
    controller.kanban.resolvePendingTransition(
      fixture.task.id, checked.transitionId, checked.snapshotHash, checked.mode, checked.contextHash
    );
    expect(api.getTask(fixture.task.id).status).toBe('in_progress');
    expect(api.getKanbanState().tasks[fixture.sibling.id].column).toBe('review');
  });

  it.each(['before', 'after'])(
    'retains inspectable evidence when explicit board recovery reports EIO %s publication',
    (timing) => {
      const fixture = setup('start');
      const rename = fs.renameSync;
      let spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (String(destination) === fixture.boardPath) throw Object.assign(new Error('initial board EIO'), { code: 'EIO' });
        return rename(source, destination);
      });
      try {
        expect(fixture.mutate).toThrow(/KANBAN_TRANSITION_UNCERTAIN/);
      } finally {
        spy.mockRestore();
      }
      const checked = controller.kanban.inspectPendingTransition(fixture.task.id);
      expect(checked.mode).toBe('publish');
      let writes = 0;
      spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (String(destination) !== fixture.boardPath) return rename(source, destination);
        writes += 1;
        if (timing === 'after') rename(source, destination);
        throw Object.assign(new Error('recovery EIO'), { code: 'EIO' });
      });
      try {
        expect(() => controller.kanban.resolvePendingTransition(
          fixture.task.id, checked.transitionId, checked.snapshotHash, checked.mode, checked.contextHash
        )).toThrow('recovery EIO');
      } finally {
        spy.mockRestore();
      }
      expect(writes).toBe(1);
      expect(controller.kanban.inspectPendingTransition(fixture.task.id).mode)
        .toBe(timing === 'before' ? 'publish' : 'clear');
    }
  );

  it.each(['cancel', 'clear'].flatMap((mode) => ['before', 'after'].map((timing) => [mode, timing])))(
    'does not retry %s marker removal after EIO %s publication',
    (mode, timing) => {
      const fixture = setup('start');
      const rename = fs.renameSync;
      let taskWrites = 0;
      let spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (String(destination) === fixture.taskPath) taskWrites += 1;
        if ((mode === 'cancel' && String(destination) === fixture.taskPath && taskWrites === 1) ||
            (mode === 'clear' && String(destination) === fixture.boardPath)) {
          rename(source, destination);
          throw Object.assign(new Error('initial EIO'), { code: 'EIO' });
        }
        return rename(source, destination);
      });
      try {
        expect(fixture.mutate).toThrow(/KANBAN_TRANSITION_UNCERTAIN/);
      } finally {
        spy.mockRestore();
      }
      const checked = controller.kanban.inspectPendingTransition(fixture.task.id);
      expect(checked.mode).toBe(mode);
      let writes = 0;
      spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        if (String(destination) !== fixture.taskPath) return rename(source, destination);
        writes += 1;
        if (timing === 'after') rename(source, destination);
        throw Object.assign(new Error('marker removal EIO'), { code: 'EIO' });
      });
      try {
        expect(() => controller.kanban.resolvePendingTransition(
          fixture.task.id, checked.transitionId, checked.snapshotHash, checked.mode, checked.contextHash
        )).toThrow('marker removal EIO');
      } finally {
        spy.mockRestore();
      }
      expect(writes).toBe(1);
      if (timing === 'before') expect(controller.kanban.inspectPendingTransition(fixture.task.id).mode).toBe(mode);
      else expect(() => controller.kanban.inspectPendingTransition(fixture.task.id)).toThrow(/No pending/);
    }
  );
});
