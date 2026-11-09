/**
 * HTTP client for the desktop app's team task and spec-binding endpoints.
 *
 * The controller process never holds the spec-registry token: canonical task
 * reads and writes go through the app that owns it. Every failure is typed and
 * there is no local fallback — a caller cannot mistake "the app is unreachable"
 * for "the board is empty".
 *
 * Contract (fixed, owned by the app's Fastify routes):
 *
 *   GET   /api/team-runtime/spec-bindings (Bearer runtime capability) -> { bindings }
 *   PUT   /api/team-runtime/spec-bindings { project, spec } -> { bindings }
 *   GET   /api/teams/:teamName/tasks?includeDeleted=true&project=...&spec=... -> { tasks }
 *   GET   /api/teams/:teamName/tasks/:taskId?project=...&spec=...              -> { task }
 *   POST  /api/teams/:teamName/tasks { ..., project, spec }                   -> { task, outcome }
 *   POST  /api/teams/:teamName/tasks/:taskId/status?project=...&spec=...      -> { task, transitions }
 *   PATCH /api/teams/:teamName/tasks/:taskId?project=...&spec=...             -> { task }
 *   GET   /api/teams/:teamName/tasks/:taskId/artifact/:attachmentId           -> verified artifact envelope
 */

const { DEFAULT_TIMEOUT_MS, syncControlRequest } = require('./syncControlRequest.js');
const { TASK_BACKEND_ERROR_CODES, TaskBackendError } = require('./taskBackendErrors.js');

const CONTROL_URL_ENV = 'AGENT_TEAMS_BOUND_CONTROL_URL';
const MCP_SCOPE_CREDENTIAL_ENV = 'AGENT_TEAMS_MCP_SCOPE_CREDENTIAL';

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

function readTaskArtifactEnvelope(payload, operation) {
  const keys = ['filename', 'mimeType', 'size', 'sha256', 'base64Data'];
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(payload, key)) ||
    typeof payload.filename !== 'string' ||
    !payload.filename.trim() ||
    typeof payload.mimeType !== 'string' ||
    !payload.mimeType.trim() ||
    !Number.isSafeInteger(payload.size) ||
    payload.size < 0 ||
    typeof payload.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(payload.sha256) ||
    typeof payload.base64Data !== 'string'
  ) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.REGISTRY_PROTOCOL_ERROR,
      `Team control API ${operation} returned an invalid artifact envelope.`,
      { operation }
    );
  }
  return {
    filename: payload.filename,
    mimeType: payload.mimeType,
    size: payload.size,
    sha256: payload.sha256,
    base64Data: payload.base64Data,
  };
}

function readSpecBindingsEnvelope(payload, operation) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.bindings)) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.REGISTRY_PROTOCOL_ERROR,
      `Team control API ${operation} returned no spec bindings array.`,
      { operation }
    );
  }
  return payload.bindings.map((binding) => {
    if (
      !binding ||
      typeof binding !== 'object' ||
      typeof binding.project !== 'string' ||
      !binding.project.trim() ||
      typeof binding.spec !== 'string' ||
      !binding.spec.trim()
    ) {
      throw new TaskBackendError(
        TASK_BACKEND_ERROR_CODES.REGISTRY_PROTOCOL_ERROR,
        `Team control API ${operation} returned an invalid spec binding.`,
        { operation }
      );
    }
    return { project: binding.project, spec: binding.spec };
  });
}

function normalizeSpecBinding(binding) {
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    throw new TypeError('Spec binding requires project and spec');
  }
  if (Object.keys(binding).some((key) => key !== 'project' && key !== 'spec')) {
    throw new TypeError('Spec binding accepts only project and spec');
  }
  const project = typeof binding.project === 'string' ? binding.project.trim() : '';
  const spec = typeof binding.spec === 'string' ? binding.spec.trim() : '';
  if (!project || !spec) {
    throw new Error('Spec binding requires both project and spec');
  }
  return { project, spec };
}


function normalizeTaskScope(scope) {
  if (scope === undefined || scope === null) return null;
  if (typeof scope !== 'object' || Array.isArray(scope)) {
    throw new TypeError('Task scope must contain project and spec');
  }
  const project = typeof scope.project === 'string' ? scope.project.trim() : '';
  const spec = typeof scope.spec === 'string' ? scope.spec.trim() : '';
  if (!project && !spec) return null;
  if (!project || !spec) throw new Error('Task scope requires both project and spec');
  return { project, spec };
}

function appendTaskScope(pathname, scope) {
  const normalized = normalizeTaskScope(scope);
  if (!normalized) return pathname;
  const separator = pathname.includes('?') ? '&' : '?';
  return `${pathname}${separator}project=${encodeURIComponent(normalized.project)}&spec=${encodeURIComponent(normalized.spec)}`;
}

function taskPath(teamPath, taskId, scope) {
  return appendTaskScope(`${teamPath}/${encodeURIComponent(String(taskId))}`, scope);
}

