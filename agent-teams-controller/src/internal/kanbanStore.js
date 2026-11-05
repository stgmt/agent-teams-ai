const fs = require('fs');
const path = require('path');
const { createHash, randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('util');
const taskStore = require('./taskStore.js');
const { writeJsonFileSync } = require('./atomicFile.js');

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallbackValue;
    throw error;
  }
}

function writeJson(filePath, value) {
  writeJsonFileSync(filePath, value);
}

function getDefaultState(teamName) {
  return {
    teamName,
    reviewers: [],
    tasks: {},
  };
}

function sanitizeState(teamName, rawState) {
  const state = rawState && typeof rawState === 'object' ? rawState : {};
  const tasks = {};
  if (state.tasks && typeof state.tasks === 'object') {
    for (const [taskId, entry] of Object.entries(state.tasks)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.column !== 'review' && entry.column !== 'approved') continue;
      if (typeof entry.movedAt !== 'string') continue;
      tasks[String(taskId)] = {
        column: entry.column,
        movedAt: entry.movedAt,
        ...(typeof entry.transitionId === 'string' ? { transitionId: entry.transitionId } : {}),
        ...(entry.reviewer === null || typeof entry.reviewer === 'string'
          ? { reviewer: entry.reviewer }
          : {}),
        ...(typeof entry.errorDescription === 'string'
          ? { errorDescription: entry.errorDescription }
          : {}),
      };
    }
  }

  return {
    teamName,
    ...(typeof state.revision === 'string' ? { revision: state.revision } : {}),
    reviewers: Array.isArray(state.reviewers)
      ? state.reviewers.filter((entry) => typeof entry === 'string' && entry.trim())
      : [],
    tasks,
    ...(state.columnOrder && typeof state.columnOrder === 'object'
      ? { columnOrder: state.columnOrder }
      : {}),
  };
}

function assertKanbanStateConsistent(paths, state, options = {}) {
  let files;
  try {
    files = fs.readdirSync(paths.tasksDir);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw Object.assign(
      new Error(
        'KANBAN_TRANSITION_UNCERTAIN: Cannot verify Kanban transitions; inspect tasks before further changes.'
      ),
      {
        code: 'KANBAN_TRANSITION_UNCERTAIN',
        cause: error,
      }
    );
  }
  for (const name of files) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const taskId = path.basename(name, '.json');
    let task;
    try {
      task = JSON.parse(fs.readFileSync(path.join(paths.tasksDir, name), 'utf8'));
    } catch (error) {
      // Only anomaly-reporting agenda readers may continue with a malformed row.
      if (error instanceof SyntaxError && options.allowMalformedTasks === true) continue;
      throw Object.assign(
        new Error(
          `KANBAN_TRANSITION_UNCERTAIN: Cannot verify task ${taskId} and its Kanban transition; inspect the task before further changes.`
        ),
        { code: 'KANBAN_TRANSITION_UNCERTAIN', cause: error, taskId }
      );
    }
    const pending = task?.pendingKanbanTransition;
    if (pending) {
      throw Object.assign(
        new Error(
          `KANBAN_TRANSITION_UNCERTAIN: Review transition for task ${taskId} has an unknown outcome; inspect the task and board before further changes.`
        ),
        { code: 'KANBAN_TRANSITION_UNCERTAIN', taskId }
      );
    }
  }
}

function readKanbanState(paths, teamName, options = {}) {
  const state = sanitizeState(teamName, readJson(paths.kanbanPath, getDefaultState(teamName)));
  assertKanbanStateConsistent(paths, state, options);
  return state;
}

function writeKanbanState(paths, teamName, state) {
  const next = sanitizeState(teamName, { ...state, revision: randomUUID() });
  writeJson(paths.kanbanPath, next);
  return next;
}

