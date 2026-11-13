// @vitest-environment node
import http from 'node:http';
import { once } from 'node:events';

import { afterEach, describe, expect, it } from 'vitest';

import { registerSpecProxyTools } from '../src/tools/specProxyTools';

type Registered = {
  name: string;
  parameters?: Record<string, unknown>;
  execute: (args: unknown) => Promise<unknown>;
};

const servers: http.Server[] = [];
const ENV_KEYS = ['OMP_SPEC_REGISTRY_URL', 'OMP_SPEC_REGISTRY_TOKEN', 'AGENT_TEAMS_SPEC_SCOPE'] as const;
const originalEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const PROJECT = 'stgm/tokenplan';
const SCOPE = { projects: [PROJECT], bindings: [{ project: PROJECT, spec: 'registry-check' }] };
const TOOLS = {
  tools: [
    {
      name: 'spec_documents',
      description: 'Read a specification document',
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string' }, doc: {}, project: {}, spec: {}, requestId: {} },
        required: ['action'],
      },
    },
    {
      name: 'spec_patch',
      description: 'Patch a specification',
      inputSchema: {
        type: 'object',
        properties: { intent: {}, project: {}, spec: {}, requestId: {}, operations: {} },
        required: ['intent'],
      },
    },
  ],
};

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  }
  for (const key of ENV_KEYS) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function startRegistry(handler: (body: Record<string, unknown>) => unknown) {
  let initialized = false;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk) => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (body.method === 'initialize') {
        response.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'fixture-session' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'registry-fixture', version: '1' } } }));
        return;
      }
      if (request.headers['mcp-session-id'] !== 'fixture-session' || request.headers['mcp-protocol-version'] !== '2024-11-05') {
        response.writeHead(400); response.end(); return;
      }
      if (body.method === 'notifications/initialized') {
        initialized = true;
        response.writeHead(202); response.end(); return;
      }
      if (!initialized) { response.writeHead(400); response.end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: handler(body) }));
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('registry did not bind');
  return `http://127.0.0.1:${address.port}/mcp`;
}

function configure(url: string, scope: unknown = SCOPE) {
  process.env.OMP_SPEC_REGISTRY_URL = url;
  process.env.OMP_SPEC_REGISTRY_TOKEN = 'fixture-token';
  process.env.AGENT_TEAMS_SPEC_SCOPE = JSON.stringify(scope);
}

function harness() {
  const tools: Registered[] = [];
  return {
    tools,
    server: { addTool(tool: Registered) { tools.push(tool); return tool as never; } } as never,
  };
}

function envelope(result: unknown) {
  if (!result || typeof result !== 'object' || !('content' in result) || !Array.isArray(result.content)) {
    throw new Error('MCP tool returned no content');
  }
  const first: unknown = result.content[0];
  if (!first || typeof first !== 'object' || !('text' in first) || typeof first.text !== 'string') {
    throw new Error('MCP tool returned no text content');
  }
  return JSON.parse(first.text);
}

