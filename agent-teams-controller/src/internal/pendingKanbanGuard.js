const { withTeamBoardLock } = require('./boardLock.js');
function assertNoPendingKanbanTransition(task, allowedId) {
  if (!Object.prototype.hasOwnProperty.call(task, 'pendingKanbanTransition')) return;
  const marker = task.pendingKanbanTransition;
  if (allowedId && marker && marker.id === allowedId) return;
  const transition = marker && marker.kind === 'status' ? 'Task status' : 'Review';
  throw Object.assign(
    new Error(
      `KANBAN_TRANSITION_UNCERTAIN: ${transition} transition for task ${task.id} has an unknown outcome; inspect the task and board before further changes.`
    ),
    { code: 'KANBAN_TRANSITION_UNCERTAIN', taskId: task.id }
  );
}

function assertReadableTaskRows(rows) {
  if (rows.anomalies.length > 0) {
    const taskIds = rows.anomalies.map((anomaly) => anomaly.taskId).join(', ');
    throw new Error(`Cannot verify task and board state; unreadable task files: ${taskIds}`);
  }
}

function assertNoPendingTransitions(paths, taskStore, allowedTaskId) {
  const rows = taskStore.listTaskRows(paths, { includeDeleted: true });
  assertReadableTaskRows(rows);
  for (const task of rows.tasks) {
    if (task.id !== allowedTaskId) assertNoPendingKanbanTransition(task);
  }
}

function assertTaskRefsWritable(paths, ids, readTask, ignoreMissing = false) {
  for (const id of new Set(ids)) {
    try {
      assertNoPendingKanbanTransition(readTask(paths, id, { includeDeleted: true }));
    } catch (error) {
      if (!ignoreMissing || error.code !== 'TASK_NOT_FOUND') throw error;
    }
  }
}

function readTaskConsistent(context, taskStore, _kanbanStore, taskId) {
  return withTeamBoardLock(context.paths, () => {
    const task = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
    assertNoPendingKanbanTransition(task);
    return task;
  });
}

function listTasksConsistent(context, taskStore, _kanbanStore) {
  return withTeamBoardLock(context.paths, () => {
    const rows = taskStore.listTaskRows(context.paths, { includeDeleted: true });
    assertReadableTaskRows(rows);
    rows.tasks.forEach((task) => assertNoPendingKanbanTransition(task));
    return rows.tasks;
  });
}

module.exports = {
  assertNoPendingKanbanTransition,
  assertNoPendingTransitions,
  assertTaskRefsWritable,
  readTaskConsistent,
  listTasksConsistent,
};
