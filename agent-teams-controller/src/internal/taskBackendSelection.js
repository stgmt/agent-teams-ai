/** Canonical tasks use the desktop app API unless an operation supplies a read-only snapshot. */
const path = require('path');
const desktopControlBinding = require('./desktopControlBinding.js');
const { createRegistryTaskBackend } = require('./registryTaskBackend.js');
const { TaskBackendError, TASK_BACKEND_ERROR_CODES } = require('./taskBackendErrors.js');

const { createLocalTaskBackend } = require('./localTaskBackend.js');
const RESOLVED_BACKENDS = new Map();
const READ_ONLY_TASK_BACKEND = Symbol('readOnlyTaskBackend');

const LOCAL_TASK_BACKEND = Symbol('localTaskBackend');

function bindLocalTaskBoard(paths, teamName) {
  if (
    !paths ||
    typeof paths.teamDir !== 'string' ||
    !paths.teamDir.trim() ||
    typeof paths.claudeDir !== 'string' ||
    !paths.claudeDir.trim()
  ) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.APP_BINDING_REQUIRED,
      'A local task board requires a team directory and Claude data directory'
    );
  }
  if (paths[READ_ONLY_TASK_BACKEND]) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.READ_ONLY_TASK_SNAPSHOT,
      'A controller cannot use both a local task board and a read-only task snapshot'
    );
  }
  const normalizedTeamName = String(teamName || '').trim();
  const expectedTeamDir = path.join(path.resolve(paths.claudeDir), 'teams', normalizedTeamName);
  if (
    !normalizedTeamName ||
    path.resolve(paths.teamDir) !== expectedTeamDir
  ) {
    throw new TaskBackendError(
      'APP_CONTEXT_MISMATCH',
      'Local task board team directory does not match its controller context'
    );
  }
  if (desktopControlBinding.readBindingFromEnvironment()) {
    throw new TaskBackendError(
      'APP_CONTEXT_MISMATCH',
      'A bound desktop controller cannot select the local task board'
    );
  }
  Object.defineProperty(paths, LOCAL_TASK_BACKEND, {
    value: createLocalTaskBackend({ claudeDir: paths.claudeDir, teamName: normalizedTeamName }),
  });
}

function bindReadOnlyTaskSnapshot(paths, tasks) {
  if (!paths || typeof paths.teamDir !== 'string' || !paths.teamDir.trim()) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.APP_BINDING_REQUIRED,
      'A read-only task snapshot requires a team directory'
    );
  }
  if (!Array.isArray(tasks)) {
    throw new TypeError('readOnlyTaskSnapshot must be an array');
  }
  Object.defineProperty(paths, READ_ONLY_TASK_BACKEND, {
    value: createRegistryTaskBackend({
      teamName: path.basename(path.resolve(paths.teamDir)),
      readOnlyTasks: tasks,
    }),
  });
}

function isReadOnlyTaskSnapshot(paths) {
  return Boolean(paths && paths[READ_ONLY_TASK_BACKEND]);
}

function isLocalTaskBoard(paths) {
  return Boolean(paths && paths[LOCAL_TASK_BACKEND]);
}

function resolveTaskBackend(paths) {
  if (!paths || typeof paths.teamDir !== 'string' || !paths.teamDir.trim()) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.APP_BINDING_REQUIRED,
      'Canonical task operations require a team directory and a desktop app binding'
    );
  }
  const cacheKey = path.resolve(paths.teamDir);
  const readOnlyBackend = paths[READ_ONLY_TASK_BACKEND];
  if (readOnlyBackend) return readOnlyBackend;
  const localBackend = paths[LOCAL_TASK_BACKEND];
  if (localBackend) {
    const binding = desktopControlBinding.readBindingFromEnvironment();
    if (binding) {
      throw new TaskBackendError(
        'APP_CONTEXT_MISMATCH',
        'A bound desktop controller cannot use the local task board'
      );
    }
    const localTeamRoot = path.join(path.resolve(paths.claudeDir), 'teams');
    if (
      path.dirname(cacheKey) !== localTeamRoot ||
      localBackend.teamName !== path.basename(cacheKey)
    ) {
      throw new TaskBackendError(
        'APP_CONTEXT_MISMATCH',
        'Local task board team directory differs from its controller context'
      );
    }
    return localBackend;
  }
  const binding = desktopControlBinding.readBindingFromEnvironment();
  if (!binding) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.APP_BINDING_REQUIRED,
      'Canonical task operations require the desktop app-bound control URL and context'
    );
  }
  const expectedTeamRoot = path.join(binding.claudeDir, 'teams');
  if (path.dirname(cacheKey) !== expectedTeamRoot) {
    throw new TaskBackendError(
      'APP_CONTEXT_MISMATCH',
      'Task team directory differs from the desktop app binding'
    );
  }
  const fingerprint = JSON.stringify([binding.controlUrl, binding.headers]);
  const cached = RESOLVED_BACKENDS.get(cacheKey);
  if (cached) {
    if (cached.fingerprint !== fingerprint) {
      throw new TaskBackendError('APP_CONTEXT_MISMATCH', 'Desktop app binding changed for this team');
    }
    return cached.backend;
  }
  // The app validates required specProject/specSlug; no child-side opt-in or file read.
  const backend = createRegistryTaskBackend({
    teamName: path.basename(cacheKey),
    baseUrl: binding.controlUrl,
    headers: binding.headers,
  });
  RESOLVED_BACKENDS.set(cacheKey, { fingerprint, backend });
  return backend;
}

/** Test hook: forget clients so a new test binding can be installed. */
function resetTaskBackendCache() {
  RESOLVED_BACKENDS.clear();
}

module.exports = {
  bindLocalTaskBoard,
  bindReadOnlyTaskSnapshot,
  isLocalTaskBoard,
  isReadOnlyTaskSnapshot,
  resetTaskBackendCache,
  resolveTaskBackend,
};
