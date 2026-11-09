const desktopControlBinding = require('./desktopControlBinding.js');
const { createTeamSpecBindingClient } = require('./taskRegistryClient.js');
const { TASK_BACKEND_ERROR_CODES, TaskBackendError } = require('./taskBackendErrors.js');

const MCP_SCOPE_CREDENTIAL_ENV = 'AGENT_TEAMS_MCP_SCOPE_CREDENTIAL';

function scopedClient(scopeCredential = process.env[MCP_SCOPE_CREDENTIAL_ENV]) {
  const binding = desktopControlBinding.readBindingFromEnvironment();
  if (!binding) {
    throw new TaskBackendError(
      TASK_BACKEND_ERROR_CODES.APP_BINDING_REQUIRED,
      'Team spec binding operations require an app-owned team runtime capability.'
    );
  }
  return createTeamSpecBindingClient({
    baseUrl: binding.controlUrl,
    headers: binding.headers,
    scopeCredential,
  });
}

function listTeamSpecBindings(scopeCredential) {
  return scopedClient(scopeCredential).listTeamSpecBindings();
}

function linkTeamSpec(_context, binding, scopeCredential) {
  return scopedClient(scopeCredential).linkTeamSpec(binding);
}

module.exports = {
  linkTeamSpec,
  listTeamSpecBindings,
};
