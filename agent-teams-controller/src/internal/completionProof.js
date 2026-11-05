const { tryWithTeamBoardLock } = require('./boardLock.js');
const path = require('path');
const kanbanStore = require('./kanbanStore.js');
const taskStore = require('./taskStore.js');

// A busy or unreadable board must not disable duplicate-message protection.
function readConsistentCompletionTasks(paths) {
  const tasks = tryWithTeamBoardLock(paths, () => {
    kanbanStore.readKanbanState(paths, path.basename(paths.teamDir));
    const rows = taskStore.listTaskRows(paths);
    if (rows.anomalies.length) throw new Error('Cannot verify all tasks for message delivery');
    return rows.tasks;
  });
  if (tasks === null) {
    throw Object.assign(new Error('Board is busy; message was not sent because delivery could not be verified'), {
      code: 'BOARD_COMPLETION_UNAVAILABLE',
    });
  }
  return tasks;
}

module.exports = { readConsistentCompletionTasks };