function readBoardSnapshot(paths, teamName) {
  const before = fs.statSync(paths.kanbanPath, { bigint: true });
  const raw = fs.readFileSync(paths.kanbanPath, 'utf8');
  const after = fs.statSync(paths.kanbanPath, { bigint: true });
  const identity = (stat) =>
    [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  if (JSON.stringify(identity(before)) !== JSON.stringify(identity(after))) {
    throw new Error('Kanban changed while it was being inspected');
  }
  const board = JSON.parse(raw);
  if (
    !board ||
    typeof board !== 'object' ||
    Array.isArray(board) ||
    !board.tasks ||
    typeof board.tasks !== 'object' ||
    Array.isArray(board.tasks) ||
    board.teamName !== teamName ||
    typeof board.revision !== 'string'
  ) {
    throw new Error('Kanban state cannot be safely inspected');
  }
  return { board, identity: identity(after), hash: createHash('sha256').update(raw).digest('hex') };
}

function ensureBoardRevision(paths, teamName, state) {
  if (state.revision) return state;
  // Establish a causal version without discarding fields owned by other writers.
  const original = readJson(paths.kanbanPath, getDefaultState(teamName));
  if (
    !original ||
    typeof original !== 'object' ||
    Array.isArray(original) ||
    !original.tasks ||
    typeof original.tasks !== 'object' ||
    Array.isArray(original.tasks) ||
    (original.revision !== undefined && typeof original.revision !== 'string') ||
    (original.teamName !== undefined && original.teamName !== teamName)
  ) {
    throw new Error('Kanban state cannot be safely initialized');
  }
  const next = { ...original, teamName, revision: randomUUID() };
  writeJson(paths.kanbanPath, next);
  return sanitizeState(teamName, next);
}

function taskTransitionHash(task) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        status: task.status,
        reviewState: task.reviewState,
        historyEvents: task.historyEvents,
        reviewIntervals: task.reviewIntervals,
        artifactRequirement: task.artifactRequirement,
        attachments: task.attachments,
      })
    )
    .digest('hex');
}

function contextHash(paths) {
  return createHash('sha256').update(fs.realpathSync(paths.claudeDir)).digest('hex');
}

function inspectPendingTransition(paths, teamName, taskId) {
  const task = taskStore.readTask(paths, taskId, { includeDeleted: true });
  const pending = task.pendingKanbanTransition;
  if (!pending || typeof pending.id !== 'string') throw new Error('No pending Kanban transition');
  if (
    !/^[0-9a-f-]{36}$/i.test(pending.id) ||
    !['review', 'approved'].includes(pending.column) ||
    typeof pending.movedAt !== 'string' ||
    !Number.isFinite(Date.parse(pending.movedAt)) ||
    typeof pending.previousRevision !== 'string' ||
    !Array.isArray(pending.previousIdentity) ||
    pending.previousIdentity.length !== 5 ||
    pending.previousIdentity.some((value) => typeof value !== 'string') ||
    typeof pending.previousHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(pending.previousHash) ||
    typeof pending.taskHash !== 'string' ||
    !/^[0-9a-f]{64}$/i.test(pending.taskHash)
  ) {
    return {
      taskId: task.id,
      transitionId: pending.id,
      column: pending.column,
      mode: 'conflict',
      contextHash: contextHash(paths),
    };
  }
  const expected = {
    column: pending.column,
    movedAt: pending.movedAt,
    transitionId: pending.id,
    ...(pending.reviewer !== undefined ? { reviewer: pending.reviewer } : {}),
    ...(pending.errorDescription !== undefined
      ? { errorDescription: pending.errorDescription }
      : {}),
  };
  let snapshot;
  try {
    snapshot = readBoardSnapshot(paths, teamName);
  } catch {
    return {
      taskId: task.id,
      transitionId: pending.id,
      column: pending.column,
      mode: 'conflict',
      contextHash: contextHash(paths),
    };
  }
  const current = snapshot.board.tasks[task.id] ?? null;
  const taskMatches = taskTransitionHash(task) === pending.taskHash;
  let mode = 'conflict';
  if (taskMatches && isDeepStrictEqual(current, expected)) mode = 'clear';
  else if (
    taskMatches &&
    snapshot.board.revision === pending.previousRevision &&
    snapshot.hash === pending.previousHash &&
    isDeepStrictEqual(snapshot.identity, pending.previousIdentity) &&
    isDeepStrictEqual(current, pending.previousEntry)
  )
    mode = 'publish';
  return {
    taskId: task.id,
    contextHash: contextHash(paths),
    transitionId: pending.id,
    column: pending.column,
    currentColumn: current?.column ?? null,
    mode,
    snapshotHash: snapshot.hash,
  };
}

