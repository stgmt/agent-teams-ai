const crypto = require('node:crypto');
const kanban = require('./kanban.js');
const messages = require('./messages.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const reviewStateHelpers = require('./reviewState.js');
const tasks = require('./tasks.js');
const { withTeamBoardLock } = require('./boardLock.js');
const { buildReviewRequestText } = require('./reviewRequestMessage.js');
const taskStore = require('./taskStore.js');
const pendingKanbanTransition = require('./pendingKanbanTransition.js');
const taskArtifact = require('./taskArtifact.js');
const { applyTaskStatus } = require('./taskStatusTransition.js');

function warnNonCritical(message, error) {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') {
    return;
  }
  console.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

function getReviewer(context, flags) {
  if (typeof flags.reviewer === 'string' && flags.reviewer.trim()) {
    return flags.reviewer.trim();
  }
  const state = kanban.getKanbanState(context);
  return typeof state.reviewers[0] === 'string' && state.reviewers[0].trim()
    ? state.reviewers[0].trim()
    : null;
}

function resolveLeadSessionId(context, flags) {
  return runtimeHelpers.resolveCanonicalLeadSessionId(context.paths, flags.leadSessionId);
}

function getReviewStateFromHistory(task) {
  const result = reviewStateHelpers.getReviewStateFromHistory(task);
  return result ? result.state : null;
}

function getCurrentReviewState(task) {
  return getReviewStateFromHistory(task) || 'none';
}

function getEffectiveReviewState(context, task) {
  const state = kanban.getKanbanState(context);
  const kanbanEntry = state.tasks ? state.tasks[task.id] : undefined;
  return reviewStateHelpers.getEffectiveReviewState(task, kanbanEntry).state;
}

function getLatestReviewRequestedReviewer(task) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'review_requested') {
      return typeof e.reviewer === 'string' && e.reviewer.trim() ? e.reviewer.trim() : null;
    }
    if (
      e.type === 'review_changes_requested' ||
      e.type === 'review_approved' ||
      (e.type === 'status_changed' &&
        (e.to === 'in_progress' || e.to === 'pending' || e.to === 'deleted')) ||
      e.type === 'task_created'
    ) {
      return null;
    }
  }
  return null;
}

function normalizeActorKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

function closeTimestampForInterval(interval, timestamp) {
  const startedAtMs = Date.parse(interval.startedAt);
  const timestampMs = Date.parse(timestamp);
  if (Number.isFinite(startedAtMs) && Number.isFinite(timestampMs) && timestampMs < startedAtMs) {
    return interval.startedAt;
  }
  return timestamp;
}

function isOpenReviewInterval(interval) {
  return interval && interval.completedAt === undefined;
}

function openReviewInterval(task, reviewer, timestamp = new Date().toISOString()) {
  const reviewerName = typeof reviewer === 'string' && reviewer.trim() ? reviewer.trim() : '';
  if (!reviewerName) return false;
  const reviewerKey = normalizeActorKey(reviewerName);
  const intervals = Array.isArray(task.reviewIntervals) ? [...task.reviewIntervals] : [];
  let changed = false;
  let hasOpenForReviewer = false;
  const nextIntervals = intervals.map((interval) => {
    if (!isOpenReviewInterval(interval)) return interval;
    if (normalizeActorKey(interval.reviewer) === reviewerKey) {
      hasOpenForReviewer = true;
      return interval;
    }
    changed = true;
    return { ...interval, completedAt: closeTimestampForInterval(interval, timestamp) };
  });
  if (hasOpenForReviewer) {
    task.reviewIntervals = nextIntervals;
    return changed;
  }
  task.reviewIntervals = [...nextIntervals, { reviewer: reviewerName, startedAt: timestamp }];
  return true;
}

function closeReviewIntervals(task, timestamp = new Date().toISOString()) {
  if (!Array.isArray(task.reviewIntervals)) return false;
  let changed = false;
  task.reviewIntervals = task.reviewIntervals.map((interval) => {
    if (!isOpenReviewInterval(interval)) return interval;
    changed = true;
    return { ...interval, completedAt: closeTimestampForInterval(interval, timestamp) };
  });
  return changed;
}

function resolveKnownActorName(context, value, label) {
  const actor = typeof value === 'string' && value.trim() ? value.trim() : '';
  if (!actor) return null;
  return runtimeHelpers.assertExplicitTeamMemberName(context.paths, actor, label, {
    allowLeadAliases: true,
  });
}

