const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { withFileLockSync } = require('./fileLock.js');
const { writeJsonFileSync } = require('./atomicFile.js');
const { deriveDisplayId } = require('./taskIdentity.js');
const { normalizeCreationCommand } = require('./taskCreationCommand.js');
const { normalizeTaskGroupChatId } = require('./taskGroupAssociation.js');
const { normalizeOwnerValue } = require('./taskOwnerValue.js');
const { taskNotFound } = require('./taskReadErrors.js');

const MAX_TASK_FILE_BYTES = 2 * 1024 * 1024;
const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted']);
const SAFE_TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function cloneTask(task) {
  return structuredClone(task);
}

function compareTasks(a, b) {
  return String(a.displayId || a.id).localeCompare(String(b.displayId || b.id), undefined, {
    numeric: true,
    sensitivity: 'base',
  }) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true, sensitivity: 'base' });
}

function parseRefs(value) {
  const values = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((item) => String(item ?? '').trim().replace(/^#/, '')).filter(Boolean))];
}

function appendHistoryEvent(events, event) {
  return [
    ...(Array.isArray(events) ? events : []),
    { id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...event },
  ];
}

function createLocalTaskBackend(options = {}) {
  const teamName = String(options.teamName || '').trim();
  const claudeDir = typeof options.claudeDir === 'string' ? path.resolve(options.claudeDir) : '';
  if (!teamName || !claudeDir) throw new Error('Local task board requires teamName and claudeDir');
  const tasksDir = path.join(claudeDir, 'tasks', teamName);
  const createLockPath = path.join(tasksDir, '.task-id-allocation');

  function taskPath(taskId) {
    const id = String(taskId ?? '').trim();
    if (!SAFE_TASK_ID.test(id) || id === '.' || id === '..' || id.includes('..')) {
      throw new Error(`Invalid task id: ${String(taskId)}`);
    }
    const result = path.join(tasksDir, `${id}.json`);
    if (path.dirname(result) !== tasksDir) throw new Error(`Invalid task id: ${String(taskId)}`);
    return result;
  }

  function readTaskFile(filePath, expectedId) {
    let fd;
    try {
      fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_TASK_FILE_BYTES) {
        throw new Error(`Task file is unavailable or too large: ${filePath}`);
      }
      const raw = fs.readFileSync(fd, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`Invalid task file: ${filePath}`);
      }
      if (String(parsed.id ?? '') !== expectedId) {
        throw new Error(`Task file identity does not match its filename: ${filePath}`);
      }
      if (!TASK_STATUSES.has(parsed.status)) {
        throw new Error(`Invalid task status in ${filePath}`);
      }
      const blocks = Array.isArray(parsed.blocks) ? parsed.blocks : [];
      const blockedBy = Array.isArray(parsed.blockedBy) ? parsed.blockedBy : [];
      const related = Array.isArray(parsed.related) ? parsed.related : [];
      return {
        ...parsed,
        id: expectedId,
        displayId: typeof parsed.displayId === 'string' && parsed.displayId.trim()
          ? parsed.displayId.trim().replace(/^#/, '')
          : deriveDisplayId(expectedId),
        blocks,
        blockedBy,
        related,
      };
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  function readAll() {
    let entries;
    try {
      entries = fs.readdirSync(tasksDir, { withFileTypes: true });
    } catch (error) {
      if (error && error.code === 'ENOENT') return { tasks: [], anomalies: [] };
      throw error;
    }
    const tasks = [];
    const anomalies = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = entry.name.slice(0, -5);
      try {
        const task = readTaskFile(path.join(tasksDir, entry.name), id);
        if (task) tasks.push(task);
      } catch (error) {
        anomalies.push({ code: 'invalid_task_file', taskId: id, detail: error.message });
      }
    }
    tasks.sort(compareTasks);
    return { tasks, anomalies };
  }

  function matchTask(task, ref) {
    const normalized = String(ref ?? '').trim().replace(/^#/, '');
    return task.id === normalized || task.displayId === normalized || deriveDisplayId(task.id) === normalized;
  }

  function resolveTask(taskRef, resolveOptions = {}) {
    assertUnscoped(resolveOptions.scope);
    const normalized = String(taskRef ?? '').trim().replace(/^#/, '');
    if (!normalized) throw new Error('Missing taskId');
    const snapshot = readAll();
    const matches = snapshot.tasks.filter((task) =>
      (resolveOptions.includeDeleted === true || task.status !== 'deleted') && matchTask(task, normalized)
    );
    if (matches.length > 1) {
      throw new Error(`Ambiguous task reference "${normalized}" matches tasks: ${matches.map((task) => task.id).join(', ')}`);
    }
    const isExactIdMatch = matches.length === 1 && matches[0].id === normalized;
    if (snapshot.anomalies.length > 0 && !isExactIdMatch) {
      const taskIds = snapshot.anomalies.map((anomaly) => anomaly.taskId).join(', ');
      throw new Error(`Cannot verify task records with unreadable files: ${taskIds}`);
    }
    if (matches.length === 0) throw taskNotFound(normalized);
    return matches[0];
  }
  function resolveStoredTask(taskId, includeDeleted = true) {
    const id = String(taskId ?? '').trim();
    const task = readTaskFile(taskPath(id), id);
    if (!task || (!includeDeleted && task.status === 'deleted')) throw taskNotFound(id);
    return task;
  }

  function writeTaskUnlocked(task) {
    writeJsonFileSync(taskPath(task.id), task);
    return cloneTask(task);
  }

  function writeNewTask(task) {
    const filePath = taskPath(task.id);
    const tempPath = path.join(tasksDir, `.tmp.${crypto.randomUUID()}`);
    let createdTemp = false;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(task, null, 2), { flag: 'wx', mode: 0o600 });
      createdTemp = true;
      // Linking publishes the complete file only if the destination does not exist.
      fs.linkSync(tempPath, filePath);
    } finally {
      if (createdTemp) fs.unlinkSync(tempPath);
    }
  }

  function assertMatchingCreation(task, command) {
    const existing = task.creationCommand;
    if (
      !command || !existing || task.id !== command.commandId ||
      existing.namespace !== command.namespace || existing.scopeKey !== command.scopeKey ||
      existing.operation !== command.operation || existing.commandId !== command.commandId ||
      existing.payloadHash !== command.payloadHash ||
      (existing.idempotencyKey !== undefined && existing.idempotencyKey !== command.idempotencyKey)
    ) {
      throw new Error('Task creation command conflict: destination provenance does not match');
    }
  }

  function repairCreationBacklinks(task) {
    for (const [ids, field] of [[task.blockedBy || [], 'blocks'], [task.related || [], 'related']]) {
      for (const targetId of ids) {
        withFileLockSync(taskPath(targetId), () => {
          const current = resolveStoredTask(targetId, true);
          const links = Array.isArray(current[field]) ? current[field] : [];
          if (!links.includes(task.id)) {
            writeTaskUnlocked({
              ...current,
              [field]: [...links, task.id],
              updatedAt: new Date().toISOString(),
            });
          }
        });
      }
    }
  }

  function updateStoredTask(taskId, updater, updateOptions = {}) {
    const id = String(taskId ?? '').trim();
    const filePath = taskPath(id);
    return withFileLockSync(filePath, () => {
      const current = resolveStoredTask(id, true);
      const draft = cloneTask(current);
      const candidate = updater(draft) || draft;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('Task update must produce a task object');
      }
      if (String(candidate.id) !== id) throw new Error('Task id is immutable');
      const next = {
        ...candidate,
        id,
        displayId: current.displayId,
        updatedAt: updateOptions.preserveUpdatedAt
          ? current.updatedAt
          : new Date().toISOString(),
      };
      return writeTaskUnlocked(next);
    });
  }

  function assertUnscoped(scope) {
    if (scope !== undefined && scope !== null) {
      throw new Error('Local task board does not accept registry task scope');
    }
  }

  function assertUnscopedOptions(options) {
    assertUnscoped(options?.scope);
  }

  function resolveReferences(values) {
    return parseRefs(values).map((ref) => resolveTask(ref, { includeDeleted: true }).id);
  }

  function listAll() {
    return readAll().tasks;
  }

  function assertNoBlockCycle(sourceId, targetId) {
    const byId = new Map(listAll().map((task) => [task.id, task]));
    const visited = new Set();
    const stack = [targetId];
    while (stack.length > 0) {
      const currentId = stack.pop();
      if (!currentId || visited.has(currentId)) continue;
      if (currentId === sourceId) {
        throw new Error(`Circular dependency: ${targetId} already depends on ${sourceId}`);
      }
      visited.add(currentId);
      const task = byId.get(currentId);
      for (const dependency of task?.blockedBy || []) {
        const resolved = listAll().find((entry) => matchTask(entry, dependency));
        if (resolved) stack.push(resolved.id);
      }
    }
  }

  function mutatePair(firstId, secondId, mutate) {
    const firstPath = taskPath(firstId);
    const secondPath = taskPath(secondId);
    const [leftPath, rightPath] = firstPath < secondPath ? [firstPath, secondPath] : [secondPath, firstPath];
    return withFileLockSync(leftPath, () => withFileLockSync(rightPath, () => {
      const first = resolveStoredTask(firstId, true);
      const second = resolveStoredTask(secondId, true);
      const [nextFirst, nextSecond] = mutate(cloneTask(first), cloneTask(second));
      const now = new Date().toISOString();
      const savedFirst = { ...nextFirst, updatedAt: now };
      const savedSecond = { ...nextSecond, updatedAt: now };
      writeTaskUnlocked(savedFirst);
      writeTaskUnlocked(savedSecond);
      return cloneTask(savedFirst);
    }));
  }

  function createTask(input = {}) {
    if (input.scope !== undefined || input.specProject || input.specSlug || input.project || input.spec) {
      throw new Error('Local task board does not accept registry task scope');
    }
    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    if (!subject) throw new Error('Missing subject');
    if (input.groupChatId !== undefined) normalizeTaskGroupChatId(input.groupChatId);
    const creationCommand = normalizeCreationCommand(input.creationCommand);
    const requestedId = input.id === undefined ? '' : String(input.id).trim();
    if (input.id !== undefined && !requestedId) throw new Error('Invalid task id');
    if (requestedId) taskPath(requestedId);
    if (creationCommand && requestedId && requestedId !== creationCommand.commandId) {
      throw new Error('Task creation command conflict: task id does not match command id');
    }
    const explicitId = requestedId || (creationCommand && creationCommand.commandId) || '';
    if (explicitId) taskPath(explicitId);
    const blockedByRefs = input.blockedBy ?? input['blocked-by'];
    const blockedBy = resolveReferences(blockedByRefs);
    const related = resolveReferences(input.related);
    const owner = normalizeOwnerValue(input.owner) || undefined;
    const requestedStatus = input.status == null ? '' : String(input.status).trim();
    if (requestedStatus && !TASK_STATUSES.has(requestedStatus)) throw new Error(`Invalid status: ${requestedStatus}`);
    const status = requestedStatus || (owner && input.startImmediately === true && blockedBy.length === 0 ? 'in_progress' : 'pending');
    const requirements = Array.isArray(input.requirements)
      ? [...new Set(input.requirements.map((item) => String(item ?? '').trim()).filter(Boolean))]
      : [];
    const createdAt = typeof input.createdAt === 'string' && input.createdAt.trim()
      ? input.createdAt.trim()
      : new Date().toISOString();

    return withFileLockSync(createLockPath, () => {
      fs.mkdirSync(tasksDir, { recursive: true, mode: 0o700 });
      const existingIds = readAll().tasks.map((task) => Number(task.id)).filter(Number.isSafeInteger);
      const nextId = existingIds.reduce((max, value) => Math.max(max, value), 0) + 1;
      const id = explicitId || String(nextId);
      let task = {
        id,
        displayId: id,
        subject,
        description: typeof input.description === 'string' ? input.description : '',
        ...(owner ? { owner } : {}),
        status,
        requirements,
        blocks: [],
        blockedBy,
        related,
        reviewState: input.reviewState || 'none',
        ...(input.artifactRequirement ? { artifactRequirement: cloneTask(input.artifactRequirement) } : {}),
        ...(Array.isArray(input.attachments) ? { attachments: cloneTask(input.attachments) } : {}),
        ...(Array.isArray(input.comments) ? { comments: cloneTask(input.comments) } : {}),
        ...(Array.isArray(input.reviewIntervals) ? { reviewIntervals: cloneTask(input.reviewIntervals) } : {}),
        ...(Array.isArray(input.historyEvents) ? { historyEvents: cloneTask(input.historyEvents) } : {}),
        ...(input.groupChatId !== undefined && input.groupChatId !== null
          ? { groupChatId: normalizeTaskGroupChatId(input.groupChatId) }
          : {}),
        ...(input.creationCommand === undefined ? {} : { creationCommand }),
        ...(typeof input.createdBy === 'string' && input.createdBy.trim()
          ? { createdBy: input.createdBy.trim() }
          : typeof input.from === 'string' && input.from.trim() ? { createdBy: input.from.trim() } : {}),
        ...(typeof input.activeForm === 'string' ? { activeForm: input.activeForm } : {}),
        ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
        ...(typeof input.projectPath === 'string' ? { projectPath: input.projectPath } : {}),
        ...(Array.isArray(input.descriptionTaskRefs) ? { descriptionTaskRefs: cloneTask(input.descriptionTaskRefs) } : {}),
        ...(Array.isArray(input.promptTaskRefs) ? { promptTaskRefs: cloneTask(input.promptTaskRefs) } : {}),
        ...(typeof input.sourceMessageId === 'string' ? { sourceMessageId: input.sourceMessageId } : {}),
        ...(input.sourceMessage && typeof input.sourceMessage === 'object' ? { sourceMessage: cloneTask(input.sourceMessage) } : {}),
        ...(input.needsClarification ? { needsClarification: input.needsClarification } : {}),
        ...(Array.isArray(input.workIntervals) ? { workIntervals: cloneTask(input.workIntervals) } : status === 'in_progress' ? { workIntervals: [{ startedAt: createdAt }] } : {}),
        createdAt,
        updatedAt: createdAt,
      };
      task.historyEvents = appendHistoryEvent(task.historyEvents, {
        type: 'task_created',
        status,
        ...(task.createdBy ? { actor: task.createdBy } : {}),
      });
      const filePath = taskPath(id);
      withFileLockSync(filePath, () => {
        try {
          writeNewTask(task);
        } catch (error) {
          if (!error || error.code !== 'EEXIST') throw error;
          if (!creationCommand) {
            throw new Error('Task creation command conflict: destination task already exists');
          }
          const existing = resolveStoredTask(id, true);
          assertMatchingCreation(existing, creationCommand);
          task = existing;
        }
      });
      repairCreationBacklinks(task);
      return cloneTask(task);
    });
  }
  function reconcileTaskCreation(input = {}) {
    const command = normalizeCreationCommand(input.creationCommand);
    if (!command) throw new Error('Task creation reconciliation requires creationCommand');
    if (input.id !== undefined && String(input.id).trim() !== command.commandId) {
      throw new Error('Task creation command conflict: task id does not match command id');
    }
    const task = resolveStoredTask(command.commandId, true);
    assertMatchingCreation(task, command);
    repairCreationBacklinks(task);
    return cloneTask(task);
  }

  function setTaskStatus(taskRef, nextStatus, actor, scope) {
    assertUnscoped(scope);
    const status = String(nextStatus ?? '').trim();
    if (!TASK_STATUSES.has(status)) throw new Error(`Invalid status: ${String(nextStatus)}`);
    const current = resolveTask(taskRef, { includeDeleted: true });
    return updateStoredTask(current.id, (task) => {
      if (task.status === status) return task;
      const previousStatus = task.status;
      const timestamp = new Date().toISOString();
      const workIntervals = Array.isArray(task.workIntervals) ? cloneTask(task.workIntervals) : [];
      const lastInterval = workIntervals.length ? workIntervals[workIntervals.length - 1] : null;
      if (task.status !== 'in_progress' && status === 'in_progress' && (!lastInterval || lastInterval.completedAt !== undefined)) {
        workIntervals.push({ startedAt: timestamp });
      } else if (task.status === 'in_progress' && status !== 'in_progress' && lastInterval && lastInterval.completedAt === undefined) {
        lastInterval.completedAt = timestamp;
      }
      const reviewIntervals =
        ['pending', 'in_progress', 'deleted'].includes(status) && Array.isArray(task.reviewIntervals)
          ? task.reviewIntervals.map((interval) => interval && interval.completedAt === undefined
              ? { ...interval, completedAt: timestamp }
              : interval)
          : undefined;
      task.status = status;
      task.workIntervals = workIntervals.length ? workIntervals : undefined;
      if (reviewIntervals) task.reviewIntervals = reviewIntervals;
      task.historyEvents = appendHistoryEvent(task.historyEvents, {
        type: 'status_changed',
        from: previousStatus,
        to: status,
        ...(actor ? { actor } : {}),
        timestamp,
      });
      if (status === 'deleted') task.deletedAt = timestamp;
      else delete task.deletedAt;
      if (status === 'deleted' || status === 'in_progress' || (status === 'pending' && task.reviewState !== 'needsFix')) {
        task.reviewState = 'none';
      }
      return task;
    });
  }

  function setTaskOwner(taskRef, owner, actor, scope) {
    assertUnscoped(scope);
    const current = resolveTask(taskRef, { includeDeleted: true });
    const nextOwner = normalizeOwnerValue(owner);
    if (normalizeOwnerValue(current.owner) === nextOwner) return cloneTask(current);
    return updateStoredTask(current.id, (task) => {
      if (nextOwner) task.owner = nextOwner;
      else delete task.owner;
      task.historyEvents = appendHistoryEvent(task.historyEvents, {
        type: 'owner_changed', from: current.owner ?? null, to: nextOwner || null, ...(actor ? { actor } : {}),
      });
      return task;
    });
  }

  function linkTask(taskRef, targetRef, relationship, scope) {
    assertUnscoped(scope);
    const sourceId = resolveTask(taskRef).id;
    const targetId = resolveTask(targetRef, { includeDeleted: true }).id;
    if (sourceId === targetId) throw new Error('Cannot link a task to itself');
    if (relationship === 'blocks') return linkTask(targetId, sourceId, 'blocked-by', scope);
    if (!['blocked-by', 'related'].includes(relationship)) throw new Error(`Unsupported relationship: ${String(relationship)}`);
    if (relationship === 'blocked-by') assertNoBlockCycle(sourceId, targetId);
    return mutatePair(sourceId, targetId, (source, target) => {
      if (relationship === 'blocked-by') {
        if (!source.blockedBy.includes(targetId)) source.blockedBy.push(targetId);
        if (!target.blocks.includes(sourceId)) target.blocks.push(sourceId);
      } else {
        if (!source.related.includes(targetId)) source.related.push(targetId);
        if (!target.related.includes(sourceId)) target.related.push(sourceId);
      }
      return [source, target];
    });
  }

  function unlinkTask(taskRef, targetRef, relationship, scope) {
    assertUnscoped(scope);
    const sourceId = resolveTask(taskRef, { includeDeleted: true }).id;
    const targetId = resolveTask(targetRef, { includeDeleted: true }).id;
    if (relationship === 'blocks') return unlinkTask(targetId, sourceId, 'blocked-by', scope);
    if (!['blocked-by', 'related'].includes(relationship)) throw new Error(`Unsupported relationship: ${String(relationship)}`);
    return mutatePair(sourceId, targetId, (source, target) => {
      if (relationship === 'blocked-by') {
        source.blockedBy = source.blockedBy.filter((id) => id !== targetId);
        target.blocks = target.blocks.filter((id) => id !== sourceId);
      } else {
        source.related = source.related.filter((id) => id !== targetId);
        target.related = target.related.filter((id) => id !== sourceId);
      }
      return [source, target];
    });
  }

  function listTasks(listOptions = {}) {
    assertUnscopedOptions(listOptions);
    return listAll().filter((task) => listOptions.includeDeleted === true || task.status !== 'deleted').map(cloneTask);
  }

  function listTaskRows(listOptions = {}) {
    assertUnscopedOptions(listOptions);
    const snapshot = readAll();
    const tasks = snapshot.tasks.filter((task) => listOptions.includeDeleted === true || task.status !== 'deleted').map(cloneTask);
    return { tasks, anomalies: snapshot.anomalies.map((anomaly) => ({ ...anomaly })) };
  }

  function scanTaskRows() {
    const { tasks, anomalies } = readAll();
    const rows = tasks.map((task) => ({
      canonicalTaskId: task.id,
      persistedTaskId: task.id,
      filePath: taskPath(task.id),
      task: cloneTask(task),
    }));
    const rowsByCanonicalId = new Map(rows.map((row) => [row.canonicalTaskId, row]));
    const rowsByDisplayId = new Map();
    for (const row of rows) {
      const matches = rowsByDisplayId.get(row.task.displayId) || [];
      matches.push(row);
      rowsByDisplayId.set(row.task.displayId, matches);
    }
    return {
      rows,
      rowsByCanonicalId,
      rowsByDisplayId,
      identityRows: [],
      identityRowsByPersistedId: new Map(),
      identityClaims: new Map(),
      collidingTaskIds: new Set(),
      anomalies: anomalies.map((anomaly) => ({ ...anomaly })),
    };
  }

  return {
    kind: 'local-app-task-board',
    teamName,
    scanTaskRows,
    listTaskRows,
    listTasks,
    readTask(taskRef, readOptions = {}) {
      return cloneTask(resolveTask(taskRef, readOptions));
    },
    resolveTaskRef(taskRef, resolveOptions = {}) {
      return resolveTask(taskRef, resolveOptions).id;
    },
    createTask,
    reconcileTaskCreation,
    updateTask(taskRef, updater, scope, updateOptions = {}) {
      assertUnscoped(scope);
      return updateStoredTask(
        resolveTask(taskRef, { includeDeleted: true }).id,
        updater,
        updateOptions
      );
    },
    setTaskStatus,
    setTaskOwner,
    linkTask,
    unlinkTask,
  };
}

module.exports = { createLocalTaskBackend };
