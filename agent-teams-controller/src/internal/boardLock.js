const path = require('path');

const { withFileLockSync } = require('./fileLock.js');
const { isReadOnlyTaskSnapshot } = require('./taskBackendSelection.js');

const reentrantLockStateByScope = new Map();

function getTeamBoardLockScope(paths) {
  return path.join(paths.teamDir, 'board-state');
}

function getTeamBoardLockContext(paths) {
  return reentrantLockStateByScope.get(getTeamBoardLockScope(paths))?.context;
}

function withTeamBoardLock(paths, fn) {
  const scope = getTeamBoardLockScope(paths);
  const currentState = reentrantLockStateByScope.get(scope);

  if (currentState) {
    currentState.depth += 1;
    try {
      return fn();
    } finally {
      currentState.depth -= 1;
    }
  }

  return withFileLockSync(scope, () => {
    reentrantLockStateByScope.set(scope, {
      context: new Map(),
      depth: 1,
    });
    try {
      return fn();
    } finally {
      reentrantLockStateByScope.delete(scope);
    }
  });
}

/**
 * Snapshot reads use detached task data and atomically replaced Kanban state.
 * They must not synchronously wait behind an app-main async lock holder.
 */
function withTeamBoardReadLock(paths, fn) {
  return isReadOnlyTaskSnapshot(paths) ? fn() : withTeamBoardLock(paths, fn);
}

module.exports = {
  getTeamBoardLockContext,
  getTeamBoardLockScope,
  withTeamBoardLock,
  withTeamBoardReadLock,
};
