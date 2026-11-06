/** Apply one status change to a task without writing it. */
function applyTaskStatus(task, status, actor, options, helpers) {
  if (options.beforeStatus) task = options.beforeStatus(task) || task;
  if (task.status !== status) {
    const timestamp = helpers.nowIso();
    const workIntervals = Array.isArray(task.workIntervals) ? [...task.workIntervals] : [];
    const lastInterval = workIntervals.length ? workIntervals[workIntervals.length - 1] : null;
    if (task.status !== 'in_progress' && status === 'in_progress') {
      if (!lastInterval || lastInterval.completedAt !== undefined) {
        workIntervals.push({ startedAt: timestamp });
      }
    } else if (task.status === 'in_progress' && status !== 'in_progress') {
      if (lastInterval && lastInterval.completedAt === undefined) lastInterval.completedAt = timestamp;
    }
    if (status === 'pending' || status === 'in_progress' || status === 'deleted') {
      helpers.closeOpenReviewIntervals(task, timestamp);
    }
    task.workIntervals = workIntervals.length ? workIntervals : undefined;
    task.historyEvents = helpers.appendHistoryEvent(task.historyEvents, {
      type: 'status_changed',
      from: task.status,
      to: status,
      ...(actor ? { actor } : {}),
      timestamp,
    });
    task.status = status;
    if (status === 'deleted') {
      task.deletedAt = timestamp;
    } else if (task.deletedAt) {
      delete task.deletedAt;
    }
  }
  if (status === 'deleted' || status === 'in_progress') {
    task.reviewState = 'none';
  } else if (status === 'pending' && helpers.normalizeTaskReviewState(task.reviewState) !== 'needsFix') {
    task.reviewState = 'none';
  }
  return options.afterStatus ? options.afterStatus(task) || task : task;
}

module.exports = { applyTaskStatus };
