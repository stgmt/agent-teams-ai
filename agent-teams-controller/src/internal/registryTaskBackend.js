/**
 * Task backend that reads and writes through the desktop app's control API.
 *
 * The app is the only process holding the registry token, so live canonical
 * task operations go through its app-bound HTTP connection. An explicit task
 * snapshot supplies detached reads for one controller operation only.
 *
 * There is no local fallback: live failures surface as a typed
 * {@link TaskBackendError}, and snapshot-backed writes are rejected.
 */

const {
  TASK_BACKEND_ERROR_CODES,
  TaskBackendError,
} = require('./taskBackendErrors.js');
const { REGISTRY_TASK_ID_PATTERN, deriveDisplayId } = require('./taskIdentity.js');
const { createRegistryTaskClient } = require('./taskRegistryClient.js');
const { normalizeOwnerValue } = require('./taskOwnerValue.js');
const { taskNotFound } = require('./taskReadErrors.js');
const { normalizeTaskGroupChatId } = require('./taskGroupAssociation.js');
const { normalizeCreationCommand } = require('./taskCreationCommand.js');

const TEAM_TASK_STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted']);
const LOCAL_TASK_ID_PATTERN = /^(?:[^:]+:)?TASK-(\d+)$/i;
const NUMERIC_TASK_ID_PATTERN = /^\d+$/;

/** Execution fields stay in the app's ExecutionTaskStore, never in canonical files. */
const EXECUTION_FIELDS = [
  'reviewState', 'comments', 'attachments', 'needsClarification',
  'artifactRequirement',
  'workIntervals', 'reviewIntervals', 'historyEvents', 'activeForm',
  'groupChatId', 'prompt', 'projectPath', 'descriptionTaskRefs', 'promptTaskRefs',
  'sourceMessageId', 'sourceMessage', 'createdBy', 'creationCommand', 'pendingKanbanTransition',
];
const MANAGED_FIELDS = [
  'subject', 'description', 'requirements', 'owner', 'blockedBy', 'related',
  ...EXECUTION_FIELDS,
];
/** Fields handled by a dedicated call (status endpoint) or derived server-side. */
const DERIVED_FIELDS = new Set([
  'id',
  'displayId',
  'blocks',
  'updatedAt',
  'status',
  'registryStatus',
  'registryEntity',
  'specProject',
  'specSlug',
  'registryLocalId',
]);

function protocolError(operation, detail) {
  return new TaskBackendError(
    TASK_BACKEND_ERROR_CODES.REGISTRY_PROTOCOL_ERROR,
    `Team control API ${operation} returned an invalid task: ${detail}`,
    { operation }
  );
}

function readTrimmedString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/**
 * Accepts every id spelling the registry produces — `7`, `TASK-7`,
 * `<spec>:TASK-7` — and reduces it to the local numeric id.
 */
function toLocalTaskId(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  if (NUMERIC_TASK_ID_PATTERN.test(trimmed)) return trimmed;
  const match = LOCAL_TASK_ID_PATTERN.exec(trimmed);
  return match ? match[1] : trimmed;
}

function normalizeStatus(value) {
  const normalized = String(value ?? '').trim();
  return TEAM_TASK_STATUSES.has(normalized) ? normalized : null;
}

function normalizeTeamTask(raw, operation) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw protocolError(operation, 'payload is not an object');
  }
  const id = readTrimmedString(raw.id);
  if (!id) throw protocolError(operation, 'missing id');
  const status = normalizeStatus(raw.status);
  if (!status) throw protocolError(operation, `invalid status "${String(raw.status ?? '')}"`);
  const rawDisplayId = readTrimmedString(raw.displayId).replace(/^#/, '');
  return {
    ...raw,
    id,
    subject: typeof raw.subject === 'string' ? raw.subject : '',
    status,
    displayId: rawDisplayId || deriveDisplayId(id),
    ...(Array.isArray(raw.blockedBy) ? { blockedBy: [...raw.blockedBy] } : {}),
    ...(Array.isArray(raw.blocks) ? { blocks: [...raw.blocks] } : {}),
    ...(Array.isArray(raw.related) ? { related: [...raw.related] } : {}),
  };
}

