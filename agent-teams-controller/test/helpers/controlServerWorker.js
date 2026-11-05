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
  return projected;
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function findTask(taskId) {
  return tasks.find((task) => String(task.id) === String(taskId));
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
      return { status: 200, payload: { task: existing, outcome: 'REPLAY' } };
    }
  }
  const id = String(nextId);
  nextId += 1;
  const now = nowIso();
  const task = {
    ...body,
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
  return { status: 200, payload: { task, outcome: 'APPLIED' } };
}

function handleStatus(taskId, body) {
  const task = findTask(taskId);
  if (!task) return { status: 404, payload: { error: `Task not found: ${taskId}` } };
  if (body.expectedStatus !== undefined && body.expectedStatus !== task.status) {
    return {
      status: 409,
      payload: { code: 'STATUS_CONFLICT', currentStatus: task.status, error: 'status conflict' },
    };
  }
  const from = task.status;
  task.status = body.status;
  task.updatedAt = nowIso();
  if (from !== task.status && task.status === 'deleted') task.deletedAt = task.updatedAt;
  else if (from === 'deleted' && task.status !== 'deleted') delete task.deletedAt;
  if (from !== task.status) {
    task.historyEvents = [...(task.historyEvents || []), {
      type: 'status_changed', from, to: task.status, timestamp: task.updatedAt,
      ...(body.actor ? { actor: body.actor } : {}),
    }];
    const intervals = [...(task.workIntervals || [])];
    if (from === 'in_progress' && intervals.length && !intervals[intervals.length - 1].completedAt) {
      intervals[intervals.length - 1] = { ...intervals[intervals.length - 1], completedAt: task.updatedAt };
    }
    if (task.status === 'in_progress') intervals.push({ startedAt: task.updatedAt });
    task.workIntervals = intervals;
  }
  return {
    status: 200,
    payload: {
      task,
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

function handlePatch(taskId, body) {
  const task = findTask(taskId);
  if (!task) return { status: 404, payload: { error: `Task not found: ${taskId}` } };
  // Persist the HTTP contract, not controller behavior: dependency checks,
  // notifications and lifecycle mutations must be exercised in the real client.
  if (Object.hasOwn(body, 'owner') && body.owner !== task.owner) {
    if (body.owner !== null && (typeof body.owner !== 'string' || !body.owner.trim())) {
      return { status: 400, payload: { code: 'INVALID_TASK_FIELD', error: 'Invalid task owner' } };
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
  return { status: 200, payload: { task } };
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
        tasks: tasks.map((task) => projectTask({
          ...task,
          blocks: tasks.filter((candidate) =>
            Array.isArray(candidate.blockedBy) && candidate.blockedBy.includes(task.id)
          ).map((candidate) => candidate.id),
        })),
      });
      return;
    }
    if (request.method === 'POST' && !taskId) {
      const result = handleCreate(body || {});
      sendJson(response, result.status, result.payload);
      return;
    }
    if (request.method === 'POST' && taskId && isStatus) {
      const result = handleStatus(taskId, body || {});
      sendJson(response, result.status, result.payload);
      return;
    }
    if (request.method === 'PATCH' && taskId) {
      const result = handlePatch(taskId, body || {});
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