function tryResolveKnownActorName(context, value, label) {
  try {
    return resolveKnownActorName(context, value, label);
  } catch {
    return null;
  }
}

function resolveActorIdentityKey(context, value) {
  const actor = typeof value === 'string' && value.trim() ? value.trim() : '';
  if (!actor) return '';
  const resolved = runtimeHelpers.resolveExplicitTeamMemberName(context.paths, actor, {
    allowLeadAliases: true,
  });
  return normalizeActorKey(resolved || actor);
}

function isLeadActor(context, value) {
  const key = normalizeActorKey(value);
  const resolvedKey = resolveActorIdentityKey(context, value);
  const leadKey = normalizeActorKey(runtimeHelpers.inferLeadName(context.paths));
  return key === 'lead' || key === 'team-lead' || (leadKey && resolvedKey === leadKey);
}

function assertMatchesAssignedReviewer(context, task, actor, actionName) {
  const assignedReviewer = getLatestReviewRequestedReviewer(task);
  if (!assignedReviewer || isLeadActor(context, actor)) {
    return;
  }
  const assignedKey = resolveActorIdentityKey(context, assignedReviewer);
  const actorKey = resolveActorIdentityKey(context, actor);
  if (assignedKey && actorKey && assignedKey !== actorKey) {
    throw new Error(
      `Task #${task.displayId || task.id} is assigned to reviewer ${assignedReviewer}; ${actor} cannot ${actionName}`
    );
  }
}

function getReviewStartActor(context, task, flags) {
  if (typeof flags.from === 'string' && flags.from.trim()) {
    const actor = resolveKnownActorName(context, flags.from, 'review actor');
    assertMatchesAssignedReviewer(context, task, actor, 'start review');
    return actor;
  }

  const requestedReviewer = getLatestReviewRequestedReviewer(task);
  if (requestedReviewer) {
    return resolveKnownActorName(context, requestedReviewer, 'reviewer');
  }

  const state = kanban.getKanbanState(context);
  const kanbanEntry = state.tasks ? state.tasks[task.id] : undefined;
  if (kanbanEntry && typeof kanbanEntry.reviewer === 'string' && kanbanEntry.reviewer.trim()) {
    return resolveKnownActorName(context, kanbanEntry.reviewer, 'reviewer');
  }

  throw new Error(
    `review_start requires from when task #${task.displayId || task.id} has no assigned reviewer`
  );
}

function getLatestReviewStartedActor(task) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'review_started') {
      return typeof e.actor === 'string' && e.actor.trim() ? e.actor.trim() : null;
    }
    if (
      e.type === 'review_changes_requested' ||
      e.type === 'review_approved' ||
      (e.type === 'status_changed' &&
        (e.to === 'in_progress' || e.to === 'pending' || e.to === 'deleted')) ||
      e.type === 'task_created'
    ) {
      return null;
    }
  }
  return null;
}

function getReviewDecisionActor(context, task, flags, actionName) {
  const explicit = resolveKnownActorName(context, flags.from, 'review actor');
  const startedActor = tryResolveKnownActorName(
    context,
    getLatestReviewStartedActor(task),
    'review actor'
  );
  const assignedReviewer = tryResolveKnownActorName(
    context,
    getLatestReviewRequestedReviewer(task),
    'reviewer'
  );
  const inferredActor =
    startedActor &&
    (!assignedReviewer ||
      resolveActorIdentityKey(context, startedActor) ===
        resolveActorIdentityKey(context, assignedReviewer))
      ? startedActor
      : assignedReviewer;
  const actor =
    explicit || inferredActor || resolveKnownActorName(context, 'team-lead', 'review actor');
  assertMatchesAssignedReviewer(context, task, actor, actionName);
  return actor;
}

function assertReviewTransitionAllowed(context, task, transitionName) {
  if (task.status === 'deleted') {
    throw new Error(`Task #${task.displayId || task.id} is deleted`);
  }
  if (task.status !== 'completed') {
    throw new Error(
      `Task #${task.displayId || task.id} must be completed before ${transitionName}`
    );
  }

  const reviewState = getEffectiveReviewState(context, task);
  if (reviewState !== 'review') {
    throw new Error(
      `Task #${task.displayId || task.id} must be in review before ${transitionName}`
    );
  }
  return reviewState;
}

