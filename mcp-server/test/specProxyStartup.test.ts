// @vitest-environment node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

const cwd = fileURLToPath(new URL('..', import.meta.url));
const entrypoint = fileURLToPath(new URL('../src/index.ts', import.meta.url));
const PROJECT = 'stgm/tokenplan';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const RpcSchema = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.unknown().optional() });
type Rpc = z.infer<typeof RpcSchema>;
const RegistryRequestSchema = z.object({
  id: z.number().optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional(),
});
type RegistryRequest = z.infer<typeof RegistryRequestSchema>;
const ToolCallSchema = z.object({
  name: z.string(),
  arguments: z.object({
    project: z.string(), spec: z.string().optional(), title: z.string().optional(), intent: z.string().optional(),
  }).passthrough(),
});
const ToolResultSchema = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ text: z.string() })) });
const ToolListSchema = z.object({ tools: z.array(z.object({ name: z.string(), inputSchema: z.record(z.string(), z.unknown()) })) });

// Run the editable source, never a potentially stale dist build. Only this
// fixture's own MCP children are terminated by cleanup.
function launch(environment: NodeJS.ProcessEnv) {
  const env = { ...process.env };
  for (const key of ['OMP_SPEC_REGISTRY_URL', 'OMP_SPEC_REGISTRY_TOKEN', 'AGENT_TEAMS_SPEC_SCOPE']) delete env[key];
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint, '--transport', 'stdio'], {
    cwd, env: { ...env, ...environment }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let moduleLoadFailed = false;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (text: string) => {
    moduleLoadFailed ||= /SyntaxError|ERR_MODULE_NOT_FOUND|Cannot find module|does not provide an export/.test(text);
  });
  const pending = new Map<number, PromiseWithResolvers<Rpc>>();
  const exited = Promise.withResolvers<number | null>();
  let buffer = '';
  let id = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = RpcSchema.parse(JSON.parse(line));
        if (typeof message.id === 'number') {
          pending.get(message.id)?.resolve(message);
          pending.delete(message.id);
        }
      } catch {
        for (const waiter of pending.values()) waiter.reject(new Error('MCP emitted non-JSON stdout'));
      }
    }
  });
  child.once('error', (error) => {
    exited.reject(error);
    for (const waiter of pending.values()) waiter.reject(error);
  });
  child.once('exit', (code) => {
    exited.resolve(code);
    for (const waiter of pending.values()) waiter.resolve({ error: 'MCP exited before replying' });
    pending.clear();
  });
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited.promise;
  });
  return {
    exited: exited.promise,
    moduleLoadFailed: () => moduleLoadFailed,
    notify(method: string) { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`); },
    async request(method: string, params: Record<string, unknown>) {
      const requestId = ++id;
      const waiter = Promise.withResolvers<Rpc>();
      pending.set(requestId, waiter);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
      try { return await waiter.promise; }
      finally { pending.delete(requestId); }
    },
  };
}

async function startRegistry(handler: (request: http.IncomingMessage, response: http.ServerResponse, body: RegistryRequest) => void) {
  let initialized = false;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = RegistryRequestSchema.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      if (body.method === 'initialize') {
        response.setHeader('mcp-session-id', 'fixture-session');
        reply(response, body.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'registry-fixture', version: '1' } });
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
      handler(request, response, body);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(async () => {
    server.closeAllConnections();
    const closed = once(server, 'close');
    server.close();
    await closed;
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('registry did not bind');
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}

function reply(response: http.ServerResponse, id: number | undefined, result: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function configuration(url: string, bindings: { project: string; spec: string }[] = []) {
  return {
    OMP_SPEC_REGISTRY_URL: url,
    OMP_SPEC_REGISTRY_TOKEN: 'fixture-token',
    AGENT_TEAMS_SPEC_SCOPE: JSON.stringify({ projects: [PROJECT], bindings }),
  };
}

const initialization = {
  protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'spec-readiness-test', version: '1' },
};

function payload(response: Rpc) {
  expect(response.error).toBeUndefined();
  const result = ToolResultSchema.parse(response.result);
  expect(result.isError).not.toBe(true);
  return JSON.parse(result.content[0].text);
}

describe('spec integration at the real MCP startup boundary', () => {
  it.each(['missing configuration', 'malformed scope', 'HTTP refusal', 'RPC refusal', 'unreachable registry', 'empty discovery', 'malformed discovery'])('does not acknowledge a ready MCP session after %s', async (failure) => {
    const registry = await startRegistry((_request, response, body) => {
      if (failure === 'HTTP refusal') { response.writeHead(403); response.end(); return; }
      if (failure === 'RPC refusal') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32001, message: 'access refused' } }));
        return;
      }
      reply(response, body.id, failure === 'malformed discovery' ? { tools: [{ name: 'spec_patch', inputSchema: null }] } : { tools: [] });
    });
    if (failure === 'unreachable registry') {
      const closed = once(registry.server, 'close');
      registry.server.close();
      await closed;
      // Already closed: remove only this fixture's registry cleanup.
      cleanups.pop();
    }
    const env: NodeJS.ProcessEnv = failure === 'missing configuration' ? {} : configuration(registry.url, [{ project: PROJECT, spec: 'existing' }]);
    if (failure === 'malformed scope') env.AGENT_TEAMS_SPEC_SCOPE = '{';
    const session = launch(env);
    const response = await session.request('initialize', initialization);
    expect(response.result, 'spec discovery failure must prevent initialize success').toBeUndefined();
    expect(await session.exited).not.toBe(0);
    expect(session.moduleLoadFailed(), 'an import failure is not a behavioral readiness refusal').toBe(false);
  }, 15_000);

  it('publishes current schemas and executes every published read/write tool in the very first project-only session', async () => {
    const documents = new Map<string, string>();
    const descriptors = [
      {
        name: 'spec_patch', description: 'Create a specification',
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: { intent: { enum: ['createSpec'] }, project: { type: 'string' }, spec: { type: 'string' }, title: { type: 'string', minLength: 3 }, requestId: { type: 'string' } },
          required: ['intent', 'project', 'spec', 'title'],
        },
      },
      {
        name: 'spec_documents', description: 'Read a specification',
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: { action: { enum: ['read'] }, project: { type: 'string' }, spec: { type: 'string' }, doc: { enum: ['SPEC.md'] }, requestId: { type: 'string' } },
          required: ['action', 'project', 'spec', 'doc'],
        },
      },
      {
        name: 'spec_catalog', description: 'List specifications',
        inputSchema: {
          type: 'object', additionalProperties: false,
          properties: { view: { enum: ['specs'] }, project: { type: 'string' }, requestId: { type: 'string' } },
          required: ['view', 'project'],
        },
      },
    ];
    let registryCalls = 0;
    const registry = await startRegistry((request, response, body) => {
      if (request.headers.authorization !== 'Bearer fixture-token') { response.writeHead(401); response.end(); return; }
      if (body.method === 'tools/list') { reply(response, body.id, { tools: descriptors }); return; }
      registryCalls += 1;
      const { name, arguments: args } = ToolCallSchema.parse(body.params);
      const descriptor = descriptors.find((tool) => tool.name === name);
      const allowedFields = Object.keys(descriptor?.inputSchema.properties ?? {});
      if (!descriptor || Object.keys(args).some((key) => !allowedFields.includes(key))) {
        reply(response, body.id, { isError: true, structuredContent: { ok: false, data: null, error: { code: 'UNKNOWN_FIELD' } } });
        return;
      }
      if (args.project !== PROJECT) { response.writeHead(403); response.end(); return; }
      if (name === 'spec_patch') {
        if (args.intent !== 'createSpec' || typeof args.spec !== 'string' || typeof args.title !== 'string' || args.title.length < 3) { response.writeHead(400); response.end(); return; }
        documents.set(args.spec, `# ${args.title}\n`);
        reply(response, body.id, { structuredContent: { ok: true, data: { created: args.spec }, error: null } });
      } else if (name === 'spec_documents') {
        reply(response, body.id, { structuredContent: { ok: true, data: { content: documents.get(args.spec ?? '') }, error: null } });
      } else {
        reply(response, body.id, { structuredContent: { ok: true, data: { specs: [...documents.keys()] }, error: null } });
      }
    });
    const session = launch(configuration(registry.url));
    const initialized = await session.request('initialize', initialization);
    expect(initialized.error).toBeUndefined();
    expect(initialized.result).toBeDefined();
    session.notify('notifications/initialized');
    const listed = await session.request('tools/list', {});
    expect(listed.error).toBeUndefined();
    const published = ToolListSchema.parse(listed.result).tools.filter((tool) => tool.name.startsWith('team_spec_'));
    expect(published).toHaveLength(descriptors.length);
    for (const descriptor of descriptors) {
      expect(published.find((tool: { name: string }) => tool.name === `team_spec_${descriptor.name}`)?.inputSchema).toEqual(descriptor.inputSchema);
    }
    const created = payload(await session.request('tools/call', { name: 'team_spec_spec_patch', arguments: { intent: 'createSpec', project: PROJECT, spec: 'first-spec', title: 'First specification' } }));
    expect(created).toMatchObject({ ok: true, data: { created: 'first-spec' } });
    const read = payload(await session.request('tools/call', { name: 'team_spec_spec_documents', arguments: { action: 'read', project: PROJECT, spec: 'first-spec', doc: 'SPEC.md' } }));
    expect(read).toMatchObject({ ok: true, data: { content: '# First specification\n' } });
    const catalog = payload(await session.request('tools/call', { name: 'team_spec_spec_catalog', arguments: { view: 'specs', project: PROJECT } }));
    expect(catalog).toMatchObject({ ok: true, data: { specs: ['first-spec'] } });
    expect(registryCalls).toBe(3);
  }, 15_000);
});
