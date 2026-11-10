'use strict';

const { randomUUID } = require('node:crypto');

/**
 * Schema-driven policy for the specification registry surface.
 *
 * The registry owns the tools and their argument schemas. This module adds only
 * what a team needs: scope validation, unambiguous-scope fill, team-id stamping
 * and removal of transport-specific fields. Every injected field is checked
 * against the tool's published `inputSchema.properties`, because sending a field
 * a tool does not declare is refused with UNKNOWN_FIELD.
 */

const SPEC_SCOPE_ERROR_CODES = Object.freeze({
  NOT_LINKED: 'TEAM_SPEC_NOT_LINKED',
  INVALID_SCOPE: 'INVALID_TASK_SCOPE',
});

class SpecScopeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SpecScopeError';
    this.code = code;
  }
}

function acceptedFields(descriptor) {
  const properties = descriptor?.inputSchema?.properties;
  if (!properties || typeof properties !== 'object') return new Set();
  return new Set(Object.keys(properties));
}

function matchesBinding(bindings, project, spec) {
  return bindings.some((binding) => binding.project === project && binding.spec === spec);
}

function applyTeamSpecScope(name, args, scope, descriptor, newRequestId = randomUUID) {
  const accepts = acceptedFields(descriptor);
  const scoped = { ...args };
  delete scoped.declaredWorktree;

  if (accepts.has('requestId') && (typeof scoped.requestId !== 'string' || !scoped.requestId.trim())) {
    scoped.requestId = newRequestId();
  }

  const acceptsProject = accepts.has('project');
  const acceptsSpec = accepts.has('spec');
  const rawProject = typeof scoped.project === 'string' ? scoped.project.trim() : '';
  const rawSpec = typeof scoped.spec === 'string' ? scoped.spec.trim() : '';

  if (rawProject || rawSpec) {
    if ((rawProject && !acceptsProject) || (rawSpec && !acceptsSpec)) {
      throw new SpecScopeError(
        SPEC_SCOPE_ERROR_CODES.INVALID_SCOPE,
        `${name} does not accept the supplied scope fields`
      );
    }
    // A bound project is the unit of trust: any specification inside it is
    // reachable, including one the team just created (owner decision A).
    if (rawProject && rawSpec) {
      if (!scope.bindings.some((binding) => binding.project === rawProject)) {
        throw new SpecScopeError(
          SPEC_SCOPE_ERROR_CODES.NOT_LINKED,
          `${rawProject} is not bound to this team`
        );
      }
    } else if (rawProject) {
      if (!scope.bindings.some((binding) => binding.project === rawProject)) {
        throw new SpecScopeError(
          SPEC_SCOPE_ERROR_CODES.NOT_LINKED,
          `${rawProject} is not bound to this team`
        );
      }
    } else {
      const candidates = scope.bindings.filter((binding) => binding.spec === rawSpec);
      if (candidates.length === 0) {
        throw new SpecScopeError(
          SPEC_SCOPE_ERROR_CODES.NOT_LINKED,
          `${rawSpec} is not bound to this team`
        );
      }
      if (candidates.length > 1 && acceptsProject) {
        throw new SpecScopeError(
          SPEC_SCOPE_ERROR_CODES.INVALID_SCOPE,
          `${name} needs an explicit project: ${rawSpec} is bound in more than one project`
        );
      }
      if (candidates.length === 1 && acceptsProject && !scoped.project) {
        scoped.project = candidates[0].project;
      }
    }
  } else if (scope.bindings.length === 1) {
    const [binding] = scope.bindings;
    if (acceptsProject) scoped.project = binding.project;
    if (acceptsSpec) scoped.spec = binding.spec;
  }

  if (scope.teamId && accepts.has('teamId') && (scoped.teamId === undefined || scoped.teamId === null)) {
    scoped.teamId = scope.teamId;
  }

  if (Array.isArray(scoped.operations) && accepts.has('operations') && scope.teamId) {
    scoped.operations = scoped.operations.map((operation) => {
      if (!operation || typeof operation !== 'object') return operation;
      return operation.teamId === undefined || operation.teamId === null
        ? { ...operation, teamId: scope.teamId }
        : operation;
    });
  }

  return scoped;
}

function refusalEnvelope(code, message) {
  return {
    schemaVersion: null,
    requestId: null,
    operation: null,
    ok: false,
    page: null,
    data: null,
    error: {
      code,
      message,
      retryable: false,
      parameter: null,
      expected: null,
      currentStatus: null,
      expectedStatus: null,
      localId: null,
      canonicalId: null,
      causeCode: null,
    },
    diagnostics: [],
    provenance: null,
  };
}

function readToolDescriptors(result) {
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  const descriptors = [];
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.name !== 'string' || entry.name.trim().length === 0) continue;
    descriptors.push({
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : '',
      inputSchema:
        entry.inputSchema && typeof entry.inputSchema === 'object'
          ? entry.inputSchema
          : { type: 'object', properties: {} },
    });
  }
  return Object.freeze(descriptors);
}

/**
 * Gateway over a registry transport (`listTools`, `callTool`), with the team
 * scope applied to every call. The tool list is cached once per gateway.
 */
function createTeamSpecGateway({ transport, readScope, newRequestId = randomUUID }) {
  let descriptors;
  const loadDescriptors = () => {
    descriptors ??= Promise.resolve(transport.listTools()).then(readToolDescriptors);
    return descriptors;
  };
  return {
    listTools: () => loadDescriptors(),
    async callTool(name, args, signal) {
      const tools = await loadDescriptors();
      const descriptor = tools.find((tool) => tool.name === name);
      const scoped = applyTeamSpecScope(name, args, await readScope(), descriptor, newRequestId);
      try {
        return await transport.callTool(name, scoped, `specProxy:${name}`, signal);
      } catch (error) {
        if (!error || typeof error.code !== 'string') throw error;
        return refusalEnvelope(error.code, typeof error.message === 'string' ? error.message : error.code);
      }
    },
  };
}

module.exports = {
  SPEC_SCOPE_ERROR_CODES,
  SpecScopeError,
  applyTeamSpecScope,
  createTeamSpecGateway,
  readToolDescriptors,
  refusalEnvelope,
};
