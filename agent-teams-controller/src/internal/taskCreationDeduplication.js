const taskStore = require('./taskStore.js');
const { hasExplicitCreationCommand } = require('./taskCreationCommand.js');
const { normalizeTaskGroupChatId } = require('./taskGroupAssociation.js');
const { readTeamConfig } = require('./runtimeHelpers.js');

const TASK_CREATE_DEDUP_WINDOW_MS = 10 * 60 * 1000;

function normalizeDedupText(value) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

// Match TeamConfigReader.resolveProjectPathFromConfig: the app stores this
// effective project on newly created registry tasks.
function resolveDefaultProjectPath(config) {
  const clean = (value) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  const direct = clean(config?.projectPath);
  if (direct) return direct;
  const members = Array.isArray(config?.members) ? config.members : [];
  const lead = members.find((member) => {
    const type = typeof member?.agentType === 'string' ? member.agentType.trim().toLowerCase() : '';
    const name = typeof member?.name === 'string' ? member.name.trim().toLowerCase() : '';
    return type === 'team-lead' || type === 'lead' || type === 'orchestrator' || name === 'team-lead';
  });
  const leadPath = clean(lead?.cwd);
  if (leadPath) return leadPath;
  const paths = [...new Set(members.map((member) => clean(member?.cwd)).filter(Boolean))];
  if (paths.length === 1) return paths[0];
  const history = Array.isArray(config?.projectPathHistory) ? config.projectPathHistory : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const path = clean(history[index]);
    if (path) return path;
  }
  return undefined;
}

function normalizeDedupList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeDedupRelations(context, value) {
  return normalizeDedupList(value)
    .map((entry) => {
      try {
        return taskStore.resolveTaskRef(context.paths, entry, { includeDeleted: true });
      } catch {
        return normalizeDedupText(entry);
      }
    })
    .filter(Boolean)
    .sort();
}

function normalizeDedupRefs(value) {
  return normalizeDedupList(value)
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return normalizeDedupText(entry);
      return {
        taskId: normalizeDedupText(entry.taskId),
        displayId: normalizeDedupText(entry.displayId),
        teamName: normalizeDedupText(entry.teamName),
      };
    })
    .filter((entry) => (typeof entry === 'string' ? entry : entry.taskId || entry.displayId))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function normalizeDedupJson(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeDedupJson(entry))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalizeDedupJson(value[key])])
    );
  }
  if (typeof value === 'string') return normalizeDedupText(value);
  return value ?? null;
}

function normalizeInitialTaskStatus(taskInput) {
  if (taskInput && typeof taskInput.status === 'string' && taskInput.status.trim()) {
    return normalizeDedupText(taskInput.status);
  }
  if (taskInput && taskInput.startImmediately === true) return 'in_progress';
  if (taskInput && Array.isArray(taskInput.historyEvents)) {
    const created = taskInput.historyEvents.find((event) => event?.type === 'task_created');
    if (created && typeof created.status === 'string' && created.status.trim()) {
      return normalizeDedupText(created.status);
    }
  }
  return 'pending';
}

// Keyless creates carry no caller identity - lead tool loops re-run the same
// task_create set with fresh task ids. Deduplicate only when the complete
// semantic creation payload matches, so same-title tasks with different work
// are never collapsed into one row.
function buildTaskCreationDedupKey(context, taskInput, defaultProjectPath) {
  const subject = normalizeDedupText(taskInput && taskInput.subject);
  if (!subject) return null;
  const createdBy =
    normalizeDedupText(taskInput && taskInput.from) ||
    normalizeDedupText(taskInput && taskInput.createdBy);
  const description = normalizeDedupText(
    taskInput && taskInput.description !== undefined ? taskInput.description : subject
  );
  return JSON.stringify({
    subject,
    owner: normalizeDedupText(taskInput && taskInput.owner),
    createdBy,
    description,
    groupChatId: taskInput?.groupChatId ?? '',
    prompt: normalizeDedupText(taskInput && taskInput.prompt),
    blockedBy: normalizeDedupRelations(
      context,
      taskInput && (taskInput.blockedBy ?? taskInput['blocked-by'])
    ),
    related: normalizeDedupRelations(context, taskInput && taskInput.related),
    descriptionTaskRefs: normalizeDedupRefs(taskInput && taskInput.descriptionTaskRefs),
    promptTaskRefs: normalizeDedupRefs(taskInput && taskInput.promptTaskRefs),
    activeForm: normalizeDedupText(taskInput && (taskInput.activeForm ?? taskInput['active-form'])),
    projectPath: normalizeDedupText(taskInput?.projectPath ?? defaultProjectPath),
    needsClarification: normalizeDedupText(taskInput && taskInput.needsClarification),
    attachments: normalizeDedupJson(taskInput && taskInput.attachments),
    sourceMessageId: normalizeDedupText(taskInput && taskInput.sourceMessageId),
    sourceMessage: normalizeDedupJson(taskInput && taskInput.sourceMessage),
    initialStatus: normalizeInitialTaskStatus(taskInput),
  });
}

function findRecentDuplicateTask(context, taskInput) {
  normalizeTaskGroupChatId(taskInput?.groupChatId);
  const defaultProjectPath = resolveDefaultProjectPath(readTeamConfig(context.paths));
  const creationKey = buildTaskCreationDedupKey(context, taskInput, defaultProjectPath);
  const hasExplicitTaskId =
    typeof taskInput?.id === 'string' && taskInput.id.trim().length > 0;
  if (!creationKey || hasExplicitTaskId || hasExplicitCreationCommand(taskInput)) {
    return null;
  }
  const nowMs = Date.now();

  return (
    taskStore
      .listTasks(context.paths)
      .find((task) => {
        if (!task || (task.status !== 'pending' && task.status !== 'in_progress')) {
          return false;
        }
        if (buildTaskCreationDedupKey(context, task) !== creationKey) return false;
        const createdAtMs = Date.parse(String(task.createdAt || ''));
        return Number.isFinite(createdAtMs) && nowMs - createdAtMs <= TASK_CREATE_DEDUP_WINDOW_MS;
      }) || null
  );
}

module.exports = { findRecentDuplicateTask };
