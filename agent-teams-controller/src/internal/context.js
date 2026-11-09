const { bindLocalTaskBoard, bindReadOnlyTaskSnapshot } = require('./taskBackendSelection.js');
const runtimeHelpers = require('./runtimeHelpers.js');

function createControllerContext(options = {}) {
  const teamName = String(options.teamName || '').trim();
  if (!teamName) {
    throw new Error('Missing teamName');
  }

  const flags = {};
  if (typeof options.claudeDir === 'string' && options.claudeDir.trim()) {
    flags['claude-dir'] = options.claudeDir.trim();
  }

  const paths = runtimeHelpers.getPaths(flags, teamName);
  if (options.localTaskBoard !== undefined && options.localTaskBoard !== true) {
    throw new TypeError('localTaskBoard must be true when supplied');
  }
  if (options.localTaskBoard === true && options.readOnlyTaskSnapshot !== undefined) {
    throw new TypeError('A controller cannot use both a local task board and a read-only task snapshot');
  }
  if (options.localTaskBoard === true) {
    bindLocalTaskBoard(paths, teamName);
  }
  // A detached snapshot is carried only by this controller's paths object; it
  // is never a fallback when canonical registry access is absent.
  if (options.readOnlyTaskSnapshot !== undefined) {
    bindReadOnlyTaskSnapshot(paths, options.readOnlyTaskSnapshot);
  }
  return {
    teamName,
    claudeDir: paths.claudeDir,
    paths,
    allowUserMessageSender: options.allowUserMessageSender !== false,
  };
}

module.exports = {
  createControllerContext,
};