describe('spec proxy readiness', () => {
  it.each(ENV_KEYS)('refuses startup when %s is missing', async (key) => {
    configure(await startRegistry(() => TOOLS));
    delete process.env[key];
    const { server, tools } = harness();
    await expect(registerSpecProxyTools(server)).rejects.toThrow();
    expect(tools).toHaveLength(0);
  });

  it.each([
    ['malformed JSON', '{'],
    ['empty project set', JSON.stringify({ projects: [], bindings: [] })],
    ['non-string project', JSON.stringify({ projects: [42], bindings: [] })],
    ['blank project', JSON.stringify({ projects: [' '], bindings: [] })],
    ['missing bindings', JSON.stringify({ projects: [PROJECT] })],
    ['foreign binding', JSON.stringify({ projects: [PROJECT], bindings: [{ project: 'foreign/project', spec: 'x' }] })],
    ['malformed binding', JSON.stringify({ projects: [PROJECT], bindings: [{ project: PROJECT, spec: 42 }] })],
  ])('refuses invalid scope: %s', async (_label, rawScope) => {
    configure(await startRegistry(() => TOOLS));
    process.env.AGENT_TEAMS_SPEC_SCOPE = rawScope;
    const { server, tools } = harness();
    await expect(registerSpecProxyTools(server)).rejects.toThrow();
    expect(tools).toHaveLength(0);
  });

  it.each([
    ['missing result tools', {}],
    ['empty tools', { tools: [] }],
    ['non-array tools', { tools: {} }],
    ['missing schema', { tools: [{ name: 'spec_patch' }] }],
    ['invalid schema', { tools: [{ name: 'spec_patch', inputSchema: 'invalid' }] }],
    ['non-object input schema', { tools: [{ name: 'spec_patch', inputSchema: { type: 'string' } }] }],
    ['untyped input schema', { tools: [{ name: 'spec_patch', inputSchema: {} }] }],
    ['malformed schema properties', { tools: [{ name: 'spec_patch', inputSchema: { type: 'object', properties: [] } }] }],
    ['partly malformed discovery', { tools: [TOOLS.tools[0], { inputSchema: {} }] }],
    ['duplicate names', { tools: [TOOLS.tools[0], TOOLS.tools[0]] }],
  ])('cannot register a ready surface after %s', async (_label, discovery) => {
    configure(await startRegistry(() => discovery));
    const { server, tools } = harness();
    await expect(registerSpecProxyTools(server)).rejects.toThrow();
    expect(tools).toHaveLength(0);
  });

  it('registers project-only scope so a team can create its first specification', async () => {
    let created = false;
    configure(await startRegistry((body) => {
      if (body.method === 'tools/list') return TOOLS;
      const params = body.params as { name: string; arguments: Record<string, unknown> };
      const args = params.arguments;
      if (params.name !== 'spec_patch' || args.intent !== 'createSpec' || args.project !== PROJECT || args.spec !== 'first-spec') {
        return { structuredContent: { ok: false, data: null, error: { code: 'INVALID_CREATE' } } };
      }
      // The registry contract for this operation has no teamId, including nested operations.
      if ('teamId' in args) return { structuredContent: { ok: false, data: null, error: { code: 'UNKNOWN_FIELD' } } };
      created = true;
      return { structuredContent: { ok: true, data: { spec: 'first-spec' }, error: null } };
    }), { projects: [PROJECT], bindings: [] });
    const { server, tools } = harness();
    await registerSpecProxyTools(server);
    const patch = tools.find((tool) => tool.name === 'team_spec_spec_patch');
    expect(patch, 'createSpec must be available before the first binding exists').toBeDefined();
    expect(envelope(await patch!.execute({ intent: 'createSpec', project: PROJECT, spec: 'first-spec' }))).toMatchObject({ ok: true });
    expect(created).toBe(true);
  });

  it.each(['spec_documents', 'spec_patch'])('blocks foreign-project %s before the registry receives it', async (name) => {
    let calls = 0;
    configure(await startRegistry((body) => {
      if (body.method === 'tools/list') return TOOLS;
      calls += 1;
      return { structuredContent: { ok: true, data: { kind: 'unexpected-access' }, error: null } };
    }));
    const { server, tools } = harness();
    await registerSpecProxyTools(server);
    const tool = tools.find((entry) => entry.name === `team_spec_${name}`)!;
    const result = envelope(await tool.execute({ action: 'read', intent: 'createSpec', project: 'foreign/project', spec: 'secret' }));
    expect(result).toMatchObject({ ok: false, data: null, error: { code: expect.any(String) } });
    expect(calls).toBe(0);
  });

  it('preserves a typed runtime registry refusal rather than returning successful empty data', async () => {
    configure(await startRegistry((body) => body.method === 'tools/list' ? TOOLS : {
      structuredContent: { ok: false, data: null, error: { code: 'CLAIM_HELD', message: 'spec is claimed' } },
      isError: true,
    }));
    const { server, tools } = harness();
    await registerSpecProxyTools(server);
    const patch = tools.find((tool) => tool.name === 'team_spec_spec_patch')!;
    expect(envelope(await patch.execute({ intent: 'patch' }))).toMatchObject({
      ok: false, data: null, error: { code: 'CLAIM_HELD', message: 'spec is claimed' },
    });
  });
});