function getLatestReviewLifecycleEvent(task) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e.type === 'review_requested' ||
      e.type === 'review_changes_requested' ||
      e.type === 'review_approved' ||
      e.type === 'review_started'
    ) {
      return e;
    }
    if (
      e.type === 'status_changed' &&
      (e.to === 'in_progress' || e.to === 'pending' || e.to === 'deleted')
    ) {
      return e;
    }
    if (e.type === 'task_created') {
      return e;
    }
  }
  return null;
}

function startReview(context, taskId, flags = {}) {
  return withTeamBoardLock(context.paths, () => {
    const task = tasks.getTask(context, taskId);
    if (task.status === 'deleted') {
      throw new Error(`Task #${task.displayId || task.id} is deleted`);
    }

    taskArtifact.verifyTask(context, task);
    const latestReviewEvent = getLatestReviewLifecycleEvent(task);
    const prevReviewState = getEffectiveReviewState(context, task);
    const targetTask = structuredClone(task);

    if (latestReviewEvent && latestReviewEvent.type === 'review_started') {
      assertReviewTransitionAllowed(context, task, 'starting review');
      const existingActor =
        typeof latestReviewEvent.actor === 'string' ? latestReviewEvent.actor.trim() : '';
      const existingActorValid = existingActor
        ? Boolean(
            runtimeHelpers.resolveExplicitTeamMemberName(context.paths, existingActor, {
              allowLeadAliases: true,
            })
          )
        : false;
      const assignedReviewer = tryResolveKnownActorName(
        context,
        getLatestReviewRequestedReviewer(task),
        'reviewer'
      );
      const existingMatchesAssigned =
        !assignedReviewer ||
        (existingActorValid &&
          resolveActorIdentityKey(context, existingActor) ===
            resolveActorIdentityKey(context, assignedReviewer));
      const requestedActor =
        typeof flags.from === 'string' && flags.from.trim()
          ? getReviewStartActor(context, task, flags)
          : null;
      if (
        existingActorValid &&
        existingMatchesAssigned &&
        requestedActor &&
        resolveActorIdentityKey(context, existingActor) !==
          resolveActorIdentityKey(context, requestedActor)
      ) {
        throw new Error(
          `Task #${task.displayId || task.id} review is already started by ${existingActor}`
        );
      }
      const repaired = !existingActorValid || !existingMatchesAssigned;
      const actor = repaired
        ? requestedActor || getReviewStartActor(context, task, flags)
        : existingActor;
      const timestamp = repaired ? new Date().toISOString() : latestReviewEvent.timestamp;
      openReviewInterval(targetTask, actor, timestamp);
      if (repaired) {
        targetTask.historyEvents = tasks.appendHistoryEvent(targetTask.historyEvents, {
          type: 'review_started',
          from: prevReviewState,
          to: 'review',
          actor,
          timestamp,
        });
        targetTask.reviewState = 'review';
      }
    } else {
      assertReviewTransitionAllowed(context, task, 'starting review');
      const actor = getReviewStartActor(context, task, flags);
      const timestamp = new Date().toISOString();
      openReviewInterval(targetTask, actor, timestamp);
      targetTask.historyEvents = tasks.appendHistoryEvent(targetTask.historyEvents, {
        type: 'review_started',
        from: prevReviewState,
        to: 'review',
        actor,
        timestamp,
      });
      targetTask.reviewState = 'review';
    }

    const reviewer = kanban.getKanbanState(context).tasks?.[task.id]?.reviewer;
    pendingKanbanTransition.runPendingTransition(context, task, targetTask, {
      kind: 'review',
      column: 'review',
      reviewer,
    });
    return { ok: true, taskId: task.id, displayId: task.displayId, column: 'review' };
  });
}

