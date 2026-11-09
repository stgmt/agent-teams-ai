const kanban = require('./kanban.js');
const leadReportingClient = require('./leadReportingClient.js');
const { readLeadReportFacts } = require('./leadReportFacts.js');
const review = require('./review.js');
const tasks = require('./tasks.js');
const startupWork = require('./startupWork.js');
const taskBriefingGate = require('./taskBriefingGate.js');
const taskArtifact = require('./taskArtifact.js');
const { buildDeferredTaskQueueText } = require('./deferredTaskQueue.js');
const taskOwnershipGuards = require('./taskOwnershipGuards.js');

// Application boundary for task-board lifecycle writes.
// Keep this thin so existing task, review, and kanban behavior remains stable.

function createTask(context, flags) {
  return tasks.createTask(context, flags);
}

function reconcileTaskCreation(context, flags) {
  return tasks.reconcileTaskCreation(context, flags);
}

function getTask(context, taskId, scope) {
  return tasks.getTask(context, taskId, scope);
}

function getTaskComment(context, taskId, commentId, scope) {
  return tasks.getTaskComment(context, taskId, commentId, scope);
}

function listTasks(context, scope) {
  return tasks.listTasks(context, scope);
}

function listTaskInventory(context, filters) {
  return tasks.listTaskInventory(context, filters);
}

function listDeletedTasks(context, scope) {
  return tasks.listDeletedTasks(context, scope);
}

function resolveTaskId(context, taskRef, scope) {
  return tasks.resolveTaskId(context, taskRef, scope);
}

function resolveTaskActor(context, actor) {
  return taskOwnershipGuards.resolveTaskActor(context, actor);
}

function setTaskStatus(context, taskId, status, actor, scope) {
  return tasks.setTaskStatus(context, taskId, status, actor, scope ? { scope } : {});
}

function startTask(context, taskId, actor, scope) {
  return tasks.startTask(context, taskId, actor, scope ? { scope } : {});
}

function completeTask(context, taskId, actor, scope) {
  return tasks.completeTask(context, taskId, actor, scope ? { scope } : {});
}

function softDeleteTask(context, taskId, actor, scope) {
  return tasks.softDeleteTask(context, taskId, actor, scope ? { scope } : {});
}

function restoreTask(context, taskId, actor, scope) {
  return tasks.restoreTask(context, taskId, actor, scope ? { scope } : {});
}

function setTaskOwner(context, taskId, owner, actor, scope) {
  return tasks.setTaskOwner(context, taskId, owner, actor, scope);
}

function updateTaskFields(context, taskId, fields, scope) {
  return tasks.updateTaskFields(context, taskId, fields, scope);
}

function addTaskComment(context, taskId, flags, scope) {
  return tasks.addTaskComment(context, taskId, flags, scope);
}

function attachTaskFile(context, taskId, flags, scope) {
  return tasks.attachTaskFile(context, taskId, flags, scope);
}

function attachCommentFile(context, taskId, commentId, flags, scope) {
  return tasks.attachCommentFile(context, taskId, commentId, flags, scope);
}

function addTaskAttachmentMeta(context, taskId, meta, scope) {
  return tasks.addTaskAttachmentMeta(context, taskId, meta, scope);
}

function removeTaskAttachment(context, taskId, attachmentId, scope) {
  return tasks.removeTaskAttachment(context, taskId, attachmentId, scope);
}

function setNeedsClarification(context, taskId, value, scope) {
  return tasks.setNeedsClarification(context, taskId, value, scope);
}

function linkTask(context, taskId, targetId, linkType, scope) {
  return tasks.linkTask(context, taskId, targetId, linkType, scope);
}

function unlinkTask(context, taskId, targetId, linkType, scope) {
  return tasks.unlinkTask(context, taskId, targetId, linkType, scope);
}

// The app's native bootstrap context sets deferTaskQueue: Actionable work in the startup
// context would keep the member in its first turn and block the launch confirmation. The
// work arrives as messages once the launch is confirmed (startupWork.js).
function memberBriefing(context, memberName, options = {}) {
  const taskQueue =
    options.deferTaskQueue === true
      ? deferredTaskBriefing(context, String(memberName).trim())
      : undefined;
  return tasks.memberBriefing(context, memberName, { ...options, taskQueue });
}

