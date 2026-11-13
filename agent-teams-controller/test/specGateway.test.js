// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

const {
  SPEC_SCOPE_ERROR_CODES,
  SpecScopeError,
  applyTeamSpecScope,
  createTeamSpecGateway,
} = require('../src/internal/specGateway.js');

const scope = {
  teamId: 'team-1',
  projects: ['stgm/tokenplan'],
  bindings: [
    { project: 'stgm/tokenplan', spec: 'registry-check' },
    { project: 'stgm/tokenplan', spec: 'balancer' },
  ],
};

const DESCRIPTORS = {
  documents: {
    name: 'spec_documents',
    description: 'documents',
    inputSchema: {
      type: 'object',
      properties: { action: {}, doc: {}, project: {}, spec: {}, requestId: {} },
      required: ['action'],
    },
  },
  catalog: {
    name: 'spec_catalog',
    description: 'catalog',
    inputSchema: {
      type: 'object',
      properties: { view: {}, project: {}, spec: {}, requestId: {} },
      required: ['view'],
    },
  },
  tasks: {
    name: 'spec_tasks',
    description: 'tasks',
    inputSchema: {
      type: 'object',
      properties: { spec: {}, project: {}, teamId: {}, requestId: {}, statuses: {} },
      required: ['spec'],
    },
  },
  patch: {
    name: 'spec_patch',
    description: 'patch',
    inputSchema: {
      type: 'object',
      properties: { intent: {}, project: {}, spec: {}, teamId: {}, requestId: {}, operations: {} },
      required: ['intent'],
    },
  },
};

const okEnvelope = {
  schemaVersion: 'spec-kernel@2',
  requestId: 'r1',
  operation: 'specPatch',
  ok: true,
  page: null,
  data: { kind: 'ok' },
  error: null,
  diagnostics: [],
  provenance: null,
};

describe('team specification scope policy', () => {
  it('fills the bound scope when the team has exactly one specification', () => {
    const single = {
      teamId: 'team-1',
      projects: ['stgm/tokenplan'],
      bindings: [{ project: 'stgm/tokenplan', spec: 'registry-check' }],
    };
    const args = applyTeamSpecScope(
      'spec_documents',
      { action: 'list' },
      single,
      DESCRIPTORS.documents,
      () => 'rid'
    );
    expect(args).toMatchObject({
      project: 'stgm/tokenplan',
      spec: 'registry-check',
      requestId: 'rid',
    });
    expect(args).not.toHaveProperty('teamId');
  });

  it('selects the only allowed project without choosing among several specifications', () => {
    const args = applyTeamSpecScope(
      'spec_documents',
      { action: 'list' },
      scope,
      DESCRIPTORS.documents,
      () => 'rid'
    );
    expect(args.project).toBe('stgm/tokenplan');
    expect(args).not.toHaveProperty('spec');
  });

  it('accepts any specification inside a bound project and refuses another project', () => {
    const scope = {
      projects: ['stgmt/tokenplan'],
      bindings: [{ project: 'stgmt/tokenplan', spec: 'registry-check' }],
    };
    const accepted = applyTeamSpecScope(
      'spec_documents',
      { action: 'list', project: 'stgmt/tokenplan', spec: 'not-bound-yet' },
      scope,
      DESCRIPTORS.documents,
      () => 'rid'
    );
    expect(accepted.spec).toBe('not-bound-yet');
    expect(() =>
      applyTeamSpecScope(
        'spec_documents',
        { action: 'list', project: 'other/project', spec: 'x' },
        scope,
        DESCRIPTORS.documents,
        () => 'rid'
      )
    ).toThrow(/not bound to this team/);
  });

  it('reports a typed refusal code for an unbound pair', () => {
    try {
      applyTeamSpecScope(
        'spec_patch',
        { project: 'stgm/other', spec: 'landing' },
        scope,
        DESCRIPTORS.patch,
        () => 'rid'
      );
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SpecScopeError);
      expect(error.code).toBe(SPEC_SCOPE_ERROR_CODES.NOT_LINKED);
    }
  });

  it('accepts a project-only scope for a catalog-style tool', () => {
    const args = applyTeamSpecScope(
      'spec_catalog',
      { view: 'specs', project: 'stgm/tokenplan' },
      scope,
      DESCRIPTORS.catalog,
      () => 'rid'
    );
    expect(args.project).toBe('stgm/tokenplan');
    expect(args).not.toHaveProperty('spec');
  });

  it('leaves a required specification to the registry when several are bound', () => {
    const args = applyTeamSpecScope('spec_tasks', {}, scope, DESCRIPTORS.tasks, () => 'rid');
    expect(args).not.toHaveProperty('spec');
    expect(args.teamId).toBe('team-1');
  });

  it('invents no scope fields when the tool descriptor is unknown', () => {
    const args = applyTeamSpecScope(
      'unknown_tool',
      { view: 'specs' },
      scope,
      undefined,
      () => 'rid'
    );
    expect(args).toEqual({ view: 'specs' });
  });

  it('drops the local worktree selector without inventing identity fields inside operations', () => {
    const args = applyTeamSpecScope(
      'spec_patch',
      {
        declaredWorktree: 'E:/tmp/x',
        operations: [
          { kind: 'upsert_task', localId: 'TASK-9' },
          { kind: 'replace_task_status', teamId: 'other' },
        ],
      },
      scope,
      DESCRIPTORS.patch,
      () => 'rid'
    );
    expect(args).not.toHaveProperty('declaredWorktree');
    expect(args.operations).toEqual([
      { kind: 'upsert_task', localId: 'TASK-9' },
      { kind: 'replace_task_status', teamId: 'other' },
    ]);
  });

  it('never adds teamId to a tool whose schema does not declare it', () => {
    const args = applyTeamSpecScope(
      'spec_documents',
      { action: 'list', project: 'stgm/tokenplan', spec: 'balancer' },
      scope,
      DESCRIPTORS.documents,
      () => 'rid'
    );
    expect(args).not.toHaveProperty('teamId');
  });

  it('keeps a caller requestId so an idempotent retry stays idempotent', () => {
    const args = applyTeamSpecScope(
      'spec_patch',
      { requestId: 'mine' },
      scope,
      DESCRIPTORS.patch,
      () => 'rid'
    );
    expect(args.requestId).toBe('mine');
  });
});

