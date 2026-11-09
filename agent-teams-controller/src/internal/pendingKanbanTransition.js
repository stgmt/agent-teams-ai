const crypto = require('crypto');
const taskStore = require('./taskStore.js');
const kanbanStore = require('./kanbanStore.js');
const taskArtifact = require('./taskArtifact.js');
const { withTeamBoardLock } = require('./boardLock.js');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function taskHash(task) {
  const snapshot = structuredClone(task);
  delete snapshot.pendingKanbanTransition;
  delete snapshot.updatedAt;
  delete snapshot.registryStatus;
  return hash(canonical(snapshot));
}

function boardHash(state) {
  return hash(canonical(state));
}

function boardTokenHash(token) {
  return hash(token);
}

function removeTaskFromColumnOrder(state, taskId) {
  if (!state.columnOrder || typeof state.columnOrder !== 'object') return;
  const cleaned = {};
  for (const [column, ids] of Object.entries(state.columnOrder)) {
    if (!Array.isArray(ids)) continue;
    const remaining = ids.filter((id) => String(id) !== String(taskId));
    if (remaining.length) cleaned[column] = remaining.map(String);
  }
  state.columnOrder = Object.keys(cleaned).length ? cleaned : undefined;
}

function targetBoardForTransition(before, taskId, column, transitionId, options = {}) {
  const state = structuredClone(before);
  state.revision = crypto.randomUUID();
  const hadColumnOrder = Boolean(state.columnOrder && Object.keys(state.columnOrder).length);
  removeTaskFromColumnOrder(state, taskId);
  if (column === 'none') {
    delete state.tasks[taskId];
    return state;
  }
  if (hadColumnOrder && !state.columnOrder) state.columnOrder = {};
  state.tasks[taskId] = {
    column,
    movedAt: new Date().toISOString(),
    ...(column === 'review' ? { reviewer: options.reviewer ?? null } : {}),
    transitionId,
  };
  if (state.columnOrder) {
    const ordered = Array.isArray(state.columnOrder[column]) ? state.columnOrder[column] : [];
    state.columnOrder[column] = ordered.map(String).filter((id) => id !== String(taskId)).concat(taskId);
  }
  return state;
}

function uncertainError(kind, taskId, cause) {
  const subject =
    kind === 'status'
      ? `Task status transition for task ${taskId} has an unknown outcome`
      : `Review transition for task ${taskId} may have completed with an unknown outcome`;
  const detail = cause instanceof Error ? cause.message : cause ? String(cause) : '';
  return Object.assign(
    new Error(
      `KANBAN_TRANSITION_UNCERTAIN: ${subject}; inspect the task and board before further changes.${detail ? ` Cause: ${detail}` : ''}`
    ),
    { code: 'KANBAN_TRANSITION_UNCERTAIN', taskId, cause }
  );
}

function assertNoPending(task) {
  if (task && Object.prototype.hasOwnProperty.call(task, 'pendingKanbanTransition')) {
    const marker = task.pendingKanbanTransition;
    throw uncertainError(marker && marker.kind === 'status' ? 'status' : 'review', task.id);
  }
}

function transitionContextHash(context, taskId, marker) {
  return hash(canonical({
    teamName: context.teamName,
    taskId,
    transitionId: marker.id,
    kind: marker.kind,
    column: marker.column,
    operation: marker.operation,
    targetStatus: marker.targetStatus,
  }));
}

function isValidPendingTransition(context, task, marker) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return false;
  const allowedKeys = new Set([
    'id',
    'taskId',
    'kind',
    'phase',
    'column',
    'operation',
    'targetStatus',
    'beforeTaskHash',
    'expectedTaskHash',
    'beforeBoardHash',
    'expectedBoardHash',
    'beforeBoardToken',
    'targetBoard',
    'contextHash',
    'verifyArtifact',
  ]);
  if (Object.keys(marker).some((key) => !allowedKeys.has(key))) return false;
  if (
    typeof marker.id !== 'string' ||
    !marker.id.trim() ||
    marker.taskId !== task.id ||
    !['status', 'review'].includes(marker.kind) ||
    !['prepared', 'applied'].includes(marker.phase) ||
    !['review', 'approved', 'none'].includes(marker.column) ||
    (marker.operation !== undefined &&
      !['status', 'request_changes', 'clear'].includes(marker.operation)) ||
    (marker.targetStatus !== undefined &&
      !['pending', 'in_progress', 'completed', 'deleted'].includes(marker.targetStatus)) ||
    (marker.verifyArtifact !== undefined && typeof marker.verifyArtifact !== 'boolean')
  ) {
    return false;
  }
  for (const field of [
    'beforeTaskHash',
    'expectedTaskHash',
    'beforeBoardHash',
    'expectedBoardHash',
    'beforeBoardToken',
    'contextHash',
  ]) {
    if (typeof marker[field] !== 'string' || !/^[a-f0-9]{64}$/.test(marker[field])) return false;
  }
  const targetBoard = marker.targetBoard;
  if (
    !targetBoard ||
    typeof targetBoard !== 'object' ||
    Array.isArray(targetBoard) ||
    targetBoard.teamName !== context.teamName ||
    !Array.isArray(targetBoard.reviewers) ||
    !targetBoard.tasks ||
    typeof targetBoard.tasks !== 'object' ||
    Array.isArray(targetBoard.tasks) ||
    boardHash(targetBoard) !== marker.expectedBoardHash
  ) {
    return false;
  }
  return marker.contextHash === transitionContextHash(context, task.id, marker);
}

