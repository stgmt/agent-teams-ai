/** Canonical tasks use the desktop app API unless an operation supplies a read-only snapshot. */
const path = require('path');
const desktopControlBinding = require('./desktopControlBinding.js');
const { createRegistryTaskBackend } = require('./registryTaskBackend.js');
const { TaskBackendError, TASK_BACKEND_ERROR_CODES } = require('./taskBackendErrors.js');

const RESOLVED_BACKENDS = new Map();
const READ_ONLY_TASK_BACKEND = Symbol('readOnlyTaskBackend');

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
  bindReadOnlyTaskSnapshot,
  isReadOnlyTaskSnapshot,
  resetTaskBackendCache,
  resolveTaskBackend,
};