function resolvePendingTransition(
  paths,
  teamName,
  taskId,
  transitionId,
  expectedHash,
  expectedMode,
  expectedContextHash
) {
  if (contextHash(paths) !== expectedContextHash)
    throw new Error('Task context changed; no changes were made.');
  const inspected = inspectPendingTransition(paths, teamName, taskId);
  if (
    inspected.transitionId !== transitionId ||
    inspected.snapshotHash !== expectedHash ||
    inspected.mode !== expectedMode ||
    inspected.mode === 'conflict'
  ) {
    throw new Error('Kanban or task changed since inspection; no changes were made.');
  }
  const task = taskStore.readTask(paths, taskId, { includeDeleted: true });
  const pending = task.pendingKanbanTransition;
  if (inspected.mode === 'publish') {
    const snapshot = readBoardSnapshot(paths, teamName);
    if (
      snapshot.hash !== expectedHash ||
      snapshot.board.revision !== pending.previousRevision ||
      !isDeepStrictEqual(snapshot.identity, pending.previousIdentity)
    ) {
      throw new Error('Kanban changed since inspection; no changes were made.');
    }
    const state = snapshot.board;
    state.tasks[task.id] = {
      column: pending.column,
      movedAt: pending.movedAt,
      transitionId: pending.id,
      ...(pending.reviewer !== undefined ? { reviewer: pending.reviewer } : {}),
      ...(pending.errorDescription !== undefined
        ? { errorDescription: pending.errorDescription }
        : {}),
    };
    if (
      state.columnOrder &&
      typeof state.columnOrder === 'object' &&
      !Array.isArray(state.columnOrder)
    ) {
      const order = { ...state.columnOrder };
      for (const [column, ids] of Object.entries(order)) {
        if (Array.isArray(ids)) order[column] = ids.filter((id) => String(id) !== String(task.id));
      }
      order[pending.column] = (
        Array.isArray(order[pending.column]) ? order[pending.column] : []
      ).concat([String(task.id)]);
      state.columnOrder = order;
    }
    state.revision = randomUUID();
    writeJson(paths.kanbanPath, state);
  }
  taskStore.updateTask(
    paths,
    task.id,
    (current) => {
      delete current.pendingKanbanTransition;
      return current;
    },
    { allowPendingKanbanTransition: transitionId }
  );
}

function removeTaskFromColumnOrder(state, taskId) {
  if (!state.columnOrder || typeof state.columnOrder !== 'object') {
    return 0;
  }

  const cleaned = {};
  let removed = 0;
  for (const [columnId, orderedTaskIds] of Object.entries(state.columnOrder)) {
    if (!Array.isArray(orderedTaskIds)) continue;
    const nextIds = orderedTaskIds.filter((entry) => String(entry) !== String(taskId));
    removed += orderedTaskIds.length - nextIds.length;
    if (nextIds.length > 0) {
      cleaned[columnId] = nextIds.map((entry) => String(entry));
    }
  }

  state.columnOrder = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  return removed;
}

function appendTaskToColumnOrder(state, column, taskId) {
  if (!state.columnOrder || typeof state.columnOrder !== 'object') {
    return;
  }

  const nextColumnOrder = { ...state.columnOrder };
  const existing = Array.isArray(nextColumnOrder[column]) ? nextColumnOrder[column] : [];
  nextColumnOrder[column] = existing
    .map((entry) => String(entry))
    .filter((entry) => entry !== String(taskId))
    .concat([String(taskId)]);
  state.columnOrder = nextColumnOrder;
}