// Captured verbatim from the registry's own `jsonSchemaFor(spec_patch)` output: roadmap
// authoring is two intent branches of the single spec_patch tool, not separate tools.
const ROADMAP_PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    intent: { type: 'string', enum: ['patch', 'createRoadmap', 'assembleRoadmap'] },
    schemaVersion: { type: 'string' },
    requestId: { type: ['string', 'null'] },
    reason: { type: 'string' },
    spec: { type: 'string' },
    dryRun: { type: 'boolean' },
    title: { type: 'string' },
    operations: {},
    project: { type: 'string' },
  },
  required: ['intent'],
  oneOf: [
    {
      type: 'object',
      title: 'intent: patch',
      description: 'Patch operations on one spec.',
      properties: {
        intent: { type: 'string', enum: ['patch'] },
        requestId: { type: 'string' },
        reason: { type: 'string' },
        spec: { type: 'string' },
        dryRun: { type: 'boolean' },
        operations: {},
      },
      required: ['intent', 'requestId', 'reason', 'spec', 'operations'],
    },
    {
      type: 'object',
      title: 'intent: createRoadmap',
      description: 'Preview or apply a ROADMAP.md skeleton for a roadmap-* spec.',
      properties: {
        intent: { type: 'string', enum: ['createRoadmap'] },
        requestId: { type: 'string' },
        reason: { type: 'string' },
        spec: { type: 'string' },
        dryRun: { type: 'boolean' },
        actorRef: { type: ['string', 'null'] },
        title: { type: 'string' },
      },
      required: ['intent', 'requestId', 'reason', 'spec'],
    },
    {
      type: 'object',
      title: 'intent: assembleRoadmap',
      description: 'Preview or apply graph-derived ROADMAP.md auto-assembly.',
      properties: {
        intent: { type: 'string', enum: ['assembleRoadmap'] },
        requestId: { type: 'string' },
        reason: { type: 'string' },
        spec: { type: 'string' },
        dryRun: { type: 'boolean' },
        actorRef: { type: ['string', 'null'] },
      },
      required: ['intent', 'requestId', 'reason', 'spec'],
    },
  ],
};

type PublishedParameters = {
  '~standard'?: { jsonSchema?: { input?: () => Record<string, unknown> } };
};

function publishedSchema(tool: Registered): Record<string, unknown> {
  const schema = (tool.parameters as PublishedParameters | undefined)?.['~standard']?.jsonSchema?.input?.();
  if (!schema) throw new Error('the registered tool published no JSON schema');
  return schema;
}

describe('roadmap authoring surface', () => {
  it('exposes the registry roadmap intents and delivers roadmap calls to the registry', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = [];
    configure(await startRegistry((body) => {
      if (body.method === 'tools/list') {
        return { tools: [{ name: 'spec_patch', description: 'Patch a specification', inputSchema: ROADMAP_PATCH_SCHEMA }] };
      }
      const params = body.params as { name: string; arguments: Record<string, unknown> };
      calls.push({ name: params.name, args: params.arguments });
      const assembled = params.arguments.intent === 'assembleRoadmap';
      return {
        structuredContent: {
          ok: true,
          data: { document: 'ROADMAP.md', linkedSpecs: assembled ? ['registry-check'] : [] },
          error: null,
        },
      };
    }));
    const { server, tools } = harness();
    await registerSpecProxyTools(server);

    const patch = tools.find((tool) => tool.name === 'team_spec_spec_patch');
    expect(patch, 'the registry spec_patch descriptor must reach the app tool surface').toBeDefined();
    const published = publishedSchema(patch!) as {
      properties: { intent: { enum: string[] } };
      oneOf: { title: string }[];
    };
    expect(published.properties.intent.enum).toEqual(
      expect.arrayContaining(['createRoadmap', 'assembleRoadmap'])
    );
    expect(published.oneOf.map((branch) => branch.title)).toEqual([
      'intent: patch',
      'intent: createRoadmap',
      'intent: assembleRoadmap',
    ]);
    // Identical to the registry descriptor: the app keeps no local copy of the schema.
    expect(published).toEqual(ROADMAP_PATCH_SCHEMA);

    const create = {
      intent: 'createRoadmap',
      spec: 'roadmap-growth',
      reason: 'author the growth roadmap',
      title: 'Growth roadmap',
      dryRun: false,
    };
    expect(envelope(await patch!.execute(create))).toEqual({
      ok: true,
      data: { document: 'ROADMAP.md', linkedSpecs: [] },
      error: null,
    });
    const assemble = {
      intent: 'assembleRoadmap',
      spec: 'roadmap-growth',
      reason: 'assemble the growth roadmap',
      dryRun: false,
    };
    expect(envelope(await patch!.execute(assemble))).toEqual({
      ok: true,
      data: { document: 'ROADMAP.md', linkedSpecs: ['registry-check'] },
      error: null,
    });

    expect(calls.map((call) => call.name)).toEqual(['spec_patch', 'spec_patch']);
    expect(calls[0].args).toMatchObject({ ...create, project: PROJECT });
    expect(calls[1].args).toMatchObject({ ...assemble, project: PROJECT });
    expect(calls[0].args.requestId).toEqual(expect.any(String));
  });
});
