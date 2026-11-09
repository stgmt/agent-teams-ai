import { randomUUID } from 'node:crypto';

import type { RegistryToolEnvelope } from './RegistryTaskClientTypes';

/** One tool the specification registry publishes; its schema is used verbatim. */
export interface SpecToolDescriptor {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/** One registry project/spec pair the team is allowed to touch. */
export interface SpecBinding {
  readonly project: string;
  readonly spec: string;
}

/** The exact authority a team holds over the registry. */
export interface SpecTeamScope {
  readonly teamId: string | null;
  readonly bindings: readonly SpecBinding[];
}

export const SPEC_SCOPE_ERROR_CODES = {
  NOT_LINKED: 'TEAM_SPEC_NOT_LINKED',
  INVALID_SCOPE: 'INVALID_TASK_SCOPE',
} as const;

export class SpecScopeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SpecScopeError';
  }
}

/**
 * The adapter contract: the registry owns the tool surface and the schemas.
 * Agent Teams only forwards calls and enforces team scope, so a contract change
 * in the specification kit needs no edit here.
 */
export interface SpecRegistryGateway {
  listTools(signal?: AbortSignal): Promise<readonly SpecToolDescriptor[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RegistryToolEnvelope<unknown>>;
}

type RegistryTransportPort = Pick<
  import('./RegistryMcpTransport').RegistryMcpTransport,
  'listTools' | 'callTool'
>;

function readToolDescriptors(result: Record<string, unknown>): readonly SpecToolDescriptor[] {
  const tools = Array.isArray(result.tools) ? result.tools : [];
  const descriptors: SpecToolDescriptor[] = [];
  for (const entry of tools) {
    if (!entry || typeof entry !== 'object') continue;
    const tool = entry as Record<string, unknown>;
    if (typeof tool.name !== 'string' || tool.name.trim().length === 0) continue;
    descriptors.push({
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description : '',
      inputSchema:
        tool.inputSchema && typeof tool.inputSchema === 'object'
          ? (tool.inputSchema as Record<string, unknown>)
          : { type: 'object', properties: {} },
    });
  }
  return Object.freeze(descriptors);
}

/** Thin adapter over the registry MCP transport; it adds no schema of its own. */
export class McpSpecRegistryGateway implements SpecRegistryGateway {
  constructor(private readonly transport: RegistryTransportPort) {}

  async listTools(signal?: AbortSignal): Promise<readonly SpecToolDescriptor[]> {
    return readToolDescriptors(await this.transport.listTools(signal));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RegistryToolEnvelope<unknown>> {
    try {
      return await this.transport.callTool(name, args, `specProxy:${name}`, signal);
    } catch (error) {
      const failure = error as { code?: unknown; message?: unknown };
      if (typeof failure.code !== 'string') throw error;
      return refusalEnvelope(
        failure.code,
        typeof failure.message === 'string' ? failure.message : failure.code
      );
    }
  }
}

/** A registry refusal shaped exactly like a registry envelope, without inventing fields. */
function refusalEnvelope(code: string, message: string): RegistryToolEnvelope<unknown> {
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

function matchesBinding(bindings: readonly SpecBinding[], project: string, spec: string): boolean {
  return bindings.some((binding) => binding.project === project && binding.spec === spec);
}

/**
 * The only policy Agent Teams adds on top of the registry surface:
 * a call may name only the team's bound specifications, an unambiguous binding
 * fills an omitted scope, task operations carry the team id, and the local
 * worktree selector never travels over this transport.
 */
export function applyTeamSpecScope(
  name: string,
  args: Record<string, unknown>,
  scope: SpecTeamScope,
  newRequestId: () => string = randomUUID
): Record<string, unknown> {
  const scoped: Record<string, unknown> = { ...args };
  delete scoped.declaredWorktree;

  if (typeof scoped.requestId !== 'string' || scoped.requestId.trim().length === 0) {
    scoped.requestId = newRequestId();
  }

  const rawProject = typeof scoped.project === 'string' ? scoped.project.trim() : '';
  const rawSpec = typeof scoped.spec === 'string' ? scoped.spec.trim() : '';

  if (rawProject || rawSpec) {
    if (!rawProject || !rawSpec) {
      throw new SpecScopeError(
        SPEC_SCOPE_ERROR_CODES.INVALID_SCOPE,
        `${name} requires project and spec together`
      );
    }
    if (!matchesBinding(scope.bindings, rawProject, rawSpec)) {
      throw new SpecScopeError(
        SPEC_SCOPE_ERROR_CODES.NOT_LINKED,
        `${rawProject}/${rawSpec} is not bound to this team`
      );
    }
  } else if (scope.bindings.length === 1) {
    const [binding] = scope.bindings;
    scoped.project = binding.project;
    scoped.spec = binding.spec;
  }

  if (scope.teamId && (scoped.teamId === undefined || scoped.teamId === null)) {
    scoped.teamId = scope.teamId;
  }

  const operations = scoped.operations;
  if (Array.isArray(operations) && scope.teamId) {
    scoped.operations = operations.map((operation) => {
      if (!operation || typeof operation !== 'object') return operation;
      const entry = operation as Record<string, unknown>;
      return entry.teamId === undefined || entry.teamId === null
        ? { ...entry, teamId: scope.teamId }
        : entry;
    });
  }

  return scoped;
}

/** Applies the team scope to every call; the tool list passes through untouched. */
export class TeamScopedSpecGateway implements SpecRegistryGateway {
  constructor(
    private readonly inner: SpecRegistryGateway,
    private readonly readScope: () => Promise<SpecTeamScope>,
    private readonly newRequestId: () => string = randomUUID
  ) {}

  listTools(signal?: AbortSignal): Promise<readonly SpecToolDescriptor[]> {
    return this.inner.listTools(signal);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<RegistryToolEnvelope<unknown>> {
    return this.inner.callTool(
      name,
      applyTeamSpecScope(name, args, await this.readScope(), this.newRequestId),
      signal
    );
  }
}
