/**
 * Chooses the task backend for one team.
 *
 * Only an app-owned MCP child may talk to the app: the registry backend needs
 * the `AGENT_TEAMS_BOUND_CONTROL_URL` binding the desktop app injects. Any other
 * process — including the app's own main process — keeps the file store, so a
 * task read can never recurse into an HTTP call to the caller itself.
 *
 * A team opts into the registry through its own config: `specProject` (with
 * `specSlug`, which the app validates) is the only switch. A team without it
 * keeps the legacy file behaviour byte-for-byte.
 *
 * The choice is made once per team directory: re-reading the environment or the
 * config on every task read would let a live child be retargeted mid-flight.
 */

const path = require('path');

const desktopControlBinding = require('./desktopControlBinding.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const { createRegistryTaskBackend } = require('./registryTaskBackend.js');

const RESOLVED_BACKENDS = new Map();

function readSpecProject(paths) {
  if (!paths || typeof paths.teamDir !== 'string' || !paths.teamDir.trim()) return '';
  let config;
  try {
    config = runtimeHelpers.readTeamConfig(paths);
  } catch {
    // A corrupt config is reported by the config reader; the task store must not
    // turn that into a silently "registry-backed" team.
    return '';
  }
  if (!config || typeof config !== 'object') return '';
  return typeof config.specProject === 'string' ? config.specProject.trim() : '';
}

function buildBackend(paths) {
  const binding = desktopControlBinding.readBindingFromEnvironment();
  if (!binding) return null;
  const specProject = readSpecProject(paths);
  if (!specProject) return null;
  return createRegistryTaskBackend({
    teamName: path.basename(paths.teamDir),
    baseUrl: binding.controlUrl,
    headers: binding.headers,
    specProject,
  });
}

/**
 * @returns {object|null} a registry backend, or `null` for the file store.
 */
function resolveTaskBackend(paths) {
  if (!paths || typeof paths.tasksDir !== 'string' || !paths.tasksDir.trim()) {
    return null;
  }
  const cacheKey = path.resolve(paths.tasksDir);
  if (RESOLVED_BACKENDS.has(cacheKey)) {
    return RESOLVED_BACKENDS.get(cacheKey);
  }
  const backend = buildBackend(paths);
  RESOLVED_BACKENDS.set(cacheKey, backend);
  return backend;
}

/** Test hook: forget resolved backends so env/config changes are observable. */
function resetTaskBackendCache() {
  RESOLVED_BACKENDS.clear();
}

module.exports = {
  resetTaskBackendCache,
  resolveTaskBackend,
};