function taskListPath(teamPath, scope) {
  return appendTaskScope(`${teamPath}?includeDeleted=true`, scope);
}

function taskStatusPath(teamPath, taskId, scope) {
  return appendTaskScope(`${teamPath}/${encodeURIComponent(String(taskId))}/status`, scope);
}

function taskArtifactPath(teamPath, taskId, attachmentId) {
  return `${teamPath}/${encodeURIComponent(String(taskId))}/artifact/${encodeURIComponent(
    String(attachmentId)
  )}`;
}

function createTaskRequest(input, scope) {
  const {
    project: inputProject,
    spec: inputSpec,
    specProject: inputSpecProject,
    specSlug: inputSpecSlug,
    ...body
  } = input;
  const hasInputScope =
    inputProject !== undefined ||
    inputSpec !== undefined ||
    inputSpecProject !== undefined ||
    inputSpecSlug !== undefined;
  const normalized = normalizeTaskScope(
    scope ??
      (hasInputScope
        ? {
            project: inputProject ?? inputSpecProject,
            spec: inputSpec ?? inputSpecSlug,
          }
        : undefined)
  );
  return normalized
    ? { ...body, project: normalized.project, spec: normalized.spec }
    : body;
}


function createControlApiSender(options = {}) {
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
    if (!response.ok) throw toFailure(operation, response.status, payload);
    if (payload === null) {
      throw new TaskBackendError(
        TASK_BACKEND_ERROR_CODES.REGISTRY_PROTOCOL_ERROR,
        `Team control API returned an empty or non-JSON body for ${operation}.`,
        { operation }
      );
    }
    return payload;
  }

  return { baseUrl, send };
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
  const { baseUrl, send } = createControlApiSender(options);
  const teamPath = `/api/teams/${encodeURIComponent(teamName)}/tasks`;

  return {
    baseUrl,
    teamName,


    listTasks(scope) {
      return readTasksEnvelope(
        send('listTasks', 'GET', taskListPath(teamPath, scope)),
        'listTasks'
      );
    },

    getTask(taskId, scope) {
      return readTaskEnvelope(
        send('getTask', 'GET', taskPath(teamPath, taskId, scope)),
        'getTask'
      );
    },

    createTask(input, scope) {
      return readTaskEnvelope(
        send('createTask', 'POST', teamPath, createTaskRequest(input, scope)),
        'createTask'
      );
    },

    createTaskWithOutcome(input, scope) {
      const payload = send('createTask', 'POST', teamPath, createTaskRequest(input, scope));
      const task = readTaskEnvelope(payload, 'createTask');
      if (payload.outcome !== 'APPLIED' && payload.outcome !== 'REPLAY') {
        throw new TaskBackendError(
          TASK_BACKEND_ERROR_CODES.REGISTRY_PROTOCOL_ERROR,
          'Team control API createTask returned no valid creation outcome.'
        );
      }
      return { task, outcome: payload.outcome };
    },

    setTaskStatus(taskId, input, scope) {
      return readTaskEnvelope(
        send('setTaskStatus', 'POST', taskStatusPath(teamPath, taskId, scope), input),
        'setTaskStatus'
      );
    },

    patchTask(taskId, patch, scope) {
      return readTaskEnvelope(
        send('patchTask', 'PATCH', taskPath(teamPath, taskId, scope), patch),
        'patchTask'
      );
    },

    readTaskArtifactData(taskId, attachmentId) {
      const operation = 'readTaskArtifactData';
      try {
        return readTaskArtifactEnvelope(
          send(operation, 'GET', taskArtifactPath(teamPath, taskId, attachmentId)),
          operation
        );
      } catch (error) {
        if (error instanceof TaskBackendError && error.status === 404) return null;
        throw error;
      }
    },
  };
}
function createTeamSpecBindingClient(options = {}) {
  const scopeCredential = String(options.scopeCredential || '').trim();
  if (!scopeCredential || scopeCredential.length > 512) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.APP_BINDING_REQUIRED,
      `Team spec bindings require ${MCP_SCOPE_CREDENTIAL_ENV}.`
    );
  }
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).filter(([name]) => name.toLowerCase() !== 'authorization')
  );
  const { baseUrl, send } = createControlApiSender({
    ...options,
    headers: { ...headers, authorization: `Bearer ${scopeCredential}` },
  });
  const specBindingsPath = '/api/team-runtime/spec-bindings';
  return {
    baseUrl,
    listTeamSpecBindings() {
      return readSpecBindingsEnvelope(
        send('listTeamSpecBindings', 'GET', specBindingsPath),
        'listTeamSpecBindings'
      );
    },
    linkTeamSpec(binding) {
      const normalizedBinding = normalizeSpecBinding(binding);
      return readSpecBindingsEnvelope(
        send('linkTeamSpec', 'PUT', specBindingsPath, normalizedBinding),
        'linkTeamSpec'
      );
    },
  };
}


module.exports = {
  createRegistryTaskClient,
  createTeamSpecBindingClient,
};
