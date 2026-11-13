/**
 * Fake control API for the registry task backend.
 *
 * Runs inside its own worker thread on purpose: the controller's request
 * bridge blocks the calling thread on `Atomics.wait`, so an HTTP server hosted
 * on that same thread could never answer it.
 */

const http = require('node:http');
const { parentPort, workerData } = require('node:worker_threads');

const tasks = (workerData.initialTasks || []).map((task) => ({ ...task }));
const requests = [];
const failStatus = workerData.failStatus || 0;
let nextId = tasks.reduce((max, task) => Math.max(max, Number(task.id) || 0), 0) + 1;
let clockMs;

function nowIso() {
  return new Date(clockMs === undefined ? Date.now() : clockMs).toISOString();
}

function projectTask(task) {
  const projected = { ...task };
  for (const field of ['workIntervals', 'reviewIntervals', 'comments', 'attachments', 'historyEvents']) {
    if (Array.isArray(projected[field]) && projected[field].length === 0) delete projected[field];
  }
  // Mirrors RegistryTaskProvider.toTeamTask: incoming links and the deletedAt
  // timestamp derived from the recorded transition. The app never serves a raw
  // board row, so the single-task route answers with the same projection.
  projected.blocks = tasks
    .filter((candidate) => Array.isArray(candidate.blockedBy) && candidate.blockedBy.includes(task.id))
    .map((candidate) => candidate.id);
  const deletedAt = projected.status === 'deleted' ? lastDeletedTransition(projected) : undefined;
  if (deletedAt === undefined) delete projected.deletedAt;
  else projected.deletedAt = deletedAt;
  return projected;
}

function lastDeletedTransition(task) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && event.type === 'status_changed') {
      return event.to === 'deleted' ? event.timestamp : undefined;
    }
  }
  return undefined;
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function matchesScope(task, searchParams) {
  const project = searchParams?.get('project') ?? null;
  const spec = searchParams?.get('spec') ?? null;
  if (project === null && spec === null) return true;
  return project !== null && spec !== null && task.specProject === project && task.specSlug === spec;
}

function findTask(taskId, searchParams) {
  return tasks.find(
    (task) => String(task.id) === String(taskId) && matchesScope(task, searchParams)
  );
}

function handleCreate(body) {
  const requirements = Array.isArray(body.requirements) ? body.requirements.filter(Boolean) : [];
  if (requirements.length === 0) {
    return { status: 400, payload: { code: 'REQUIREMENTS_REQUIRED', error: 'requirements required' } };
  }
  if (body.creationCommand) {
    const command = body.creationCommand;
    const existing = tasks.find((task) => task.creationCommand &&
      ['namespace', 'scopeKey', 'operation', 'commandId'].every(
        (field) => task.creationCommand[field] === command[field]
      ));
    if (existing) {
      if (existing.creationCommand.payloadHash !== command.payloadHash) {
        return {
          status: 409,
          payload: {
            code: 'COMMAND_CONFLICT',
            error: `Task creation command conflict: ${command.commandId}`,
          },
        };
      }
      return { status: 200, payload: { task: projectTask(existing), outcome: 'REPLAY' } };
    }
  }
  const {
    project: requestedProject,
    spec: requestedSpec,
    specProject: legacyProject,
    specSlug: legacySpec,
    ...taskBody
  } = body;
  const specProject = requestedProject ?? legacyProject;
  const specSlug = requestedSpec ?? legacySpec;
  const id = String(nextId);
  nextId += 1;
  const now = nowIso();
  const task = {
    ...taskBody,
    ...(specProject !== undefined ? { specProject } : {}),
    ...(specSlug !== undefined ? { specSlug } : {}),
    id,
    displayId: `#${id}`,
    subject: body.subject,
    status: body.status || (body.startImmediately ? 'in_progress' : 'pending'),
    reviewState: body.reviewState ?? 'none',
    createdAt: now,
    updatedAt: now,
    requirements,
    blockedBy: body.blockedBy || [],
    blocks: [],
    related: body.related || [],
    comments: body.comments ?? [],
    attachments: body.attachments ?? [],
    historyEvents: body.historyEvents ?? [{
      type: 'task_created', status: body.status || (body.startImmediately ? 'in_progress' : 'pending'),
      timestamp: now, ...(body.createdBy ? { actor: body.createdBy } : {}),
    }],
    workIntervals: body.workIntervals ?? ((body.status === 'in_progress' || body.startImmediately) ? [{ startedAt: now }] : []),
    reviewIntervals: body.reviewIntervals ?? [],
  };
  tasks.push(task);
  return { status: 201, payload: { task: projectTask(task), outcome: 'APPLIED' } };
}

