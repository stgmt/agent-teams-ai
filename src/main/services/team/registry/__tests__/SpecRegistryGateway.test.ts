// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  McpSpecRegistryGateway,
  SPEC_SCOPE_ERROR_CODES,
  SpecScopeError,
  TeamScopedSpecGateway,
  applyTeamSpecScope,
} from '../SpecRegistryGateway';

import type { SpecRegistryGateway, SpecTeamScope } from '../SpecRegistryGateway';
import type { RegistryToolEnvelope } from '../RegistryTaskClientTypes';

const scope: SpecTeamScope = {
  teamId: 'team-1',
  bindings: [
    { project: 'stgm/tokenplan', spec: 'registry-check' },
    { project: 'stgm/tokenplan', spec: 'balancer' },
  ],
};

const okEnvelope: RegistryToolEnvelope<unknown> = {
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
    const single: SpecTeamScope = {
      teamId: 'team-1',
      bindings: [{ project: 'stgm/tokenplan', spec: 'registry-check' }],
    };
    const args = applyTeamSpecScope('spec_documents', { action: 'list' }, single, () => 'rid');
    expect(args).toMatchObject({
      project: 'stgm/tokenplan',
      spec: 'registry-check',
      requestId: 'rid',
      teamId: 'team-1',
    });
  });

  it('leaves the scope absent when several specifications are bound', () => {
    const args = applyTeamSpecScope('spec_documents', { action: 'list' }, scope, () => 'rid');
    expect(args).not.toHaveProperty('project');
    expect(args).not.toHaveProperty('spec');
  });

  it('accepts a bound pair and refuses an unbound one', () => {
    expect(() =>
      applyTeamSpecScope(
        'spec_patch',
        { project: 'stgm/tokenplan', spec: 'balancer' },
        scope,
        () => 'rid'
      )
    ).not.toThrow();
    expect(() =>
      applyTeamSpecScope(
        'spec_patch',
        { project: 'stgm/tokenplan', spec: 'someone-else' },
        scope,
        () => 'rid'
      )
    ).toThrow(SpecScopeError);
  });

  it('reports a typed refusal code for an unbound pair', () => {
    try {
      applyTeamSpecScope(
        'spec_patch',
        { project: 'stgm/other', spec: 'landing' },
        scope,
        () => 'rid'
      );
      throw new Error('expected refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(SpecScopeError);
      expect((error as SpecScopeError).code).toBe(SPEC_SCOPE_ERROR_CODES.NOT_LINKED);
    }
  });

  it('requires project and spec together', () => {
    expect(() =>
      applyTeamSpecScope('spec_documents', { project: 'stgm/tokenplan' }, scope, () => 'rid')
    ).toThrow(SpecScopeError);
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
      () => 'rid'
    );
    expect(args).not.toHaveProperty('declaredWorktree');
    expect(args.operations).toEqual([
      { kind: 'upsert_task', localId: 'TASK-9', teamId: 'team-1' },
      { kind: 'replace_task_status', teamId: 'other' },
    ]);
  });

  it('keeps a caller requestId so an idempotent retry stays idempotent', () => {
    const args = applyTeamSpecScope('spec_patch', { requestId: 'mine' }, scope, () => 'rid');
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
    const gateway = new McpSpecRegistryGateway(transport as never);
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
      listTools: vi.fn(),
      callTool: vi.fn(async () => {
        throw refusal;
      }),
    };
    const gateway = new McpSpecRegistryGateway(transport as never);
    const envelope = await gateway.callTool('spec_patch', {});
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toMatchObject({ code: 'CLAIM_HELD', message: 'spec is claimed' });
  });

  it('applies the team scope before the call reaches the registry', async () => {
    const inner: SpecRegistryGateway = {
      listTools: vi.fn(async () => []),
      callTool: vi.fn(async () => okEnvelope),
    };
    const gateway = new TeamScopedSpecGateway(
      inner,
      async () => scope,
      () => 'rid'
    );
    await gateway.callTool('spec_patch', {
      project: 'stgm/tokenplan',
      spec: 'balancer',
      operations: [{ kind: 'upsert_task', localId: 'TASK-1' }],
    });
    expect(inner.callTool).toHaveBeenCalledWith(
      'spec_patch',
      {
        project: 'stgm/tokenplan',
        spec: 'balancer',
        requestId: 'rid',
        teamId: 'team-1',
        operations: [{ kind: 'upsert_task', localId: 'TASK-1', teamId: 'team-1' }],
      },
      undefined
    );
  });
});
