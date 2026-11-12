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

/** Canonical project authority; bindings may select a spec but never grant access. */
function validateTeamSpecScope(value) {
  const validString = (entry) => typeof entry === 'string' && entry.trim().length > 0;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Array.isArray(value.projects) ||
    value.projects.length === 0 ||
    !value.projects.every(validString) ||
    !Array.isArray(value.bindings)
  ) {
    throw new SpecScopeError(
      SPEC_SCOPE_ERROR_CODES.INVALID_SCOPE,
      'Team spec scope requires projects and bindings'
    );
  }
  const projects = [...new Set(value.projects.map((project) => project.trim()))];
  const bindings = value.bindings.map((binding) => {
    if (
      !binding ||
      !validString(binding.project) ||
      !validString(binding.spec) ||
      !projects.includes(binding.project.trim())
    ) {
      throw new SpecScopeError(
        SPEC_SCOPE_ERROR_CODES.INVALID_SCOPE,
        'Team spec binding is outside the allowed projects'
      );
    }
    return { project: binding.project.trim(), spec: binding.spec.trim() };
  });
  return {
    projects,
    bindings,
    ...(validString(value.teamId) ? { teamId: value.teamId.trim() } : {}),
  };
}

function applyTeamSpecScope(name, args, scope, descriptor, newRequestId = randomUUID) {
  scope = validateTeamSpecScope(scope);
  const accepts = acceptedFields(descriptor);
  const scoped = { ...args };
  delete scoped.declaredWorktree;

  if (
    accepts.has('requestId') &&
    (typeof scoped.requestId !== 'string' || !scoped.requestId.trim())
  ) {
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
    if (rawProject) {
      if (!scope.projects.includes(rawProject)) {
        throw new SpecScopeError(
          SPEC_SCOPE_ERROR_CODES.NOT_LINKED,
          `${rawProject} is not bound to this team`
        );
      }
      scoped.project = rawProject;
    } else {
      const candidates = scope.bindings.filter((binding) => binding.spec === rawSpec);
      const projects = [...new Set(candidates.map((binding) => binding.project))];
      const project =
        projects.length === 1
          ? projects[0]
          : scope.projects.length === 1
            ? scope.projects[0]
            : null;
      if (!project || projects.length > 1) {
        throw new SpecScopeError(
          SPEC_SCOPE_ERROR_CODES.INVALID_SCOPE,
          `${name} needs an explicit project`
        );
      }
      if (acceptsProject) scoped.project = project;
    }
    if (rawSpec) scoped.spec = rawSpec;
  } else if (scope.bindings.length === 1) {
    const [binding] = scope.bindings;
    if (acceptsProject) scoped.project = binding.project;
    if (acceptsSpec) scoped.spec = binding.spec;
  }
  if (acceptsProject && !scoped.project) {
    if (scope.projects.length !== 1) {
      throw new SpecScopeError(
        SPEC_SCOPE_ERROR_CODES.INVALID_SCOPE,
        `${name} needs an explicit project`
      );
    }
    scoped.project = scope.projects[0];
  }

  if (
    scope.teamId &&
    accepts.has('teamId') &&
    (scoped.teamId === undefined || scoped.teamId === null)
  ) {
    scoped.teamId = scope.teamId;
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
  if (!Array.isArray(result?.tools) || result.tools.length === 0) {
    throw new SpecScopeError('REGISTRY_BAD_DISCOVERY', 'Spec registry published no tools');
  }
  const names = new Set();
  const descriptors = result.tools.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.name !== 'string' ||
      !entry.name.trim() ||
      names.has(entry.name) ||
      !entry.inputSchema ||
      typeof entry.inputSchema !== 'object' ||
      Array.isArray(entry.inputSchema) ||
      entry.inputSchema.type !== 'object' ||
      (entry.inputSchema.properties !== undefined &&
        (!entry.inputSchema.properties ||
          typeof entry.inputSchema.properties !== 'object' ||
          Array.isArray(entry.inputSchema.properties)))
    ) {
      throw new SpecScopeError(
        'REGISTRY_BAD_DISCOVERY',
        'Spec registry published an invalid or duplicate tool'
      );
    }
    names.add(entry.name);
    return {
      name: entry.name,
      description: typeof entry.description === 'string' ? entry.description : '',
      inputSchema: entry.inputSchema,
    };
  });
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
      if (!descriptor) {
        throw new SpecScopeError(
          'REGISTRY_UNKNOWN_TOOL',
          'Tool was not published by the spec registry'
        );
      }
      const scoped = applyTeamSpecScope(name, args, await readScope(), descriptor, newRequestId);
      try {
        return await transport.callTool(name, scoped, `specProxy:${name}`, signal);
      } catch (error) {
        if (!error || typeof error.code !== 'string') throw error;
        return refusalEnvelope(
          error.code,
          typeof error.message === 'string' ? error.message : error.code
        );
      }
    },
  };
}

module.exports = {
  SPEC_SCOPE_ERROR_CODES,
  SpecScopeError,
  applyTeamSpecScope,
  validateTeamSpecScope,
  createTeamSpecGateway,
  readToolDescriptors,
  refusalEnvelope,
};