function requestReview(context, taskId, flags = {}) {
  const { task, reviewer, from, leadSessionId } = withTeamBoardLock(context.paths, () => {
    const currentTask = tasks.getTask(context, taskId);
    if (currentTask.status !== 'completed') {
      throw new Error(
        `Task #${currentTask.displayId || currentTask.id} must be completed before review`
      );
    }

    const nextFrom =
      resolveKnownActorName(context, flags.from, 'review requester') ||
      resolveKnownActorName(context, 'team-lead', 'review requester');
    const rawReviewer = getReviewer(context, flags);
    const nextReviewer = rawReviewer
      ? resolveKnownActorName(context, rawReviewer, 'reviewer')
      : null;
    const prevReviewState = getEffectiveReviewState(context, currentTask);
    if (prevReviewState === 'approved') {
      throw new Error(
        `Task #${currentTask.displayId || currentTask.id} is already approved; reopen work before requesting another review`
      );
    }

    taskArtifact.verifyTask(context, currentTask);
    const targetTask = structuredClone(currentTask);
    targetTask.historyEvents = tasks.appendHistoryEvent(targetTask.historyEvents, {
      type: 'review_requested',
      from: prevReviewState,
      to: 'review',
      ...(nextReviewer ? { reviewer: nextReviewer } : {}),
      actor: nextFrom,
    });
    targetTask.reviewState = 'review';
    const board = kanban.getKanbanState(context);
    pendingKanbanTransition.runPendingTransition(context, currentTask, targetTask, {
      kind: 'review',
      column: 'review',
      reviewer: board.tasks?.[currentTask.id]?.reviewer,
      verifyArtifact: true,
    });

    return {
      task: tasks.getTask(context, currentTask.id),
      reviewer: nextReviewer,
      from: nextFrom,
      leadSessionId: resolveLeadSessionId(context, flags),
    };
  });

  if (!reviewer) {
    return task;
  }

  try {
    messages.sendMessage(context, {
      to: reviewer,
      from,
      text: buildReviewRequestText(context, task),
      summary: `Review request for #${task.displayId || task.id}`,
      source: 'system_notification',
      ...(leadSessionId ? { leadSessionId } : {}),
    });
  } catch (error) {
    warnNonCritical(`[review] reviewer notification failed for task ${task.id}`, error);
  }

  return task;
}

function approveReview(context, taskId, flags = {}) {
  const result = withTeamBoardLock(context.paths, () => {
    const currentTask = tasks.getTask(context, taskId);
    const nextFrom = getReviewDecisionActor(context, currentTask, flags, 'approve review');
    const nextNote =
      typeof flags.note === 'string' && flags.note.trim() ? flags.note.trim() : 'Approved';
    const suppressTaskComment = flags.suppressTaskComment === true;
    const prevReviewState = getEffectiveReviewState(context, currentTask);

    if (currentTask.status === 'deleted') {
      throw new Error(`Task #${currentTask.displayId || currentTask.id} is deleted`);
    }

    if (prevReviewState === 'approved') {
      if (currentTask.status !== 'completed') {
        throw new Error(
          `Task #${currentTask.displayId || currentTask.id} must be completed before approval`
        );
      }
      kanban.setKanbanColumn(context, currentTask.id, 'approved', { transition: 'approve_review' });
      return {
        alreadyApproved: true,
        payload: {
          ok: true,
          taskId: currentTask.id,
          displayId: currentTask.displayId,
          column: 'approved',
          alreadyApproved: true,
        },
      };
    }

    assertReviewTransitionAllowed(context, currentTask, 'approval');
    taskArtifact.verifyTask(context, currentTask);
    const timestamp = new Date().toISOString();
    const targetTask = structuredClone(currentTask);
    closeReviewIntervals(targetTask, timestamp);
    targetTask.historyEvents = tasks.appendHistoryEvent(targetTask.historyEvents, {
      type: 'review_approved',
      from: prevReviewState,
      to: 'approved',
      ...(nextNote ? { note: nextNote } : {}),
      actor: nextFrom,
      timestamp,
    });
    targetTask.reviewState = 'approved';
    pendingKanbanTransition.runPendingTransition(context, currentTask, targetTask, {
      kind: 'review',
      column: 'approved',
      verifyArtifact: true,
    });

    if (!suppressTaskComment) {
      tasks.addTaskComment(context, currentTask.id, {
        text: nextNote,
        from: nextFrom,
        type: 'review_approved',
        notifyOwner: false,
      });
    }

    return {
      alreadyApproved: false,
      payload: tasks.getTask(context, currentTask.id),
      from: nextFrom,
      note: nextNote,
      leadSessionId: resolveLeadSessionId(context, flags),
      shouldNotifyOwner:
        (flags.notify === true || flags['notify-owner'] === true) && Boolean(currentTask.owner),
    };
  });

  try {
    const approvedTask = tasks.getTask(context, taskId);
    const history = Array.isArray(approvedTask.historyEvents) ? approvedTask.historyEvents : [];
    const approval = [...history].reverse().find((event) => event && event.type === 'review_approved');
    tasks.notifyUnblockedOwners(context, approvedTask, { reviewCycleId: approval && approval.id });
  } catch (error) {
    warnNonCritical('[review] dependency approval notification failed', error);
  }

  if (result.alreadyApproved) {
    return result.payload;
  }

  const { payload: task, from, note, leadSessionId, shouldNotifyOwner } = result;

  if (shouldNotifyOwner && task.owner) {
    try {
      messages.sendMessage(context, {
        to: task.owner,
        from,
        text:
          note && note !== 'Approved'
            ? `@${from} **approved** task #${task.displayId || task.id}\n\n${note}`
            : `@${from} **approved** task #${task.displayId || task.id}`,
        summary: `Approved #${task.displayId || task.id}`,
        source: 'system_notification',
        ...(leadSessionId ? { leadSessionId } : {}),
      });
    } catch (error) {
      warnNonCritical(`[review] owner approval notification failed for task ${task.id}`, error);
    }
  }

  return task;
}

