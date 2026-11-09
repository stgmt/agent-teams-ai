const fs = require('fs');
const crypto = require('crypto');
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

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readKanbanStateSnapshot(paths, teamName) {
  let raw;
  try {
    raw = fs.readFileSync(paths.kanbanPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { state: getDefaultState(teamName), token: 'missing' };
    }
    throw error;
  }
  const parsed = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.tasks)) {
    throw new Error('Kanban safety state is corrupt');
  }
  if (
    parsed.teamName !== undefined &&
    (typeof parsed.teamName !== 'string' ||
      parsed.teamName.trim().toLowerCase() !== teamName.trim().toLowerCase())
  ) {
    throw new Error('Kanban safety state belongs to another team');
  }
  if (
    parsed.reviewers !== undefined &&
    (!Array.isArray(parsed.reviewers) ||
      parsed.reviewers.some((entry) => typeof entry !== 'string' || !entry.trim()))
  ) {
    throw new Error('Kanban safety state is corrupt');
  }
  for (const [taskId, entry] of Object.entries(parsed.tasks)) {
    if (
      !taskId.trim() ||
      !isRecord(entry) ||
      (entry.column !== 'review' && entry.column !== 'approved') ||
      typeof entry.movedAt !== 'string' ||
      !Number.isFinite(Date.parse(entry.movedAt)) ||
      (entry.transitionId !== undefined && typeof entry.transitionId !== 'string') ||
      (entry.reviewer !== undefined && entry.reviewer !== null && typeof entry.reviewer !== 'string') ||
      (entry.errorDescription !== undefined && typeof entry.errorDescription !== 'string')
    ) {
      throw new Error('Kanban safety state is corrupt');
    }
  }
  if (parsed.columnOrder !== undefined) {
    if (!isRecord(parsed.columnOrder)) throw new Error('Kanban safety state is corrupt');
    for (const [column, ids] of Object.entries(parsed.columnOrder)) {
      if (
        !['todo', 'in_progress', 'done', 'review', 'approved'].includes(column) ||
        !Array.isArray(ids) ||
        ids.some((id) => typeof id !== 'string')
      ) {
        throw new Error('Kanban safety state is corrupt');
      }
    }
  }
  const stat = fs.statSync(paths.kanbanPath);
  return {
    state: sanitizeState(teamName, parsed),
    token: `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`,
  };
}

function writeKanbanState(paths, teamName, state, options = {}) {
  const normalized = sanitizeState(teamName, state);
  normalized.revision =
    typeof options.revision === 'string' && options.revision.trim()
      ? options.revision
      : crypto.randomUUID();
  writeJson(paths.kanbanPath, normalized);
}

function readKanbanState(paths, teamName) {
  return sanitizeState(teamName, readJson(paths.kanbanPath, getDefaultState(teamName)));
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

function setKanbanColumn(paths, teamName, taskId, column) {
  if (column !== 'review' && column !== 'approved') {
    throw new Error(`Invalid kanban column: ${String(column)}`);
  }

  const state = readKanbanState(paths, teamName);
  const hadColumnOrder = Boolean(state.columnOrder && Object.keys(state.columnOrder).length > 0);
  removeTaskFromColumnOrder(state, taskId);
  if (hadColumnOrder && !state.columnOrder) {
    state.columnOrder = {};
  }
  state.tasks[String(taskId)] =
    column === 'review'
      ? { column: 'review', reviewer: null, movedAt: nowIso() }
      : { column: 'approved', movedAt: nowIso() };
  appendTaskToColumnOrder(state, column, taskId);
  writeKanbanState(paths, teamName, state);
  taskStore.updateTask(paths, String(taskId), (task) => ({
    ...task,
    reviewState: column,
  }));
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
  clearKanban,
  garbageCollect,
  readKanbanState,
  readKanbanStateSnapshot,
  setKanbanColumn,
  updateColumnOrder,
  writeKanbanState,
};
