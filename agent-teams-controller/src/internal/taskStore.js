/** Controller task reads use the app-bound registry API or an explicit detached snapshot. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const reviewStateHelpers = require('./reviewState.js');
const { applyTaskGroupChatUpdate } = require('./taskGroupAssociation.js');
const { deriveDisplayId } = require('./taskIdentity.js');
const { resolveTaskBackend } = require('./taskBackendSelection.js');

function nowIso() { return new Date().toISOString(); }


function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function listTaskRows(paths, options = {}) {
  return resolveTaskBackend(paths).listTaskRows(options);
}

function listTasks(paths, options = {}) {
  return resolveTaskBackend(paths).listTasks(options);
}

function readTask(paths, taskRef, options = {}) {
  return resolveTaskBackend(paths).readTask(taskRef, options);
}

function resolveTaskRef(paths, taskRef, options = {}) {
  return resolveTaskBackend(paths).resolveTaskRef(taskRef, options);
}

function createTask(paths, input = {}) {
  return resolveTaskBackend(paths).createTask(input);
}

function reconcileTaskCreation(paths, input = {}) {
  return resolveTaskBackend(paths).reconcileTaskCreation(input);
}

function updateTask(paths, taskRef, updater) {
  return resolveTaskBackend(paths).updateTask(taskRef, updater);
}

function setTaskStatus(paths, taskRef, nextStatus, actor) {
  return resolveTaskBackend(paths).setTaskStatus(taskRef, nextStatus, actor);
}

function setTaskOwner(paths, taskRef, owner, actor) {
  return resolveTaskBackend(paths).setTaskOwner(taskRef, owner, actor);
}

function linkTask(paths, taskRef, targetRef, relationship) {
  return resolveTaskBackend(paths).linkTask(taskRef, targetRef, relationship);
}

function unlinkTask(paths, taskRef, targetRef, relationship) {
  return resolveTaskBackend(paths).unlinkTask(taskRef, targetRef, relationship);
}

function appendHistoryEvent(events, event) {
  const list = Array.isArray(events) ? [...events] : [];
  list.push({ id: crypto.randomUUID(), timestamp: nowIso(), ...event });
  return list;
}

function normalizeTaskRefs(taskRefs) {
  if (!Array.isArray(taskRefs) || taskRefs.length === 0) {
    return undefined;
  }

  const normalized = taskRefs
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      taskId: String(item.taskId || '').trim(),
      displayId: String(item.displayId || '').trim(),
      teamName: String(item.teamName || '').trim(),
    }))
    .filter((item) => item.taskId && item.displayId && item.teamName);

  return normalized.length > 0 ? normalized : undefined;
}

function updateTaskFields(paths, taskRef, fields) {
  return updateTask(paths, taskRef, (task) => applyTaskFieldsUpdate(task, fields));
}

function applyTaskFieldsUpdate(task, fields) {
  applyTaskGroupChatUpdate(task, fields.groupChatId);
  if (fields.subject !== undefined) {
    task.subject = fields.subject;
  }
  if (fields.description !== undefined) {
    task.description = fields.description;
  }
  return task;
}

function addTaskComment(paths, taskRef, text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Missing comment text');
  }

  const comment = {
    id: options.id || crypto.randomUUID(),
    author:
      typeof options.author === 'string' && options.author.trim() ? options.author.trim() : 'user',
    text,
    createdAt:
      typeof options.createdAt === 'string' && options.createdAt.trim()
        ? options.createdAt.trim()
        : nowIso(),
    type: options.type || 'regular',
    ...(normalizeTaskRefs(options.taskRefs)
      ? { taskRefs: normalizeTaskRefs(options.taskRefs) }
      : {}),
    ...(Array.isArray(options.attachments) && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
  };

  let inserted = false;
  const task = updateTask(paths, taskRef, (currentTask) => {
    const comments = Array.isArray(currentTask.comments) ? currentTask.comments : [];
    if (comments.some((entry) => entry.id === comment.id)) {
      return currentTask;
    }

    currentTask.comments = comments.concat([comment]);
    inserted = true;
    return currentTask;
  });

  return { comment, task, inserted, clarificationCleared: false };
}

function setNeedsClarification(paths, taskRef, value) {
  return updateTask(paths, taskRef, (task) => {
    if (value === null || value === 'clear') {
      delete task.needsClarification;
    } else if (value === 'lead' || value === 'user') {
      task.needsClarification = value;
    } else {
      throw new Error(`Invalid clarification value: ${String(value)}`);
    }
    return task;
  });
}

function addTaskAttachmentMeta(paths, taskRef, meta) {
  return updateTask(paths, taskRef, (task) => {
    const attachments = Array.isArray(task.attachments) ? task.attachments : [];
    if (!attachments.some((entry) => entry.id === meta.id)) {
      task.attachments = attachments.concat([meta]);
    }
    return task;
  });
}

function removeTaskAttachment(paths, taskRef, attachmentId) {
  return updateTask(paths, taskRef, (task) => {
    const attachments = Array.isArray(task.attachments) ? task.attachments : [];
    const filtered = attachments.filter((entry) => entry.id !== attachmentId);
    if (filtered.length > 0) task.attachments = filtered;
    else delete task.attachments;
    return task;
  });
}

function addCommentAttachmentMeta(paths, taskRef, commentRef, meta) {
  return updateTask(paths, taskRef, (task) => {
    const comments = Array.isArray(task.comments) ? [...task.comments] : [];
    const commentIndex = comments.findIndex((entry) => String(entry.id) === String(commentRef));
    if (commentIndex < 0) {
      throw new Error(`Comment not found: ${String(commentRef)}`);
    }
    const comment = { ...comments[commentIndex] };
    const attachments = Array.isArray(comment.attachments) ? comment.attachments : [];
    if (!attachments.some((entry) => entry.id === meta.id)) {
      comment.attachments = attachments.concat([meta]);
    }
    comments[commentIndex] = comment;
    task.comments = comments;
    return task;
  });
}

function buildTaskReference(task) {
  return `#${task.displayId || deriveDisplayId(task.id)} (taskId: ${task.id})`;
}

function getTaskFreshness(task) {
  const updated = Date.parse(String(task.updatedAt || ''));
  if (Number.isFinite(updated) && updated > 0) return updated;
  const created = Date.parse(String(task.createdAt || ''));
  if (Number.isFinite(created) && created > 0) return created;
  return 0;
}

function compareTasksByFreshness(a, b) {
  const freshnessDiff = getTaskFreshness(b) - getTaskFreshness(a);
  if (freshnessDiff !== 0) return freshnessDiff;
  const byDisplay = String(a.displayId || a.id).localeCompare(
    String(b.displayId || b.id),
    undefined,
    {
      numeric: true,
      sensitivity: 'base',
    }
  );
  if (byDisplay !== 0) return byDisplay;
  return String(a.id).localeCompare(String(b.id), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function getEffectiveReviewState(kanbanEntry, task) {
  return reviewStateHelpers.getEffectiveReviewState(task, kanbanEntry).state;
}

function formatBriefTaskLine(task, reviewState) {
  const reviewSuffix = reviewState !== 'none' ? `, review=${reviewState}` : '';
  return `- #${task.displayId || deriveDisplayId(task.id)} [status=${task.status}${reviewSuffix}] ${task.subject}`;
}

function formatCommentLine(comment) {
  const author =
    typeof comment.author === 'string' && comment.author.trim() ? comment.author.trim() : 'unknown';
  const text = typeof comment.text === 'string' ? comment.text.trim() : '';
  return `  - ${author}: ${text || '(empty comment)'}`;
}

function formatTaskBriefing(paths, teamName, memberName) {
  const kanbanState = readJson(path.join(paths.teamDir, 'kanban-state.json'), {
    teamName,
    reviewers: [],
    tasks: {},
  });
  const activeTasks = listTasks(paths)
    .filter((task) => task.owner === memberName && task.status !== 'deleted')
    .sort(compareTasksByFreshness);

  if (activeTasks.length === 0) {
    return `No assigned tasks for ${memberName}.`;
  }

  const groups = {
    in_progress: activeTasks.filter((task) => task.status === 'in_progress'),
    needs_fix: activeTasks.filter((task) => {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      return (
        task.status !== 'in_progress' && getEffectiveReviewState(kanbanEntry, task) === 'needsFix'
      );
    }),
    pending: activeTasks.filter((task) => {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      return task.status === 'pending' && getEffectiveReviewState(kanbanEntry, task) === 'none';
    }),
    review: activeTasks.filter((task) => {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      return getEffectiveReviewState(kanbanEntry, task) === 'review';
    }),
    completed: activeTasks.filter((task) => {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      return task.status === 'completed' && getEffectiveReviewState(kanbanEntry, task) === 'none';
    }),
    approved: activeTasks.filter((task) => {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      return getEffectiveReviewState(kanbanEntry, task) === 'approved';
    }),
  };

  const lines = [`Task briefing for ${memberName}:`];

  if (groups.in_progress.length > 0) {
    lines.push('', 'In progress:');
    for (const task of groups.in_progress) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      const reviewState = getEffectiveReviewState(kanbanEntry, task);
      lines.push(formatBriefTaskLine(task, reviewState));
      if (task.description) {
        lines.push(`  Description: ${task.description}`);
      }
      if (Array.isArray(task.comments) && task.comments.length > 0) {
        lines.push('  Comments:');
        for (const comment of task.comments) {
          lines.push(formatCommentLine(comment));
        }
      }
    }
  }

  if (groups.needs_fix.length > 0) {
    lines.push('', 'Needs fixes after review:');
    for (const task of groups.needs_fix) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      lines.push(formatBriefTaskLine(task, getEffectiveReviewState(kanbanEntry, task)));
    }
  }

  if (groups.pending.length > 0) {
    lines.push('', 'Pending:');
    for (const task of groups.pending) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      lines.push(formatBriefTaskLine(task, getEffectiveReviewState(kanbanEntry, task)));
    }
  }

  if (groups.review.length > 0) {
    lines.push('', 'Review:');
    for (const task of groups.review) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      lines.push(formatBriefTaskLine(task, getEffectiveReviewState(kanbanEntry, task)));
    }
  }

  if (groups.completed.length > 0) {
    lines.push('', 'Completed:');
    for (const task of groups.completed) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      lines.push(formatBriefTaskLine(task, getEffectiveReviewState(kanbanEntry, task)));
    }
  }

  if (groups.approved.length > 0) {
    lines.push('', 'Approved (last 10):');
    for (const task of groups.approved.slice(0, 10)) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      lines.push(formatBriefTaskLine(task, getEffectiveReviewState(kanbanEntry, task)));
    }
  }

  return lines.join('\n');
}

module.exports = {
  addCommentAttachmentMeta,
  addTaskAttachmentMeta,
  addTaskComment,
  appendHistoryEvent,
  buildTaskReference,
  createTask,
  deriveDisplayId,
  formatTaskBriefing,
  linkTask,
  listTaskRows,
  listTasks,
  readTask,
  reconcileTaskCreation,
  removeTaskAttachment,
  resolveTaskRef,
  setNeedsClarification,
  setTaskOwner,
  setTaskStatus,
  unlinkTask,
  updateTask,
  updateTaskFields,
};
