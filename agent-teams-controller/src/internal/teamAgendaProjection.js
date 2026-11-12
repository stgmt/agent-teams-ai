const kanbanStore = require('./kanbanStore.js');
const pendingKanbanGuard = require('./pendingKanbanGuard.js');
const taskStore = require('./taskStore.js');
const reviewStateHelpers = require('./reviewState.js');
const { withTeamBoardReadLock } = require('./boardLock.js');
const { buildTaskInventoryRow, INVENTORY_KANBAN_COLUMNS } = require('./taskInventoryRow.js');

const MAX_SUBJECT_CHARS = 240;

function normalizeName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeKey(value) {
  return normalizeName(value).toLowerCase();
}

function compareTasksByFreshness(left, right) {
  const leftTs =
    Date.parse(normalizeName(left.updatedAt) || normalizeName(left.createdAt) || '') || 0;
  const rightTs =
    Date.parse(normalizeName(right.updatedAt) || normalizeName(right.createdAt) || '') || 0;
  if (leftTs !== rightTs) return rightTs - leftTs;

  const byDisplay = String(left.displayId || left.id).localeCompare(
    String(right.displayId || right.id),
    undefined,
    {
      numeric: true,
      sensitivity: 'base',
    }
  );
  if (byDisplay !== 0) return byDisplay;

  return String(left.id).localeCompare(String(right.id), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function truncateText(value, maxChars) {
  const text = normalizeName(value);
  if (!text || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... [truncated]`;
}

function matchesInventoryFilters(row, filters) {
  if (normalizeName(filters.owner) && normalizeKey(row.owner) !== normalizeKey(filters.owner)) {
    return false;
  }
  if (normalizeName(filters.status) && row.status !== filters.status) {
    return false;
  }
  if (normalizeName(filters.reviewState) && row.reviewState !== filters.reviewState) {
    return false;
  }
  if (normalizeName(filters.kanbanColumn)) {
    const kanbanColumn = filters.kanbanColumn;
    if (!INVENTORY_KANBAN_COLUMNS.has(kanbanColumn) || row.kanbanColumn !== kanbanColumn) {
      return false;
    }
  }
  if (normalizeName(filters.relatedTo)) {
    const related = Array.isArray(row.related) ? row.related : [];
    if (!related.includes(filters.relatedTo)) {
      return false;
    }
  }
  if (normalizeName(filters.blockedBy)) {
    const blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : [];
    if (!blockedBy.includes(filters.blockedBy)) {
      return false;
    }
  }
  return true;
}

function listTaskInventory(paths, teamName, filters = {}) {
  return withTeamBoardReadLock(paths, () => {
    // Inventory is a read of canonical task state: an unresolved transition
    // means the board cannot be projected consistently, exactly like task_get.
    pendingKanbanGuard.assertNoPendingTransitions(paths, taskStore);
    const scope = filters.scope;
    const readOptions = scope ? { scope } : {};
    const taskRows = taskStore.listTaskRows(paths, readOptions);
    const kanbanState = kanbanStore.readKanbanState(paths, teamName);
    const resolvedRelatedTo = normalizeName(filters.relatedTo)
      ? taskStore.resolveTaskRef(paths, filters.relatedTo, readOptions)
      : '';
    const resolvedBlockedBy = normalizeName(filters.blockedBy)
      ? taskStore.resolveTaskRef(paths, filters.blockedBy, readOptions)
      : '';
    const limit =
      typeof filters.limit === 'number' && Number.isFinite(filters.limit)
        ? Math.max(1, Math.floor(filters.limit))
        : null;

    const resolvedFilters = {
      ...filters,
      ...(resolvedRelatedTo ? { relatedTo: resolvedRelatedTo } : {}),
      ...(resolvedBlockedBy ? { blockedBy: resolvedBlockedBy } : {}),
    };
    const candidates = [];

    const addCandidate = (candidate) => {
      if (limit == null || candidates.length < limit) {
        candidates.push(candidate);
        return;
      }

      let oldestIndex = 0;
      for (let index = 1; index < candidates.length; index += 1) {
        if (compareTasksByFreshness(candidates[index].task, candidates[oldestIndex].task) > 0) {
          oldestIndex = index;
        }
      }

      if (compareTasksByFreshness(candidate.task, candidates[oldestIndex].task) < 0) {
        candidates[oldestIndex] = candidate;
      }
    };

    for (const task of taskRows.tasks) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      const reviewState = reviewStateHelpers.getEffectiveReviewState(task, kanbanEntry).state;
      const row = buildTaskInventoryRow(
        task,
        reviewState,
        kanbanEntry,
        truncateText(task.subject, MAX_SUBJECT_CHARS)
      );
      if (!matchesInventoryFilters(row, resolvedFilters)) {
        continue;
      }
      addCandidate({ task, row });
    }

    return candidates
      .sort((left, right) => compareTasksByFreshness(left.task, right.task))
      .map((entry) => entry.row);
  });
}

module.exports = {
  MAX_SUBJECT_CHARS,
  compareTasksByFreshness,
  listTaskInventory,
  normalizeKey,
  normalizeName,
  truncateText,
};