function handleStatus(taskId, body, searchParams) {
  const task = findTask(taskId, searchParams);
  if (!task) {
    return { status: 404, payload: { code: 'TASK_NOT_FOUND', message: `Task not found: ${taskId}` } };
  }
  if (body.expectedStatus !== undefined && body.expectedStatus !== task.status) {
    return {
      status: 409,
      payload: { code: 'STATUS_CONFLICT', currentStatus: task.status, message: 'status conflict' },
    };
  }
  const from = task.status;
  task.status = body.status;
  task.updatedAt = nowIso();
  if (from !== task.status) {
    // RegistryTeamTaskWriter records one status_changed event per transition.
    // A controller transition already sent its event through the execution
    // record patch, so only the status-only path (completeTask) still owes one.
    const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
    const last = events[events.length - 1];
    const recorded = Boolean(
      last && last.type === 'status_changed' && last.from === from && last.to === task.status
    );
    if (!recorded) {
      task.historyEvents = [...events, {
        type: 'status_changed', from, to: task.status, timestamp: task.updatedAt,
        ...(body.actor ? { actor: body.actor } : {}),
      }];
    }
    const intervals = [...(task.workIntervals || [])];
    const open = intervals.length > 0 ? intervals[intervals.length - 1] : undefined;
    if (from !== 'in_progress' && task.status === 'in_progress') {
      if (!open || open.completedAt !== undefined) intervals.push({ startedAt: task.updatedAt });
    } else if (from === 'in_progress' && task.status !== 'in_progress') {
      if (open && open.completedAt === undefined) {
        intervals[intervals.length - 1] = { ...open, completedAt: task.updatedAt };
      }
    }
    task.workIntervals = intervals;
  }
  return {
    status: 200,
    payload: {
      task: projectTask(task),
      transitions: [{
        requestId: String(requests.length),
        from,
        to: task.status,
        actor: body.actor || body.from,
        at: task.updatedAt,
      }],
    },
  };
}

function handlePatch(taskId, body, searchParams) {
  const task = findTask(taskId, searchParams);
  if (!task) {
    return { status: 404, payload: { code: 'TASK_NOT_FOUND', message: `Task not found: ${taskId}` } };
  }
  // Persist the HTTP contract, not controller behavior: dependency checks,
  // notifications and lifecycle mutations must be exercised in the real client.
  if (Object.hasOwn(body, 'owner') && body.owner !== task.owner) {
    if (body.owner !== null && (typeof body.owner !== 'string' || !body.owner.trim())) {
      return { status: 400, payload: { code: 'INVALID_TASK_FIELD', message: 'Invalid task owner' } };
    }
    task.historyEvents = [...(task.historyEvents || []), {
      type: 'owner_changed',
      timestamp: nowIso(),
      ...(task.owner ? { from: task.owner } : {}),
      ...(body.owner ? { to: body.owner } : {}),
      actor: body.actor || 'user',
    }];
  }
  for (const [field, value] of Object.entries(body)) {
    if (field === 'id' || field === 'displayId' || field === 'actor') continue;
    if (value === null) delete task[field];
    else task[field] = value;
  }
  task.updatedAt = nowIso();
  return { status: 200, payload: { task: projectTask(task) } };
}


const server = http.createServer((request, response) => {
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    let body = null;
    if (rawBody) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = null;
      }
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/__log') {
      sendJson(response, 200, { requests });
      return;
    }
    if (url.pathname === '/__fixture/clock' && request.method === 'POST') {
      clockMs = body && Number.isFinite(body.now) ? body.now : undefined;
      sendJson(response, 200, { ok: true });
      return;
    }
    if (url.pathname.startsWith('/__fixture/tasks/')) {
      const taskId = decodeURIComponent(url.pathname.slice('/__fixture/tasks/'.length));
      const index = tasks.findIndex((task) => String(task.id) === taskId);
      if (index < 0) {
        sendJson(response, 404, { error: 'fixture task not found' });
      } else if (request.method === 'PATCH' && body && typeof body === 'object') {
        Object.assign(tasks[index], body);
        sendJson(response, 200, { task: tasks[index] });
      } else if (request.method === 'DELETE') {
        tasks.splice(index, 1);
        sendJson(response, 200, { deleted: true });
      } else {
        sendJson(response, 405, { error: 'method not allowed' });
      }
      return;
    }
    requests.push({
      method: request.method,
      pathname: url.pathname,
      headers: request.headers,
      body,
    });

    if (failStatus) {
      sendJson(response, failStatus, { code: 'REGISTRY_UNAVAILABLE', error: 'registry down' });
      return;
    }

    const match = /^\/api\/teams\/([^/]+)\/tasks(?:\/([^/]+))?(?:\/(status))?$/.exec(url.pathname);
    if (!match) {
      sendJson(response, 404, { error: 'unknown route' });
      return;
    }
    const taskId = match[2] ? decodeURIComponent(match[2]) : undefined;
    const isStatus = Boolean(match[3]);

    if (request.method === 'GET' && !taskId) {
      sendJson(response, 200, {
        tasks: tasks
          .filter((task) => matchesScope(task, url.searchParams))
          .map((task) => projectTask(task)),
      });
      return;
    }
    if (request.method === 'GET' && taskId && !isStatus) {
      const task = findTask(taskId, url.searchParams);
      if (!task) {
        sendJson(response, 404, {
          code: 'TASK_NOT_FOUND',
          message: `Task not found: ${taskId}`,
        });
      } else {
        sendJson(response, 200, { task: projectTask(task) });
      }
      return;
    }
    if (request.method === 'POST' && !taskId) {
      const result = handleCreate(body || {});
      sendJson(response, result.status, result.payload);
      return;
    }
    if (request.method === 'POST' && taskId && isStatus) {
      const result = handleStatus(taskId, body || {}, url.searchParams);
      sendJson(response, result.status, result.payload);
      return;
    }
    if (request.method === 'PATCH' && taskId) {
      const result = handlePatch(taskId, body || {}, url.searchParams);
      sendJson(response, result.status, result.payload);
      return;
    }
    sendJson(response, 405, { error: 'method not allowed' });
  });
});

server.listen(0, '127.0.0.1', () => {
  parentPort.postMessage({ port: server.address().port });
});

parentPort.on('message', (message) => {
  if (message === 'close') server.close(() => process.exit(0));
});
