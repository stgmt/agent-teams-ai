const taskStore = require('./taskStore.js');
const { withTeamBoardLock } = require('./boardLock.js');
const { findRecentDuplicateTask } = require('./taskCreationDeduplication.js');
const { isTaskOpen } = require('./taskLifecycle.js');
const { assertKnownTaskActor } = require('./taskOwnershipGuards.js');

function getOpenBlockers(context, task) {
  const blockers = [];
  const blockerIds = Array.isArray(task.blockedBy) ? task.blockedBy : [];
  for (const id of blockerIds) {
    try {
      const blocker = taskStore.readTask(context.paths, id, { includeDeleted: true });
      if (isTaskOpen(blocker)) {
        blockers.push(blocker);
      }
    } catch (error) {
      if (error.code !== 'TASK_NOT_FOUND') throw error;
    }
  }
  return blockers;
}

function hasOpenBlockers(context, task) {
  return getOpenBlockers(context, task).length > 0;
}

function assertDependenciesResolved(context, task, status) {
  const blockers = getOpenBlockers(context, task);
  if (blockers.length > 0) {
    const labels = blockers.map(
      (blocker) => `#${blocker.displayId || blocker.id} (${blocker.status})`
    );
    throw new Error(
      `Cannot set task #${task.displayId || task.id} to ${status}: unresolved dependencies ${labels.join(', ')}. ` +
        `Wait or work on another task, then retry once dependencies are resolved. Ask the lead if a dependency is incorrect.`
    );
  }
}

function assertTaskCreationCommandScope(context, input) {
  if (!input || !input.creationCommand) {
    return;
  }
  const scopeKey =
    typeof input.creationCommand.scopeKey === 'string' ? input.creationCommand.scopeKey.trim() : '';
  if (scopeKey !== context.teamName) {
    throw new Error('Task creation command conflict: scope does not match team');
  }
}

// Admission and persistence complete under the board lock before callers notify owners.
function createTaskCommand(context, input) {
  assertTaskCreationCommandScope(context, input);
  let taskInput = input;
  if (input && typeof input.owner === 'string' && input.owner.trim()) {
    taskInput = {
      ...input,
      owner: assertKnownTaskActor(context, input.owner, 'task owner'),
    };
  }
  return withTeamBoardLock(context.paths, () => {
    const duplicate = findRecentDuplicateTask(context, taskInput);
    if (duplicate) {
      return { task: duplicate, taskInput, deduplicated: true };
    }
    return { task: taskStore.createTask(context.paths, taskInput), taskInput, deduplicated: false };
  });
}

function reconcileTaskCreation(context, input) {
  assertTaskCreationCommandScope(context, input);
  return withTeamBoardLock(context.paths, () =>
    taskStore.reconcileTaskCreation(context.paths, input)
  );
}

module.exports = {
  assertDependenciesResolved,
  createTaskCommand,
  getOpenBlockers,
  hasOpenBlockers,
  reconcileTaskCreation,
};
