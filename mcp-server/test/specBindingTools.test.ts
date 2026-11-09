import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {
  AGENT_TEAMS_MCP_TOOL_GROUPS,
  AGENT_TEAMS_OPERATIONAL_LEAD_TOOL_NAMES,
  AGENT_TEAMS_REGISTERED_TOOL_NAMES,
  AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES,
} from 'agent-teams-controller';
import { afterEach, describe, expect, it } from 'vitest';

import { registerTools } from '../src/tools';

type RegisteredTool = {
  name: string;
  parameters?: { safeParse: (value: unknown) => { success: boolean } };
  execute: (
    args: Record<string, unknown>,
    context?: { session?: unknown }
  ) => Promise<unknown> | unknown;
};

type RequestRecord = {
  method?: string;
  url?: string;
  body?: unknown;
  appContext?: string;
  authorization?: string;
};

function collectTools(requestScopedSpecCapability = false) {
  const tools = new Map<string, RegisteredTool>();
  registerTools(
    {
      addTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    } as never,
    'full',
    { requestScopedSpecCapability }
  );
  return tools;
}

function parseToolResult(result: unknown) {
  const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
  return JSON.parse(text);
}

describe('team spec binding MCP tools', () => {
  const tools = collectTools();
  const envKeys = [
    'AGENT_TEAMS_BOUND_CONTROL_URL',
    'AGENT_TEAMS_BOUND_CONTEXT_JSON',
    'AGENT_TEAMS_MCP_CLAUDE_DIR',
    'AGENT_TEAMS_MCP_SCOPE_CREDENTIAL',
  ] as const;
  let previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
    (typeof envKeys)[number],
    string | undefined
  >;
  let claudeDir: string | undefined;
  let server: http.Server | undefined;
  let serverUrl = '';
  let requests: RequestRecord[] = [];
  let currentBindings: Array<{ project: string; spec: string }> = [];
  let failLink = false;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve()))
      );
    }
    server = undefined;
    if (claudeDir) fs.rmSync(claudeDir, { recursive: true, force: true });
    claudeDir = undefined;
    for (const key of envKeys) {
      const value = previousEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    failLink = false;
  });

  async function prepareScopedRuntime() {
    previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]])) as Record<
      (typeof envKeys)[number],
      string | undefined
    >;
    claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-spec-bindings-'));
    requests = [];
    currentBindings = [];
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8');
        const body = bodyText ? JSON.parse(bodyText) : undefined;
        const record: RequestRecord = {
          method: request.method,
          url: request.url,
          body,
          appContext: request.headers['x-agent-teams-app-context'] as string | undefined,
          authorization: request.headers.authorization,
        };
        requests.push(record);
        if (record.url !== '/api/team-runtime/spec-bindings') {
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ code: 'NOT_FOUND', message: 'Unknown route' }));
          return;
        }
        if (record.authorization !== 'Bearer TEST-runtime-scope') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({ code: 'TEAM_MCP_UNAUTHORIZED', message: 'Invalid runtime capability' })
          );
          return;
        }
        if (record.method === 'PUT' && failLink) {
          response.writeHead(400, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              code: 'PROJECT_NOT_ALLOWED',
              message: 'Project is not authorized for this registry tenant.',
            })
          );
          return;
        }
        if (record.method === 'PUT') {
          currentBindings = [body as { project: string; spec: string }];
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ bindings: currentBindings }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Failed to start MCP test server');
    serverUrl = `http://127.0.0.1:${address.port}`;
    process.env.AGENT_TEAMS_BOUND_CONTROL_URL = serverUrl;
    process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = JSON.stringify({
      appInstanceId: 'spec-binding-test',
      dataRootFingerprint: 'spec-binding-root',
      connectionGeneration: 1,
    });
    process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = claudeDir;
    process.env.AGENT_TEAMS_MCP_SCOPE_CREDENTIAL = 'TEST-runtime-scope';
  }

  it('registers both operational role tools without model-selectable team identity', async () => {
    expect(AGENT_TEAMS_REGISTERED_TOOL_NAMES).toContain('team_spec_bindings');
    expect(AGENT_TEAMS_REGISTERED_TOOL_NAMES).toContain('team_link_spec');
    expect(AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES).toContain('team_spec_bindings');
    expect(AGENT_TEAMS_TEAMMATE_OPERATIONAL_TOOL_NAMES).toContain('team_link_spec');
    expect(AGENT_TEAMS_OPERATIONAL_LEAD_TOOL_NAMES).toContain('team_spec_bindings');
    expect(AGENT_TEAMS_OPERATIONAL_LEAD_TOOL_NAMES).toContain('team_link_spec');
    expect(AGENT_TEAMS_MCP_TOOL_GROUPS).toContainEqual({
      id: 'teamSpec',
      teammateOperational: true,
      toolNames: ['team_spec_bindings', 'team_link_spec'],
    });
    expect(tools.get('team_spec_bindings')?.parameters?.safeParse({ teamName: 'other' }).success)
      .toBe(false);
    expect(
      tools.get('team_link_spec')?.parameters?.safeParse({
        project: 'sandbox/project',
        spec: 'sandbox-spec',
        teamName: 'other',
      }).success
    ).toBe(false);

    await prepareScopedRuntime();
    const binding = { project: 'sandbox/project', spec: 'sandbox-spec' };
    const linked = parseToolResult(await tools.get('team_link_spec')!.execute(binding));

    expect(linked).toEqual({ bindings: [binding] });
    expect(requests[0]).toMatchObject({
      method: 'PUT',
      url: '/api/team-runtime/spec-bindings',
      body: binding,
      authorization: 'Bearer TEST-runtime-scope',
    });
    expect(requests[0].body).not.toHaveProperty('teamName');
    expect(JSON.parse(requests[0].appContext ?? 'null')).toEqual({
      appInstanceId: 'spec-binding-test',
      dataRootFingerprint: 'spec-binding-root',
      connectionGeneration: 1,
    });

    const listed = parseToolResult(await tools.get('team_spec_bindings')!.execute({}));
    expect(listed).toEqual({ bindings: [binding] });
    expect(requests[1]).toMatchObject({
      method: 'GET',
      url: '/api/team-runtime/spec-bindings',
      authorization: 'Bearer TEST-runtime-scope',
    });
  });

  it('fails closed without a capability and surfaces registry authorization failures', async () => {
    await prepareScopedRuntime();
    delete process.env.AGENT_TEAMS_MCP_SCOPE_CREDENTIAL;
    await expect(tools.get('team_spec_bindings')!.execute({})).rejects.toThrow(
      'AGENT_TEAMS_MCP_SCOPE_CREDENTIAL'
    );
    expect(requests).toHaveLength(0);

    process.env.AGENT_TEAMS_MCP_SCOPE_CREDENTIAL = 'TEST-runtime-scope';
    failLink = true;
    await expect(
      tools.get('team_link_spec')!.execute({
        project: 'forbidden/project',
        spec: 'sandbox-spec',
      })
    ).rejects.toThrow('Project is not authorized for this registry tenant.');
  });

  it('uses request-scoped capability without falling back to the shared process environment', async () => {
    await prepareScopedRuntime();
    const requestScopedTools = collectTools(true);
    const binding = { project: 'sandbox/project', spec: 'sandbox-spec' };

    const linked = parseToolResult(
      await requestScopedTools.get('team_link_spec')!.execute(binding, {
        session: { appMcpScopeCredential: 'TEST-runtime-scope' },
      })
    );
    expect(linked).toEqual({ bindings: [binding] });
    expect(requests[0].authorization).toBe('Bearer TEST-runtime-scope');

    await expect(
      requestScopedTools.get('team_spec_bindings')!.execute({}, {
        session: { appMcpScopeCredential: null },
      })
    ).rejects.toThrow('AGENT_TEAMS_MCP_SCOPE_CREDENTIAL');
    expect(requests).toHaveLength(1);
  });
});