function markerForTransition(context, task, targetTask, targetBoard, options, beforeBoard, id) {
  const marker = {
    id,
    taskId: task.id,
    kind: options.kind,
    phase: 'prepared',
    column: options.column,
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.targetStatus ? { targetStatus: options.targetStatus } : {}),
    beforeTaskHash: taskHash(task),
    expectedTaskHash: taskHash(targetTask),
    beforeBoardHash: boardHash(beforeBoard.state),
    expectedBoardHash: boardHash(targetBoard),
    beforeBoardToken: boardTokenHash(beforeBoard.token),
    targetBoard,
    ...(options.verifyArtifact ? { verifyArtifact: true } : {}),
  };
  marker.contextHash = transitionContextHash(context, task.id, marker);
  return marker;
}

function readBoard(paths, teamName) {
  return kanbanStore.readKanbanStateSnapshot(paths, teamName);
}

function assertSameBoard(before, current) {
  if (
    before.token !== current.token ||
    boardHash(before.state) !== boardHash(current.state)
  ) {
    throw Object.assign(new Error('Kanban changed during task transition'), {
      code: 'KANBAN_SNAPSHOT_CHANGED',
    });
  }
}

/** Caller must hold the team board lock for the entire transition. */
function hasBoardReference(state, taskId) {
  if (state.tasks && state.tasks[taskId]) return true;
  return Boolean(
    state.columnOrder &&
      Object.values(state.columnOrder).some(
        (ids) => Array.isArray(ids) && ids.some((id) => String(id) === String(taskId))
      )
  );
}

/** Caller must hold the team board lock for the entire transition. */
function runPendingTransition(context, task, targetTask, options = {}) {
  assertNoPending(task);
  const beforeBoard = readBoard(context.paths, context.teamName);
  if (options.onlyIfReferenced && !hasBoardReference(beforeBoard.state, task.id)) {
    return taskStore.updateTask(context.paths, task.id, () => targetTask, options.scope);
  }
  const recheckedBoard = readBoard(context.paths, context.teamName);
  assertSameBoard(beforeBoard, recheckedBoard);

  const transitionId = crypto.randomUUID();
  const targetBoard = targetBoardForTransition(
    beforeBoard.state,
    task.id,
    options.column,
    transitionId,
    options
  );
  const marker = markerForTransition(
    context,
    task,
    targetTask,
    targetBoard,
    options,
    beforeBoard,
    transitionId
  );

  try {
    taskStore.writePendingKanbanTransition(context.paths, task.id, marker, options.scope);
  } catch (error) {
    throw uncertainError(options.kind, task.id, error);
  }

  try {
    taskStore.updateTask(context.paths, task.id, (current) => {
      if (current.pendingKanbanTransition?.id !== transitionId) {
        throw new Error('Pending kanban transition marker changed before task publication');
      }
      return {
        ...targetTask,
        pendingKanbanTransition: { ...marker, phase: 'applied' },
      };
    }, options.scope);
  } catch (error) {
    if (options.kind === 'review') {
      try {
        const current = taskStore.readTask(context.paths, task.id, { includeDeleted: true, ...(options.scope ? { scope: options.scope } : {}) });
        if (
          current.pendingKanbanTransition?.id === transitionId &&
          current.pendingKanbanTransition.phase === 'prepared' &&
          taskHash(current) === marker.beforeTaskHash
        ) {
          taskStore.updateTask(context.paths, task.id, (latest) => {
            if (latest.pendingKanbanTransition?.id !== transitionId) return latest;
            const restored = { ...latest };
            delete restored.pendingKanbanTransition;
            return restored;
          }, options.scope, { preserveUpdatedAt: true });
          throw error;
        }
      } catch (cleanupError) {
        if (cleanupError === error) throw error;
      }
    }
    throw uncertainError(options.kind, task.id, error);
  }

  let currentBoard;
  try {
    currentBoard = readBoard(context.paths, context.teamName);
    assertSameBoard(beforeBoard, currentBoard);
  } catch (error) {
    throw uncertainError(options.kind, task.id, error);
  }

  try {
    kanbanStore.writeKanbanState(context.paths, context.teamName, targetBoard, {
      revision: targetBoard.revision,
    });
  } catch (error) {
    throw uncertainError(options.kind, task.id, error);
  }

  try {
    return taskStore.updateTask(context.paths, task.id, (current) => {
      if (current.pendingKanbanTransition?.id !== transitionId) {
        throw new Error('Pending kanban transition marker changed before cleanup');
      }
      const cleaned = { ...current };
      delete cleaned.pendingKanbanTransition;
      return cleaned;
    }, options.scope, { preserveUpdatedAt: true });
  } catch (error) {
    throw uncertainError(options.kind, task.id, error);
  }
}

