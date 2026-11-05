const { bindReadOnlyTaskSnapshot } = require('./taskBackendSelection.js');
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
  // The snapshot is carried only by this controller's paths object; it is neither
  // cached globally nor used as a fallback when canonical registry access is absent.
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