function sortTasks(tasks) {
  tasks.sort((a, b) => {
    const byDisplay = String(a.displayId || a.id).localeCompare(
      String(b.displayId || b.id),
      undefined,
      { numeric: true, sensitivity: 'base' }
    );
    if (byDisplay !== 0) return byDisplay;
    return String(a.id).localeCompare(String(b.id), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
  return tasks;
}

function cloneTask(task) {
  return structuredClone(task);
}

function isDeepEqual(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left)) {
    if (left.length !== right.length) return false;
    return left.every((entry, index) => isDeepEqual(entry, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && isDeepEqual(left[key], right[key])
  );
}

function collectChangedFields(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((key) => !isDeepEqual(before[key], after[key])).sort();
}

function normalizeRequirements(input) {
  const raw = input.requirements ?? input.requirementIds;
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(raw.map((entry) => (typeof entry === 'string' ? entry.trim() : '')).filter(Boolean)),
  ];
}

function normalizeTaskScope(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Task scope must contain project and spec');
  }
  const project = readTrimmedString(value.project);
  const spec = readTrimmedString(value.spec);
  if (!project && !spec) return null;
  if (!project || !spec) throw new Error('Task scope requires both project and spec');
  return { project, spec };
}

function scopeFromCreateInput(input) {
  const project = readTrimmedString(input.specProject ?? input.project);
  const spec = readTrimmedString(input.specSlug ?? input.spec);
  if (!project && !spec) return null;
  if (!project || !spec) throw new Error('Task creation requires both specProject and specSlug');
  return { project, spec };
}

function readRelationshipRefs(input, name) {
  const raw = input[name] ?? input[name === 'blockedBy' ? 'blocked-by' : name];
  const refs = typeof raw === 'string' ? raw.split(',') : raw;
  if (!Array.isArray(refs)) return [];
  return refs.map((entry) => String(entry ?? '').trim()).filter(Boolean);
}

/**
 * @param {object} options
 * @param {string} options.teamName
 * @param {string} [options.baseUrl]
 * @param {Record<string,string>} [options.headers]
 * @param {object} [options.client] - injectable client (tests / composition)
 * @param {number} [options.timeoutMs]
 * @param {string} [options.specProject] - diagnostics only; the app owns the binding
 * @param {object[]} [options.readOnlyTasks] - detached, read-only task projection
 */
function createRegistryTaskBackend(options = {}) {
  const teamName = readTrimmedString(options.teamName);
  if (!teamName) {
    throw new Error('Missing teamName');
  }
  const hasReadOnlySnapshot = options.readOnlyTasks !== undefined;
  if (hasReadOnlySnapshot && !Array.isArray(options.readOnlyTasks)) {
    throw protocolError('readOnlyTaskSnapshot', 'payload is not an array');
  }
  const readOnlyTasks = hasReadOnlySnapshot
    ? sortTasks(
        structuredClone(options.readOnlyTasks).map((task) =>
          normalizeTeamTask(task, 'readOnlyTaskSnapshot')
        )
      )
    : null;
  const client =
    options.client ||
    (hasReadOnlySnapshot
      ? null
      : createRegistryTaskClient({
          teamName,
          ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
          ...(options.headers ? { headers: options.headers } : {}),
          ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
        }));
  const specProject = readTrimmedString(options.specProject) || undefined;

  function listAll(scope) {
    const normalizedScope = normalizeTaskScope(scope);
    if (hasReadOnlySnapshot) {
      return readOnlyTasks.filter((task) =>
        !normalizedScope ||
        (task.specProject === normalizedScope.project && task.specSlug === normalizedScope.spec)
      );
    }
    const tasks = client.listTasks(normalizedScope || undefined);
    if (!Array.isArray(tasks)) {
      throw protocolError('listTasks', 'missing tasks array');
    }
    return sortTasks(tasks.map((task) => normalizeTeamTask(task, 'listTasks')));
  }

  function matchTask(task, ref) {
    const normalizedRef = String(ref ?? '').trim().replace(/^#/, '');
    const localRef = toLocalTaskId(normalizedRef);
    const registryLocalId = readTrimmedString(task.registryLocalId).replace(/^#/, '');
    return (
      task.id === normalizedRef ||
      task.displayId === normalizedRef ||
      registryLocalId === normalizedRef ||
      toLocalTaskId(task.id) === localRef ||
      task.displayId === localRef ||
      (registryLocalId !== '' && toLocalTaskId(registryLocalId) === localRef)
    );
  }

  function resolveTask(taskRef, resolveOptions = {}) {
    const normalizedRef = String(taskRef ?? '')
      .trim()
      .replace(/^#/, '');
    if (!normalizedRef) {
      throw new Error('Missing taskId');
    }
    const includeDeleted = resolveOptions.includeDeleted === true;
    const scope = normalizeTaskScope(resolveOptions.scope);
    const tasks = listAll(scope).filter((task) => includeDeleted || task.status !== 'deleted');
    const matches = tasks.filter((task) => matchTask(task, normalizedRef));
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous task reference "${normalizedRef}" matches tasks: ${matches
          .map((task) => task.id)
          .sort()
          .join(', ')}`
      );
    }
    if (matches.length === 0) {
      throw taskNotFound(normalizedRef);
    }
    return matches[0];
  }

  function readTaskFully(taskRef, readOptions = {}) {
    const includeDeleted = readOptions.includeDeleted === true;
    const scope = normalizeTaskScope(readOptions.scope);
    if (readOptions.full !== true || hasReadOnlySnapshot) {
      return cloneTask(resolveTask(taskRef, readOptions));
    }
    if (typeof client.getTask !== 'function') {
      throw protocolError('getTask', 'client does not support full task reads');
    }

    const requestedRef = String(taskRef ?? '').trim().replace(/^#/, '');
    const canonicalId = REGISTRY_TASK_ID_PATTERN.test(requestedRef)
      ? requestedRef
      : resolveTask(requestedRef, { ...readOptions, includeDeleted: true }).id;
    const task = normalizeTeamTask(
      client.getTask(canonicalId, scope || undefined),
      'getTask'
    );
    if (task.id !== canonicalId) {
      throw protocolError('getTask', `requested id "${canonicalId}" resolved to "${task.id}"`);
    }
    if (!includeDeleted && task.status === 'deleted') throw taskNotFound(requestedRef);
    return cloneTask(task);
  }

  function patchTask(taskId, patch, scope) {
    return normalizeTeamTask(
      client.patchTask(taskId, patch, normalizeTaskScope(scope) || undefined),
      'patchTask'
    );
  }

  function readAfterWrite(taskId, readOptions = {}) {
    return cloneTask(resolveTask(taskId, readOptions));
  }

  function canonicalReference(listing, ref) {
    const normalizedRef = String(ref ?? '').trim().replace(/^#/, '');
    const exact = listing.find((task) => task.id === normalizedRef);
    if (exact) return exact.id;
    const matches = listing.filter((task) => matchTask(task, normalizedRef));
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous dependency reference "${normalizedRef}" matches tasks: ${matches
          .map((task) => task.id)
          .sort()
          .join(', ')}`
      );
    }
    return matches[0]?.id;
  }

  function assertNoBlockCycle(listing, sourceId, targetId) {
    const byId = new Map(listing.map((task) => [task.id, task]));
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
      if (!task) continue;
      for (const dependency of task.blockedBy || []) {
        const canonicalId = canonicalReference(listing, dependency);
        if (canonicalId) stack.push(canonicalId);
      }
    }
  }

  function updateLinks(taskId, links, scope) {
    patchTask(taskId, links, scope);
    return readAfterWrite(taskId, { includeDeleted: true, scope });
  }

  function createTask(input = {}) {
    const requestedId = readTrimmedString(input.id);
    if (requestedId) {
      throw new TaskBackendError(
        TASK_BACKEND_ERROR_CODES.TASK_ID_UNSUPPORTED,
        `The spec registry allocates task ids; "${requestedId}" cannot be requested.`
      );
    }
    const subject = readTrimmedString(input.subject);
    if (!subject) {
      throw new Error('Missing subject');
    }
    const scope = scopeFromCreateInput(input);
    const owner = readTrimmedString(input.owner) || undefined;
    const description =
      typeof input.description === 'string' && input.description.length > 0
        ? input.description
        : undefined;
    const creationCommand = normalizeCreationCommand(input.creationCommand);
    if (input.groupChatId !== undefined) normalizeTaskGroupChatId(input.groupChatId);
    const execution = {};
    for (const field of EXECUTION_FIELDS) {
      if (field === 'creationCommand') continue;
      if (input[field] !== undefined) execution[field] = input[field];
    }
    if (execution.createdBy === undefined && readTrimmedString(input.from)) {
      execution.createdBy = readTrimmedString(input.from);
    }
    if (creationCommand) execution.creationCommand = creationCommand;
    const blockedByIds = readRelationshipRefs(input, 'blockedBy').map((ref) =>
      resolveTask(ref, { includeDeleted: true }).id
    );
    const relatedIds = readRelationshipRefs(input, 'related').map((ref) =>
      resolveTask(ref, { includeDeleted: true }).id
    );
    const explicitStatus = normalizeStatus(input.status);
    const desiredStatus =
      explicitStatus || (owner && input.startImmediately === true && blockedByIds.length === 0
        ? 'in_progress'
        : 'pending');
    if (desiredStatus === 'deleted') {
      throw new TaskBackendError(
        TASK_BACKEND_ERROR_CODES.FIELD_UNSUPPORTED,
        'The registry cannot create a task in deleted status.'
      );
    }
    const requirements = normalizeRequirements(input);
    if (requirements.length === 0) {
      throw new TaskBackendError(
        TASK_BACKEND_ERROR_CODES.REQUIREMENTS_REQUIRED,
        'Task creation requires at least one existing FR/NFR/AC requirement reference.'
      );
    }

    const result = client.createTaskWithOutcome({
      subject,
      requirements,
      ...(scope ? { specProject: scope.project, specSlug: scope.spec } : {}),
      ...(description === undefined ? {} : { description }),
      ...(owner ? { owner } : {}),
      ...(blockedByIds.length ? { blockedBy: blockedByIds } : {}),
      ...(relatedIds.length ? { related: relatedIds } : {}),
      ...(desiredStatus === 'in_progress' ? { startImmediately: true } : {}),
      status: desiredStatus,
      ...execution,
    });
    const created = normalizeTeamTask(result.task, 'createTask');
    if (result.outcome === 'REPLAY') return cloneTask(created);
    return readAfterWrite(created.id, { includeDeleted: true, scope });
  }

  function reconcileTaskCreation(input = {}) {
    const command = normalizeCreationCommand(input.creationCommand);
    if (!command) throw new Error('Task creation reconciliation requires creationCommand');
    const task = listAll().find((entry) => {
      const existing = entry.creationCommand;
      return existing &&
        existing.namespace === command.namespace &&
        existing.scopeKey === command.scopeKey &&
        existing.operation === command.operation &&
        existing.commandId === command.commandId;
    });
    if (!task) throw taskNotFound(command.commandId);
    if (task.creationCommand.payloadHash !== command.payloadHash) {
      throw new Error('Task creation command conflict: command payload does not match');
    }
    return cloneTask(task);
  }

  function readTaskArtifactData(taskRef, attachmentId, scope) {
    if (hasReadOnlySnapshot) {
      throw new TaskBackendError(
        TASK_BACKEND_ERROR_CODES.APP_BINDING_REQUIRED,
        'Task artifact bytes require the app-bound task API.',
        { operation: 'readTaskArtifactData' }
      );
    }
    const normalizedScope = normalizeTaskScope(scope);
    const current = resolveTask(taskRef, {
      includeDeleted: true,
      scope: normalizedScope,
    });
    const proof = current.artifactRequirement?.proof;
    if (
      current.artifactRequirement?.required !== true ||
      proof?.attachmentId !== attachmentId ||
      !current.attachments?.some((entry) => entry.id === attachmentId)
    ) {
      return null;
    }
    return client.readTaskArtifactData(current.id, attachmentId);
  }

  function updateTaskArtifactFields(taskRef, fields, scope) {
    if (hasReadOnlySnapshot) {
      return rejectSnapshotMutation('updateTaskArtifactFields')();
    }
    const normalizedScope = normalizeTaskScope(scope);
    const current = resolveTask(taskRef, {
      includeDeleted: true,
      scope: normalizedScope,
    });
    const patch = {};
    for (const field of [
      'subject',
      'description',
      'requirements',
      'groupChatId',
      'artifactRequired',
      'artifactExpectedFilename',
    ]) {
      if (fields[field] !== undefined) patch[field] = fields[field];
    }
    if (fields.artifactFile !== undefined) {
      if (current.artifactRequirement?.required !== true && fields.artifactRequired !== true) {
        throw new Error('This task does not require an artifact');
      }
      if (
        !fields.artifactFile ||
        typeof fields.artifactFile !== 'object' ||
        Array.isArray(fields.artifactFile)
      ) {
        throw new TypeError('Artifact file must include filename and base64Data');
      }
      patch.artifactFile = {
        filename:
          typeof fields.artifactFile.filename === 'string' ? fields.artifactFile.filename : '',
        base64Data:
          typeof fields.artifactFile.base64Data === 'string'
            ? fields.artifactFile.base64Data
            : '',
      };
    }
    if (Object.keys(patch).length === 0) return cloneTask(current);
    const updated = client.patchTask(
      current.id,
      patch,
      normalizedScope || undefined
    );
    return normalizeTeamTask(updated, 'updateTaskArtifactFields');
  }

  function setTaskArtifactFile(taskRef, file, scope) {
    return updateTaskArtifactFields(taskRef, { artifactFile: file }, scope);
  }

  function updateTask(taskRef, updater, scope) {
    const normalizedScope = normalizeTaskScope(scope);
    const current = resolveTask(taskRef, { includeDeleted: true, scope: normalizedScope });
    const updated = updater(cloneTask(current)) || cloneTask(current);
    if (String(updated.id) !== current.id) {
      throw new Error(
        `Task id is immutable: "${current.id}" cannot be changed to "${String(updated.id)}"`
      );
    }
    for (const field of ['registryStatus', 'registryEntity', 'specProject', 'specSlug', 'registryLocalId']) {
      if (!isDeepEqual(current[field], updated[field])) {
        throw new Error(`Task ${field} is immutable through the controller task API`);
      }
    }

    const changedFields = collectChangedFields(current, updated);
    const unsupported = changedFields.filter(
      (field) => !MANAGED_FIELDS.includes(field) && !DERIVED_FIELDS.has(field)
    );
    if (unsupported.length > 0) {
      throw new TaskBackendError(
        TASK_BACKEND_ERROR_CODES.FIELD_UNSUPPORTED,
        `The app task API cannot persist ${unsupported.join(', ')} for task ${current.id}.`,
        { taskId: current.id, fields: unsupported }
      );
    }

    const patch = {};
    for (const field of MANAGED_FIELDS) {
      if (!changedFields.includes(field)) continue;
      if (EXECUTION_FIELDS.includes(field)) {
        patch[field] = updated[field] === undefined ? null : updated[field];
        continue;
      }
      if (field === 'owner') {
        patch.owner = normalizeOwnerValue(updated.owner) || null;
        continue;
      }
      if (field === 'blockedBy' || field === 'related') {
        patch[field] = Array.isArray(updated[field]) ? updated[field] : [];
        continue;
      }
      if (field === 'requirements') {
        patch.requirements = normalizeRequirements({ requirements: updated.requirements });
        continue;
      }
      if (updated[field] !== undefined) {
        patch[field] = updated[field];
      }
    }

    if (Object.keys(patch).length > 0) {
      patchTask(current.id, patch, normalizedScope);
    }
    if (changedFields.includes('status') && updated.status !== current.status) {
      const nextStatus = normalizeStatus(updated.status);
      if (!nextStatus) {
        throw new Error(`Invalid status: ${String(updated.status)}`);
      }
      client.setTaskStatus(
        current.id,
        {
          status: nextStatus,
          expectedStatus: current.status,
        },
        normalizedScope || undefined
      );
    }

    return readAfterWrite(current.id, { includeDeleted: true, scope: normalizedScope });
  }

  function setTaskStatus(taskRef, nextStatus, actor, scope) {
    const normalizedScope = normalizeTaskScope(scope);
    const status = normalizeStatus(nextStatus);
    if (!status) {
      throw new Error(`Invalid status: ${String(nextStatus)}`);
    }
    const current = resolveTask(taskRef, { includeDeleted: true, scope: normalizedScope });
    if (current.status === status) {
      return cloneTask(current);
    }
    client.setTaskStatus(
      current.id,
      {
        status,
        expectedStatus: current.status,
        ...(readTrimmedString(actor) ? { actor: readTrimmedString(actor) } : {}),
      },
      normalizedScope || undefined
    );
    return readAfterWrite(current.id, { includeDeleted: true, scope: normalizedScope });
  }

  function setTaskOwner(taskRef, owner, actor, scope) {
    const normalizedScope = normalizeTaskScope(scope);
    const nextOwner = normalizeOwnerValue(owner);
    const current = resolveTask(taskRef, { includeDeleted: true, scope: normalizedScope });
    if (normalizeOwnerValue(current.owner) === nextOwner) {
      return cloneTask(current);
    }
    patchTask(
      current.id,
      { owner: nextOwner || null, ...(readTrimmedString(actor) ? { actor: readTrimmedString(actor) } : {}) },
      normalizedScope
    );
    return readAfterWrite(current.id, { includeDeleted: true, scope: normalizedScope });
  }

  function linkTask(taskRef, targetRef, relationship, scope) {
    const normalizedScope = normalizeTaskScope(scope);
    const sourceId = resolveTask(taskRef, { scope: normalizedScope }).id;
    const targetId = resolveTask(targetRef).id;
    if (sourceId === targetId) {
      throw new Error('Cannot link a task to itself');
    }
    if (relationship === 'blocks') {
      return linkTask(targetId, sourceId, 'blocked-by');
    }
    if (relationship === 'blocked-by') {
      assertNoBlockCycle(listAll(), sourceId, targetId);
      const source = resolveTask(sourceId, { includeDeleted: true, scope: normalizedScope });
      const blockedBy = source.blockedBy || [];
      if (blockedBy.includes(targetId)) return cloneTask(source);
      return updateLinks(sourceId, { blockedBy: [...blockedBy, targetId] }, normalizedScope);
    }
    if (relationship !== 'related') {
      throw new Error(`Unsupported relationship: ${String(relationship)}`);
    }
    const source = resolveTask(sourceId, { includeDeleted: true, scope: normalizedScope });
    const related = source.related || [];
    if (related.includes(targetId)) return cloneTask(source);
    return updateLinks(sourceId, { related: [...related, targetId] }, normalizedScope);
  }

  function unlinkTask(taskRef, targetRef, relationship, scope) {
    const normalizedScope = normalizeTaskScope(scope);
    const sourceId = resolveTask(taskRef, { includeDeleted: true, scope: normalizedScope }).id;
    const targetId = resolveTask(targetRef, { includeDeleted: true }).id;
    if (relationship === 'blocks') {
      return unlinkTask(targetId, sourceId, 'blocked-by');
    }
    if (relationship === 'blocked-by') {
      const source = resolveTask(sourceId, { includeDeleted: true, scope: normalizedScope });
      const blockedBy = (source.blockedBy || []).filter((entry) => entry !== targetId);
      return updateLinks(sourceId, { blockedBy }, normalizedScope);
    }
    if (relationship !== 'related') {
      throw new Error(`Unsupported relationship: ${String(relationship)}`);
    }
    const source = resolveTask(sourceId, { includeDeleted: true, scope: normalizedScope });
    const related = (source.related || []).filter((entry) => entry !== targetId);
    return updateLinks(sourceId, { related }, normalizedScope);
  }

  function listTasks(listOptions = {}) {
    const includeDeleted = listOptions.includeDeleted === true;
    return listAll(listOptions.scope)
      .filter((task) => includeDeleted || task.status !== 'deleted')
      .map(cloneTask);
  }

  function listTaskRows(listOptions = {}) {
    return { tasks: listTasks(listOptions), anomalies: [] };
  }

  function rejectSnapshotMutation(operation) {
    return () => {
      throw new TaskBackendError(
        TASK_BACKEND_ERROR_CODES.READ_ONLY_TASK_SNAPSHOT,
        `Canonical task mutation "${operation}" is unavailable from a read-only task snapshot.`,
        { operation }
      );
    };
  }
  return {
    kind: hasReadOnlySnapshot ? 'registry-snapshot' : 'registry',
    teamName,
    specProject,

    scanTaskRows() {
      const rows = listAll().map((task) => {
        const rowTask = cloneTask(task);
        return {
          canonicalTaskId: rowTask.id,
          persistedTaskId: rowTask.id,
          filePath: null,
          task: rowTask,
        };
      });
      const rowsByCanonicalId = new Map(rows.map((row) => [row.canonicalTaskId, row]));
      const rowsByDisplayId = new Map();
      for (const row of rows) {
        const displayRows = rowsByDisplayId.get(row.task.displayId) || [];
        displayRows.push(row);
        rowsByDisplayId.set(row.task.displayId, displayRows);
      }
      return {
        rows,
        rowsByCanonicalId,
        rowsByDisplayId,
        identityRows: [],
        identityRowsByPersistedId: new Map(),
        identityClaims: new Map(),
        collidingTaskIds: new Set(),
        anomalies: [],
      };
    },

    listTaskRows(listOptions = {}) {
      return listTaskRows(listOptions);
    },

    listTasks(listOptions = {}) {
      return listTasks(listOptions);
    },

    readTask(taskRef, readOptions = {}) {
      return readTaskFully(taskRef, readOptions);
    },

    resolveTaskRef(taskRef, resolveOptions = {}) {
      return resolveTask(taskRef, resolveOptions).id;
    },

    createTask: hasReadOnlySnapshot ? rejectSnapshotMutation('createTask') : createTask,
    reconcileTaskCreation: hasReadOnlySnapshot
      ? rejectSnapshotMutation('reconcileTaskCreation')
      : reconcileTaskCreation,
    updateTask: hasReadOnlySnapshot ? rejectSnapshotMutation('updateTask') : updateTask,
    readTaskArtifactData,
    updateTaskArtifactFields: hasReadOnlySnapshot
      ? rejectSnapshotMutation('updateTaskArtifactFields')
      : updateTaskArtifactFields,
    setTaskArtifactFile: hasReadOnlySnapshot
      ? rejectSnapshotMutation('setTaskArtifactFile')
      : setTaskArtifactFile,
    setTaskStatus: hasReadOnlySnapshot ? rejectSnapshotMutation('setTaskStatus') : setTaskStatus,
    setTaskOwner: hasReadOnlySnapshot ? rejectSnapshotMutation('setTaskOwner') : setTaskOwner,
    linkTask: hasReadOnlySnapshot ? rejectSnapshotMutation('linkTask') : linkTask,
    unlinkTask: hasReadOnlySnapshot ? rejectSnapshotMutation('unlinkTask') : unlinkTask,
  };
}

module.exports = {
  createRegistryTaskBackend,
};
