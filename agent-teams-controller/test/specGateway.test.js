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

  it('leaves the scope absent when several specifications are bound', () => {
    const args = applyTeamSpecScope('spec_documents', { action: 'list' }, scope, DESCRIPTORS.documents, () => 'rid');
    expect(args).not.toHaveProperty('project');
    expect(args).not.toHaveProperty('spec');
  });

  it('accepts a bound pair and refuses an unbound one', () => {
    expect(() =>
      applyTeamSpecScope('spec_patch', { project: 'stgm/tokenplan', spec: 'balancer' }, scope, DESCRIPTORS.patch, () => 'rid')
    ).not.toThrow();
    expect(() =>
      applyTeamSpecScope('spec_patch', { project: 'stgm/tokenplan', spec: 'someone-else' }, scope, DESCRIPTORS.patch, () => 'rid')
    ).toThrow(SpecScopeError);
  });

  it('reports a typed refusal code for an unbound pair', () => {
    try {
      applyTeamSpecScope('spec_patch', { project: 'stgm/other', spec: 'landing' }, scope, DESCRIPTORS.patch, () => 'rid');
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
    const args = applyTeamSpecScope('unknown_tool', { view: 'specs' }, scope, undefined, () => 'rid');
    expect(args).toEqual({ view: 'specs' });
  });

  it('drops the local worktree selector and stamps the team id on task operations', () => {
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
      { kind: 'upsert_task', localId: 'TASK-9', teamId: 'team-1' },
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
    const args = applyTeamSpecScope('spec_patch', { requestId: 'mine' }, scope, DESCRIPTORS.patch, () => 'rid');
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
      listTools: vi.fn(async () => ({ tools: [] })),
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
        operations: [{ kind: 'upsert_task', localId: 'TASK-1', teamId: 'team-1' }],
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
    const scope = { teamId: 'team-1', bindings: [{ project: 'stgmt/tokenplan', spec: 'registry-check' }] };
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
    const scope = { teamId: 'team-1', bindings: [{ project: 'stgmt/tokenplan', spec: 'registry-check' }] };
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