function deferredTaskBriefing(context, memberName) {
  return buildDeferredTaskQueueText(String(memberName));
}

function deliverStartupWork(context, memberName, options) {
  return startupWork.deliverStartupWork(context, memberName, options);
}

function deliverStartupWorkAsync(context, memberName, options) {
  return startupWork.deliverStartupWorkAsync(context, memberName, options);
}

function leadBriefing(context) {
  // A bound lead reads through the app so a management briefing never becomes a publishable
  // report operation, and an admitted human request gets the app's own inspection.
  if (leadReportingClient.requiresLeadReporting())
    return leadReportingClient.inspectLeadReport(context).then((briefing) => JSON.stringify(briefing));
  return tasks.leadBriefing(context);
}

function taskBriefing(context, memberName) {
  return tasks.taskBriefing(context, memberName);
}

// The briefing a member asks for with the task_briefing tool: held back until the app has
// confirmed the member's launch (taskBriefingGate.js).
function requestTaskBriefing(context, memberName) {
  return taskBriefingGate.requestTaskBriefing(context, memberName);
}

function getKanbanState(context) {
  return kanban.getKanbanState(context);
}

function inspectPendingTransition(context, taskId) {
  return kanban.inspectPendingTransition(context, taskId);
}

function resolvePendingTransition(context, taskId, transitionId, snapshotHash, mode, contextHash) {
  return kanban.resolvePendingTransition(
    context,
    taskId,
    transitionId,
    snapshotHash,
    mode,
    contextHash
  );
}

function setKanbanColumn(context, taskId, column, options) {
  return kanban.setKanbanColumn(context, taskId, column, options);
}

function clearKanban(context, taskId, options) {
  return kanban.clearKanban(context, taskId, options);
}

function listReviewers(context) {
  return kanban.listReviewers(context);
}

function addReviewer(context, reviewer) {
  return kanban.addReviewer(context, reviewer);
}

function removeReviewer(context, reviewer) {
  return kanban.removeReviewer(context, reviewer);
}

function updateColumnOrder(context, columnId, orderedTaskIds) {
  return kanban.updateColumnOrder(context, columnId, orderedTaskIds);
}

function requestReview(context, taskId, flags) {
  return review.requestReview(context, taskId, flags);
}

function startReview(context, taskId, flags) {
  return review.startReview(context, taskId, flags);
}

function approveReview(context, taskId, flags) {
  return review.approveReview(context, taskId, flags);
}

function requestChanges(context, taskId, flags) {
  return review.requestChanges(context, taskId, flags);
}

module.exports = {
  verifyTaskArtifact: taskArtifact.verifyTaskArtifact,
  readTaskArtifactData: taskArtifact.readTaskArtifactData,
  setTaskArtifactFile: taskArtifact.setTaskArtifactFile,
  addReviewer,
  addTaskAttachmentMeta,
  addTaskComment,
  approveReview,
  attachCommentFile,
  attachTaskFile,
  clearKanban,
  completeTask,
  createTask,
  getKanbanState,
  inspectPendingTransition,
  getTask,
  getTaskComment,
  leadBriefing,
  linkTask,
  listDeletedTasks,
  listReviewers,
  listTaskInventory,
  listTasks,
  deferredTaskBriefing,
  deliverStartupWork,
  deliverStartupWorkAsync,
  memberBriefing,
  removeReviewer,
  removeTaskAttachment,
  reconcileTaskCreation,
  readLeadReportFacts,
  requestChanges,
  requestReview,
  requestTaskBriefing,
  resolveTaskActor,
  resolveTaskId,
  resolvePendingTransition,
  restoreTask,
  setKanbanColumn,
  setNeedsClarification,
  setTaskOwner,
  setTaskStatus,
  softDeleteTask,
  startReview,
  startTask,
  taskBriefing,
  unlinkTask,
  updateColumnOrder,
  updateTaskFields,
};