function inspectPendingLocked(context, taskId) {
  const task = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
  const hasMarker = Object.prototype.hasOwnProperty.call(task, 'pendingKanbanTransition');
  if (!hasMarker) throw new Error(`No pending kanban transition for task ${taskId}`);
  const marker = task.pendingKanbanTransition;
  const validMarker = isValidPendingTransition(context, task, marker);
  const currentBoard = readBoard(context.paths, context.teamName);
  const currentTaskHash = taskHash(task);
  const currentBoardHash = boardHash(currentBoard.state);
  const currentBoardToken = boardTokenHash(currentBoard.token);
  const beforeTask = validMarker && currentTaskHash === marker.beforeTaskHash;
  const expectedTask = validMarker && currentTaskHash === marker.expectedTaskHash;
  const beforeBoard =
    validMarker &&
    currentBoardHash === marker.beforeBoardHash &&
    currentBoardToken === marker.beforeBoardToken;
  const expectedBoard = validMarker && currentBoardHash === marker.expectedBoardHash;
  let mode = 'conflict';
  let reason = validMarker ? undefined : 'marker_invalid';
  // A board-only clear can leave the task hash unchanged; phase is its commit evidence.
  if (validMarker && beforeTask && beforeBoard && (!expectedTask || marker.phase === 'prepared')) {
    mode = 'cancel';
  } else if (validMarker && expectedTask && beforeBoard) {
    mode = 'publish';
  } else if (validMarker && expectedTask && expectedBoard) {
    mode = 'clear';
  }
  if (validMarker && marker.verifyArtifact) {
    try {
      taskArtifact.verifyTask(context, task);
    } catch {
      mode = 'conflict';
      reason = 'artifact_invalid';
    }
  }
  const currentColumn = currentBoard.state.tasks?.[taskId]?.column ?? null;
  const snapshotHash = hash(canonical({
    transitionId: marker?.id,
    currentTaskHash,
    currentBoardHash,
    currentBoardToken,
    mode,
    reason,
  }));
  return {
    taskId,
    contextHash: marker?.contextHash,
    transitionId: marker?.id,
    column: marker?.column,
    currentColumn,
    ...(marker?.targetStatus ? { targetStatus: marker.targetStatus } : {}),
    phase: marker?.phase,
    ...(marker?.operation ? { operation: marker.operation } : {}),
    mode,
    ...(reason ? { reason } : {}),
    snapshotHash,
  };
}

function inspectPendingTransition(context, taskId) {
  return withTeamBoardLock(context.paths, () => inspectPendingLocked(context, taskId));
}

function resolvePendingTransition(context, taskId, transitionId, snapshotHash, mode, contextHash) {
  return withTeamBoardLock(context.paths, () => {
    const checked = inspectPendingLocked(context, taskId);
    if (checked.transitionId !== transitionId) throw new Error('Pending kanban transition changed');
    if (checked.contextHash !== contextHash) throw new Error('Pending kanban transition context changed');
    if (checked.reason === 'artifact_invalid') {
      throw new Error('Pending kanban recovery cannot be verified because the required artifact is missing or changed');
    }
    if (
      checked.mode !== mode ||
      checked.snapshotHash !== snapshotHash ||
      checked.mode === 'conflict'
    ) {
      throw new Error('Pending kanban transition changed since inspection');
    }
    const current = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
    const marker = current.pendingKanbanTransition;
    if (mode === 'cancel') {
      taskStore.updateTask(context.paths, taskId, (task) => {
        if (task.pendingKanbanTransition?.id !== transitionId) {
          throw new Error('Pending kanban transition changed during recovery');
        }
        const restored = { ...task };
        delete restored.pendingKanbanTransition;
        return restored;
      }, undefined, { preserveUpdatedAt: true });
      return;
    }
    if (mode === 'publish') {
      kanbanStore.writeKanbanState(context.paths, context.teamName, marker.targetBoard, {
        revision: marker.targetBoard.revision,
      });
    }
    taskStore.updateTask(context.paths, taskId, (task) => {
      if (task.pendingKanbanTransition?.id !== transitionId) {
        throw new Error('Pending kanban transition changed during recovery');
      }
      const cleaned = { ...task };
      delete cleaned.pendingKanbanTransition;
      return cleaned;
    }, undefined, { preserveUpdatedAt: true });
  });
}

module.exports = {
  assertNoPending,
  boardHash,
  inspectPendingTransition,
  resolvePendingTransition,
  runPendingTransition,
  taskHash,
};