function setKanbanColumn(paths, teamName, taskId, column, updateTask) {
  if (column !== 'review' && column !== 'approved') {
    throw new Error(`Invalid kanban column: ${String(column)}`);
  }

  const previousState = ensureBoardRevision(paths, teamName, readKanbanState(paths, teamName));
  const before = readBoardSnapshot(paths, teamName);
  const state = {
    ...previousState,
    tasks: { ...previousState.tasks },
    ...(previousState.columnOrder ? { columnOrder: { ...previousState.columnOrder } } : {}),
  };
  const hadColumnOrder = Boolean(state.columnOrder && Object.keys(state.columnOrder).length > 0);
  removeTaskFromColumnOrder(state, taskId);
  if (hadColumnOrder && !state.columnOrder) {
    state.columnOrder = {};
  }
  const transitionId = randomUUID();
  state.tasks[String(taskId)] =
    column === 'review'
      ? { column: 'review', reviewer: null, movedAt: nowIso(), transitionId }
      : { column: 'approved', movedAt: nowIso(), transitionId };
  appendTaskToColumnOrder(state, column, taskId);
  try {
    taskStore.updateTask(paths, String(taskId), (task) => {
      const next = {
        ...task,
        reviewState: column,
        pendingKanbanTransition: {
          ...state.tasks[String(taskId)],
          id: transitionId,
          previousEntry: before.board.tasks[String(taskId)] ?? null,
          previousRevision: before.board.revision,
          previousIdentity: before.identity,
          previousHash: before.hash,
        },
      };
      const updated = updateTask ? updateTask(next) : next;
      updated.pendingKanbanTransition.taskHash = taskTransitionHash(updated);
      return updated;
    });
    // Detect legacy writers that changed the board during the task commit. This
    // read is not a filesystem CAS: an uncoordinated writer may still race the
    // subsequent rename, so mixed-version concurrent writes remain unsupported.
    const afterTaskCommit = readBoardSnapshot(paths, teamName);
    if (
      afterTaskCommit.hash !== before.hash ||
      !isDeepStrictEqual(afterTaskCommit.identity, before.identity)
    ) {
      throw new Error('Kanban changed during the review transition');
    }
    writeKanbanState(paths, teamName, state);
    taskStore.updateTask(
      paths,
      String(taskId),
      (task) => {
        delete task.pendingKanbanTransition;
        return task;
      },
      { allowPendingKanbanTransition: transitionId }
    );
  } catch (error) {
    throw Object.assign(
      new Error(
        `KANBAN_TRANSITION_UNCERTAIN: Review transition for task ${taskId} has an unknown outcome; action may have completed. Inspect the task and board before further changes. ${error.message}`
      ),
      { code: 'KANBAN_TRANSITION_UNCERTAIN', cause: error }
    );
  }
  return state;
}

function clearKanban(paths, teamName, taskId, options = {}) {
  const state = readKanbanState(paths, teamName);
  delete state.tasks[String(taskId)];
  removeTaskFromColumnOrder(state, taskId);
  writeKanbanState(paths, teamName, state);
  const nextReviewState =
    typeof options.nextReviewState === 'string' ? options.nextReviewState : 'none';
  taskStore.updateTask(paths, String(taskId), (task) => ({
    ...task,
    reviewState: nextReviewState,
    pendingKanbanTransition: undefined,
  }));
  return state;
}

function updateColumnOrder(paths, teamName, columnId, orderedTaskIds) {
  const state = readKanbanState(paths, teamName);
  const nextColumnOrder = { ...(state.columnOrder || {}) };
  if (Array.isArray(orderedTaskIds) && orderedTaskIds.length > 0) {
    nextColumnOrder[columnId] = orderedTaskIds.map((entry) => String(entry));
  } else {
    delete nextColumnOrder[columnId];
  }
  state.columnOrder = Object.keys(nextColumnOrder).length > 0 ? nextColumnOrder : undefined;
  writeKanbanState(paths, teamName, state);
  return state;
}

function garbageCollect(paths, teamName, validTaskIds) {
  const state = readKanbanState(paths, teamName);
  let staleKanbanEntriesRemoved = 0;
  let staleColumnOrderRefsRemoved = 0;

  for (const taskId of Object.keys(state.tasks)) {
    if (!validTaskIds.has(taskId)) {
      delete state.tasks[taskId];
      staleKanbanEntriesRemoved += 1;
    }
  }

  if (state.columnOrder && typeof state.columnOrder === 'object') {
    const cleaned = {};
    for (const [columnId, orderedTaskIds] of Object.entries(state.columnOrder)) {
      if (!Array.isArray(orderedTaskIds)) {
        continue;
      }

      const validIds = orderedTaskIds.filter((taskId) => {
        const id = String(taskId);
        return validTaskIds.has(id) && state.tasks[id] && state.tasks[id].column === columnId;
      });
      staleColumnOrderRefsRemoved += orderedTaskIds.length - validIds.length;
      if (validIds.length > 0) {
        cleaned[columnId] = validIds;
      }
    }

    state.columnOrder = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  if (staleKanbanEntriesRemoved > 0 || staleColumnOrderRefsRemoved > 0) {
    writeKanbanState(paths, teamName, state);
  }

  return {
    state,
    staleKanbanEntriesRemoved,
    staleColumnOrderRefsRemoved,
  };
}

module.exports = {
  assertKanbanStateConsistent,
  inspectPendingTransition,
  resolvePendingTransition,
  clearKanban,
  garbageCollect,
  readKanbanState,
  setKanbanColumn,
  updateColumnOrder,
  writeKanbanState,
};
