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
  const id = String(nextId);
  nextId += 1;
  const task = {
    id,
    displayId: `#${id}`,
    subject: body.subject,
    status: 'pending',
    requirements,
    ...(body.description ? { description: body.description } : {}),
    ...(body.owner ? { owner: body.owner } : {}),
  };
  tasks.push(task);
  return { status: 200, payload: { task, outcome: 'APPLIED' } };
}

function handleStatus(taskId, body) {
  const task = findTask(taskId);
  if (!task) return { status: 404, payload: { error: `Task not found: ${taskId}` } };
  if (body.status === 'deleted') {
    return { status: 400, payload: { code: 'STATUS_UNSUPPORTED', error: 'deleted unsupported' } };
  }
  if (body.expectedStatus !== undefined && body.expectedStatus !== task.status) {
    return {
      status: 409,
      payload: { code: 'STATUS_CONFLICT', currentStatus: task.status, error: 'status conflict' },
    };
  }
  task.status = body.status;
  return { status: 200, payload: { task, transitions: [] } };
}

function handlePatch(taskId, body) {
  const task = findTask(taskId);
  if (!task) return { status: 404, payload: { error: `Task not found: ${taskId}` } };
  for (const field of ['subject', 'description', 'owner', 'blockedBy', 'related']) {
    if (body[field] !== undefined) {
      task[field] = body[field];
    }
  }
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
      sendJson(response, 200, { tasks });
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
