function assertNoPendingKanbanTransition(task, allowedId) {
  if (task.pendingKanbanTransition && task.pendingKanbanTransition.id !== allowedId) {
    throw Object.assign(
      new Error(
        `KANBAN_TRANSITION_UNCERTAIN: Review transition for task ${task.id} has an unknown outcome; inspect the task and board before further changes.`
      ),
      { code: 'KANBAN_TRANSITION_UNCERTAIN', taskId: task.id }
    );
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

function readTaskConsistent(context, taskStore, kanbanStore, taskId) {
  return withTeamBoardLock(context.paths, () => {
    const task = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
    if (task.pendingKanbanTransition) kanbanStore.readKanbanState(context.paths, context.teamName);
    return task;
  });
}

function listTasksConsistent(context, taskStore, kanbanStore) {
  return withTeamBoardLock(context.paths, () => {
    kanbanStore.readKanbanState(context.paths, context.teamName);
    const tasks = taskStore.listTasks(context.paths);
    return tasks;
  });
}

module.exports = {
  assertNoPendingKanbanTransition,
  assertTaskRefsWritable,
  readTaskConsistent,
  listTasksConsistent,
};
const { withTeamBoardLock } = require('./boardLock.js');