describe('registry gateway adapter', () => {
  it('publishes the registry tool schemas unchanged', async () => {
    const transport = {
      listTools: vi.fn(async () => ({
        tools: [
          {
            name: 'spec_patch',
            description: 'Patch',
            inputSchema: { type: 'object', properties: { intent: { type: 'string' } } },
          },
          { name: 'spec_tasks', description: 'Tasks', inputSchema: { type: 'object' } },
        ],
      })),
      callTool: vi.fn(),
    };
    const gateway = createTeamSpecGateway({ transport, readScope: async () => scope });
    const tools = await gateway.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['spec_patch', 'spec_tasks']);
    expect(tools[0].inputSchema).toEqual({
      type: 'object',
      properties: { intent: { type: 'string' } },
    });
  });

  it('turns a registry refusal into a refusal envelope instead of throwing', async () => {
    const refusal = Object.assign(new Error('spec is claimed'), { code: 'CLAIM_HELD' });
    const transport = {
      listTools: vi.fn(async () => ({ tools: [DESCRIPTORS.patch] })),
      callTool: vi.fn(async () => {
        throw refusal;
      }),
    };
    const gateway = createTeamSpecGateway({ transport, readScope: async () => scope });
    const envelope = await gateway.callTool('spec_patch', {});
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({ code: 'CLAIM_HELD', message: 'spec is claimed' });
  });

  it('applies the team scope before the call reaches the registry', async () => {
    const transport = {
      listTools: vi.fn(async () => ({ tools: [DESCRIPTORS.patch] })),
      callTool: vi.fn(async () => okEnvelope),
    };
    const gateway = createTeamSpecGateway({
      transport,
      readScope: async () => scope,
      newRequestId: () => 'rid',
    });
    await gateway.callTool('spec_patch', {
      project: 'stgm/tokenplan',
      spec: 'balancer',
      operations: [{ kind: 'upsert_task', localId: 'TASK-1' }],
    });
    expect(transport.callTool).toHaveBeenCalledWith(
      'spec_patch',
      {
        project: 'stgm/tokenplan',
        spec: 'balancer',
        requestId: 'rid',
        teamId: 'team-1',
        operations: [{ kind: 'upsert_task', localId: 'TASK-1' }],
      },
      'specProxy:spec_patch',
      undefined
    );
  });

  it('lists tools only once per gateway', async () => {
    const transport = {
      listTools: vi.fn(async () => ({ tools: [DESCRIPTORS.patch] })),
      callTool: vi.fn(async () => okEnvelope),
    };
    const gateway = createTeamSpecGateway({ transport, readScope: async () => scope });
    await gateway.listTools();
    await gateway.callTool('spec_patch', {});
    await gateway.callTool('spec_patch', {});
    expect(transport.listTools).toHaveBeenCalledTimes(1);
  });
});

