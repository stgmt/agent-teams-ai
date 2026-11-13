const taskStore = require('./taskStore.js');

/**
 * A single-task read may omit the server-computed `blocks` list, so union the
 * declared dependents with the tasks whose own `blockedBy` names this task.
 * Otherwise a resolved blocker looks like it blocked nobody and no owner is told.
 */
function readDependentTaskIds(context, resolvedTask) {
  const declared = Array.isArray(resolvedTask.blocks) ? resolvedTask.blocks : [];
  const dependentIds = new Set(declared.map((id) => String(id)));
  try {
    const resolvedId = String(resolvedTask.id);
    for (const candidate of taskStore.listTasks(context.paths, { includeDeleted: true })) {
      const blockers = Array.isArray(candidate.blockedBy) ? candidate.blockedBy : [];
      if (blockers.some((blockerId) => String(blockerId) === resolvedId)) {
        dependentIds.add(String(candidate.id));
      }
    }
  } catch {
    // Best effort: fall back to the declared list when the board cannot be read.
  }
  return [...dependentIds];
}

module.exports = {
  readDependentTaskIds,
};
