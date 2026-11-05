/**
 * HTTP client for the desktop app's team task endpoints.
 *
 * The controller process never holds the spec-registry token: canonical task
 * reads and writes go through the app that owns it. Every failure is typed and
 * there is no local fallback — a caller cannot mistake "the app is unreachable"
 * for "the board is empty".
 *
 * Contract (fixed, owned by the app's Fastify routes):
 *
 *   GET   /api/teams/:teamName/tasks?includeDeleted=true -> { tasks }
 *   POST  /api/teams/:teamName/tasks                 -> { task, outcome }
 *   POST  /api/teams/:teamName/tasks/:taskId/status  -> { task, transitions }
 *   PATCH /api/teams/:teamName/tasks/:taskId         -> { task }
 */

const { DEFAULT_TIMEOUT_MS, syncControlRequest } = require('./syncControlRequest.js');
const { TASK_BACKEND_ERROR_CODES, TaskBackendError } = require('./taskBackendErrors.js');

const CONTROL_URL_ENV = 'AGENT_TEAMS_BOUND_CONTROL_URL';

function normalizeBaseUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.REGISTRY_UNAVAILABLE,
      `Team control API URL "${trimmed}" is not a valid URL.`
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.REGISTRY_UNAVAILABLE,
      `Team control API URL "${trimmed}" is not an HTTP endpoint.`
    );
  }
  if (parsed.search || parsed.hash || parsed.username || parsed.password) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.REGISTRY_UNAVAILABLE,
      'Team control API URL must be a bare origin without credentials, query or fragment.'
    );
  }
  const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${pathname}`;
}

/** Resolve the app-bound URL; legacy discovery is not a canonical task source. */
function resolveControlBaseUrl(explicitBaseUrl) {
  const baseUrl = normalizeBaseUrl(explicitBaseUrl ?? process.env[CONTROL_URL_ENV]);
  if (baseUrl) return baseUrl;
  throw new TaskBackendError(
    TASK_BACKEND_ERROR_CODES.APP_BINDING_REQUIRED,
    `Canonical task operations require ${CONTROL_URL_ENV}.`
  );
}

function describeFailure(status, payload) {
  if (payload && typeof payload === 'object') {
    if (typeof payload.error === 'string' && payload.error.trim()) return payload.error.trim();
    if (typeof payload.message === 'string' && payload.message.trim()) return payload.message.trim();
  }
  return `Team control API answered ${status}`;
}

function parseJsonBody(body) {
  if (typeof body !== 'string' || !body.trim()) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function readStatusCode(payload) {
  if (payload && typeof payload === 'object' && typeof payload.code === 'string') {
    return payload.code;
  }
  return '';
}

function toFailure(operation, status, payload) {
  const message = describeFailure(status, payload);
  const code = readStatusCode(payload);
  if (status === 409 && code === 'STATUS_CONFLICT') {
    return new TaskBackendError(TASK_BACKEND_ERROR_CODES.STATUS_CONFLICT, message, {
      status,
      operation,
      currentStatus:
        typeof payload.currentStatus === 'string' ? payload.currentStatus : undefined,
    });
  }
  if (status === 400 && code === 'REQUIREMENTS_REQUIRED') {
    return new TaskBackendError(TASK_BACKEND_ERROR_CODES.REQUIREMENTS_REQUIRED, message, {
      status,
      operation,
    });
  }
  if (status === 404) {
    return new TaskBackendError(TASK_BACKEND_ERROR_CODES.TASK_NOT_FOUND, message, {
      status,
      operation,
    });
  }
  if (status === 503 || status >= 500) {
    return new TaskBackendError(TASK_BACKEND_ERROR_CODES.REGISTRY_UNAVAILABLE, message, {
      status,
      operation,
      httpStatus: status,
    });
  }
  return new TaskBackendError(code || TASK_BACKEND_ERROR_CODES.REQUEST_REJECTED, message, {
    status,
    operation,
    serverCode: code || undefined,
  });
}

function readTaskEnvelope(payload, operation) {
  if (!payload || typeof payload !== 'object' || !payload.task) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.REGISTRY_PROTOCOL_ERROR,
      `Team control API ${operation} returned no task envelope.`,
      { operation }
    );
  }
  return payload.task;
}

function readTasksEnvelope(payload, operation) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.tasks)) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.REGISTRY_PROTOCOL_ERROR,
      `Team control API ${operation} returned no tasks array.`,
      { operation }
    );
  }
  return payload.tasks;
}

/**
 * @param {object} options
 * @param {string} options.teamName
 * @param {string} [options.baseUrl] - defaults to the bound control URL
 * @param {Record<string,string>} [options.headers] - e.g. `x-agent-teams-app-context`
 * @param {number} [options.timeoutMs]
 * @param {(request: object) => {status:number, ok:boolean, body:string}} [options.request]
 */
function createRegistryTaskClient(options = {}) {
  const teamName = String(options.teamName || '').trim();
  if (!teamName) {
    throw new Error('Missing teamName');
  }
  const baseUrl = resolveControlBaseUrl(options.baseUrl);
  const headers = Object.freeze({
    accept: 'application/json',
    ...(options.headers || {}),
  });
  const timeoutMs =
    Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
      ? Math.floor(options.timeoutMs)
      : DEFAULT_TIMEOUT_MS;
  const request = typeof options.request === 'function' ? options.request : syncControlRequest;
  const teamPath = `/api/teams/${encodeURIComponent(teamName)}/tasks`;

  function send(operation, method, pathname, body) {
    const payloadBody = body === undefined ? undefined : JSON.stringify(body);
    let response;
    try {
      response = request({
        url: `${baseUrl}${pathname}`,
        method,
        timeoutMs,
        headers: {
          ...headers,
          ...(payloadBody === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payloadBody === undefined ? {} : { body: payloadBody }),
      });
    } catch (error) {
      if (error instanceof TaskBackendError) throw error;
      throw new TaskBackendError(
        TASK_BACKEND_ERROR_CODES.REGISTRY_UNAVAILABLE,
        `Team control API is unreachable for ${operation}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { operation, cause: error }
      );
    }

    const payload = parseJsonBody(response.body);
    if (!response.ok) {
      throw toFailure(operation, response.status, payload);
    }
    if (payload === null) {
      throw new TaskBackendError(
        TASK_BACKEND_ERROR_CODES.REGISTRY_PROTOCOL_ERROR,
        `Team control API returned an empty or non-JSON body for ${operation}.`,
        { operation }
      );
    }
    return payload;
  }

  return {
    baseUrl,
    teamName,

    listTasks() {
      return readTasksEnvelope(send('listTasks', 'GET', `${teamPath}?includeDeleted=true`), 'listTasks');
    },

    createTask(input) {
      return readTaskEnvelope(send('createTask', 'POST', teamPath, input), 'createTask');
    },

    createTaskWithOutcome(input) {
      const payload = send('createTask', 'POST', teamPath, input);
      const task = readTaskEnvelope(payload, 'createTask');
      if (payload.outcome !== 'APPLIED' && payload.outcome !== 'REPLAY') {
        throw new TaskBackendError(
          TASK_BACKEND_ERROR_CODES.REGISTRY_PROTOCOL_ERROR,
          'Team control API createTask returned no valid creation outcome.'
        );
      }
      return { task, outcome: payload.outcome };
    },

    setTaskStatus(taskId, input) {
      const taskPath = `${teamPath}/${encodeURIComponent(String(taskId))}/status`;
      return readTaskEnvelope(send('setTaskStatus', 'POST', taskPath, input), 'setTaskStatus');
    },

    patchTask(taskId, patch) {
      const taskPath = `${teamPath}/${encodeURIComponent(String(taskId))}`;
      return readTaskEnvelope(send('patchTask', 'PATCH', taskPath, patch), 'patchTask');
    },
  };
}

module.exports = {
  createRegistryTaskClient,
};