describe('spec creation inside a bound project', () => {
  it('allows createSpec for a specification the team has not bound yet', () => {
    const scope = {
      projects: ['stgmt/tokenplan'],
      bindings: [{ project: 'stgmt/tokenplan', spec: 'registry-check' }],
    };
    const descriptor = {
      name: 'spec_patch',
      inputSchema: {
        properties: {
          intent: { enum: ['createSpec'] },
          project: { type: 'string' },
          spec: { type: 'string' },
          title: { type: 'string' },
          requestId: { type: ['string', 'null'] },
        },
      },
    };
    const out = applyTeamSpecScope(
      'spec_patch',
      { intent: 'createSpec', project: 'stgmt/tokenplan', spec: 'brand-new-spec', title: 'New' },
      scope,
      descriptor
    );
    expect(out.spec).toBe('brand-new-spec');
  });

  it('still refuses createSpec in a project the team is not bound to', () => {
    const scope = {
      projects: ['stgmt/tokenplan'],
      bindings: [{ project: 'stgmt/tokenplan', spec: 'registry-check' }],
    };
    const descriptor = {
      name: 'spec_patch',
      inputSchema: {
        properties: {
          intent: { enum: ['createSpec'] },
          project: { type: 'string' },
          spec: { type: 'string' },
          title: { type: 'string' },
          requestId: { type: ['string', 'null'] },
        },
      },
    };
    expect(() =>
      applyTeamSpecScope(
        'spec_patch',
        { intent: 'createSpec', project: 'other/project', spec: 'x', title: 'New' },
        scope,
        descriptor
      )
    ).toThrow(/not bound to this team/);
  });
});

describe('canonical project authority at the registry gateway', () => {
  it('creates and reads the first specification with no existing binding', async () => {
    const specs = new Map();
    const descriptor = {
      name: 'spec_patch',
      inputSchema: {
        type: 'object',
        properties: { intent: {}, project: {}, spec: {}, title: {}, requestId: {} },
      },
    };
    const gateway = createTeamSpecGateway({
      readScope: async () => ({ projects: ['allowed/project'], bindings: [] }),
      transport: {
        listTools: async () => ({ tools: [descriptor, DESCRIPTORS.documents] }),
        async callTool(name, args) {
          if (args.project !== 'allowed/project' || 'teamId' in args) {
            throw Object.assign(new Error('invalid registry scope'), { code: 'INVALID_SCOPE' });
          }
          if (name === 'spec_patch' && args.intent === 'createSpec') {
            specs.set(args.spec, `# ${args.title}`);
            return { ok: true, data: { created: args.spec }, error: null };
          }
          return { ok: true, data: { content: specs.get(args.spec) }, error: null };
        },
      },
    });
    const created = await gateway.callTool('spec_patch', {
      intent: 'createSpec',
      project: 'allowed/project',
      spec: 'first',
      title: 'First spec',
    });
    expect(created).toMatchObject({ ok: true, data: { created: 'first' } });
    const read = await gateway.callTool('spec_documents', {
      action: 'read',
      project: 'allowed/project',
      spec: 'first',
      doc: 'SPEC.md',
    });
    expect(read).toMatchObject({ ok: true, data: { content: '# First spec' } });
  });

  it.each(['spec_documents', 'spec_patch'])(
    'never grants %s access from a binding outside the allowed projects',
    async (name) => {
      // Defense in depth: even inconsistent persisted bindings cannot widen projects.
      let calls = 0;
      const gateway = createTeamSpecGateway({
        readScope: async () => ({
          projects: ['allowed/project'],
          bindings: [{ project: 'foreign/project', spec: 'secret' }],
        }),
        transport: {
          listTools: async () => ({ tools: [DESCRIPTORS.documents, DESCRIPTORS.patch] }),
          async callTool() {
            calls += 1;
            return { ok: true, data: { leaked: true }, error: null };
          },
        },
      });
      await expect(
        gateway.callTool(name, {
          action: 'read',
          intent: 'createSpec',
          project: 'foreign/project',
          spec: 'secret',
        })
      ).rejects.toMatchObject({ code: expect.any(String) });
      expect(calls).toBe(0);
    }
  );

  it.each([
    ['empty discovery', { tools: [] }],
    ['missing discovery', {}],
    ['invalid descriptor', { tools: [{ name: 'spec_patch', inputSchema: null }] }],
    [
      'non-object input schema',
      { tools: [{ name: 'spec_patch', inputSchema: { type: 'string' } }] },
    ],
    ['untyped input schema', { tools: [{ name: 'spec_patch', inputSchema: {} }] }],
    [
      'malformed schema properties',
      { tools: [{ name: 'spec_patch', inputSchema: { type: 'object', properties: [] } }] },
    ],
    ['partial discovery', { tools: [DESCRIPTORS.documents, { inputSchema: {} }] }],
  ])('refuses readiness and tool execution after %s', async (_label, discovery) => {
    let calls = 0;
    const gateway = createTeamSpecGateway({
      readScope: async () => ({ projects: ['stgm/tokenplan'], bindings: [] }),
      transport: {
        listTools: async () => discovery,
        async callTool() {
          calls += 1;
          return okEnvelope;
        },
      },
    });
    await expect(gateway.listTools()).rejects.toThrow();
    await expect(gateway.callTool('spec_patch', { intent: 'createSpec' })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