function requestChanges(context, taskId, flags = {}) {
  const { task, from, comment, leadSessionId } = withTeamBoardLock(context.paths, () => {
    const currentTask = tasks.getTask(context, taskId);
    if (!currentTask.owner) {
      throw new Error(`No owner found for task ${String(taskId)}`);
    }

    const nextFrom = getReviewDecisionActor(context, currentTask, flags, 'request changes');
    const nextComment =
      typeof flags.comment === 'string' && flags.comment.trim()
        ? flags.comment.trim()
        : 'Reviewer requested changes.';
    const prevReviewState = assertReviewTransitionAllowed(
      context,
      currentTask,
      'requesting changes'
    );
    const leadSessionId = resolveLeadSessionId(context, flags);
    const timestamp = new Date().toISOString();

    const targetTask = structuredClone(currentTask);
    closeReviewIntervals(targetTask, timestamp);
    targetTask.historyEvents = tasks.appendHistoryEvent(targetTask.historyEvents, {
      type: 'review_changes_requested',
      from: prevReviewState,
      to: 'needsFix',
      ...(nextComment ? { note: nextComment } : {}),
      actor: nextFrom,
      timestamp,
    });
    targetTask.reviewState = 'needsFix';
    const targetWithStatus = applyTaskStatus(targetTask, 'pending', nextFrom, {}, {
      nowIso: () => timestamp,
      closeOpenReviewIntervals: closeReviewIntervals,
      appendHistoryEvent: tasks.appendHistoryEvent,
      normalizeTaskReviewState: reviewStateHelpers.normalizeReviewState,
    });
    const taskRefs = taskStore.normalizeTaskRefs(flags.taskRefs);
    const commentEntry = {
      id: crypto.randomUUID(),
      author: nextFrom,
      text: nextComment,
      createdAt: timestamp,
      type: 'review_request',
      ...(taskRefs ? { taskRefs } : {}),
    };
    targetWithStatus.comments = [
      ...(Array.isArray(targetWithStatus.comments) ? targetWithStatus.comments : []),
      commentEntry,
    ];
    pendingKanbanTransition.runPendingTransition(
      context,
      currentTask,
      targetWithStatus,
      {
        kind: 'status',
        column: 'none',
        operation: 'request_changes',
        targetStatus: 'pending',
      }
    );

    return {
      task: tasks.getTask(context, currentTask.id),
      from: nextFrom,
      comment: nextComment,
      leadSessionId,
    };
  });

  try {
    messages.sendMessage(context, {
      to: task.owner,
      from,
      text:
        `@${from} **requested changes** for task #${task.displayId || task.id}\n\n${comment}\n\n` +
        'The task has been moved back to pending. When you are ready to resume, review the task context, start it explicitly, implement the fixes, mark it completed, and request review again.',
      ...(Array.isArray(flags.taskRefs) ? { taskRefs: flags.taskRefs } : {}),
      summary: `Fix request for #${task.displayId || task.id}`,
      source: 'system_notification',
      ...(leadSessionId ? { leadSessionId } : {}),
    });
  } catch (error) {
    warnNonCritical(`[review] owner fix-request notification failed for task ${task.id}`, error);
  }

  return task;
}

module.exports = {
  approveReview,
  requestReview,
  requestChanges,
  startReview,
};
