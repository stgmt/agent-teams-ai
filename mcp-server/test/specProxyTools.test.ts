// @vitest-environment node
import http from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { registerSpecProxyTools } from '../src/tools/specProxyTools';

type Registered = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  execute: (args: unknown) => Promise<unknown>;
};

const servers: http.Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  delete process.env.OMP_SPEC_REGISTRY_URL;
  delete process.env.OMP_SPEC_REGISTRY_TOKEN;
  delete process.env.AGENT_TEAMS_SPEC_SCOPE;
});

async function startRegistry(handler: (body: Record<string, unknown>) => unknown) {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: handler(body) }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('registry did not bind');
  return `http://127.0.0.1:${address.port}/mcp`;
}

function harness() {
  const tools: Registered[] = [];
  return {
    tools,
    server: {
      addTool(tool: Registered) {
        tools.push(tool);
        return tool as never;
      },
    } as never,
  };
}

const TOOLS = {
  tools: [
    {
      name: 'spec_documents',
      description: 'Read a specification document',
      inputSchema: {
        type: 'object',
        properties: { action: {}, doc: {}, project: {}, spec: {}, requestId: {} },
        required: ['action'],
      },
    },
    {
      name: 'spec_patch',
      description: 'Patch a specification',
      inputSchema: {
        type: 'object',
        properties: { intent: {}, project: {}, spec: {}, teamId: {}, requestId: {}, operations: {} },
        required: ['intent'],
      },
    },
  ],
};

describe('spec proto surface', () => {
  it('registers nothing when the launch carries no registry coordinates', async () => {
    const { server, tools } = harness();
    await registerSpecProxyTools(server);
    expect(tools).toHaveLength(0);
  });

  it('registers every registry tool under the team prefix with its own schema', async () => {
    process.env.OMP_SPEC_REGISTRY_URL = await startRegistry(() => TOOLS);
    process.env.OMP_SPEC_REGISTRY_TOKEN = 'TEST-token';
    process.env.AGENT_TEAMS_SPEC_SCOPE = JSON.stringify({
      teamId: 'team-1',
      bindings: [{ project: 'stgm/tokenplan', spec: 'registry-check' }],
    });
    const { server, tools } = harness();
    await registerSpecProxyTools(server);
    expect(tools.map((tool) => tool.name)).toEqual([
      'team_spec_spec_documents',
      'team_spec_spec_patch',
    ]);
    const standard = (tools[0].parameters as {
      '~standard': { jsonSchema: { input: (options: unknown) => unknown } };
    })['~standard'];
    expect(standard.jsonSchema.input({ target: 'draft-07' })).toEqual(TOOLS.tools[0].inputSchema);
  });

  it('forwards a call with the team scope applied and returns the registry envelope', async () => {
    const seen: Record<string, unknown>[] = [];
    process.env.OMP_SPEC_REGISTRY_URL = await startRegistry((body) => {
      if (body.method === 'tools/list') return TOOLS;
      const params = body.params as { name: string; arguments: Record<string, unknown> };
      seen.push(params.arguments);
      return { structuredContent: { ok: true, data: { kind: 'patched' }, error: null } };
    });
    process.env.OMP_SPEC_REGISTRY_TOKEN = 'TEST-token';
    process.env.AGENT_TEAMS_SPEC_SCOPE = JSON.stringify({
      teamId: 'team-1',
      bindings: [{ project: 'stgm/tokenplan', spec: 'registry-check' }],
    });
    const { server, tools } = harness();
    await registerSpecProxyTools(server);

    const patch = tools.find((tool) => tool.name === 'team_spec_spec_patch');
    const result = (await patch!.execute({ intent: 'patch' })) as {
      content: { text: string }[];
    };
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: true });
    expect(seen[0]).toMatchObject({
      intent: 'patch',
      project: 'stgm/tokenplan',
      spec: 'registry-check',
      teamId: 'team-1',
    });

    const documents = tools.find((tool) => tool.name === 'team_spec_spec_documents');
    await documents!.execute({ action: 'list' });
    expect(seen[1]).toMatchObject({ action: 'list', project: 'stgm/tokenplan', spec: 'registry-check' });
    expect(seen[1]).not.toHaveProperty('teamId');
  });
});
