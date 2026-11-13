import agentTeamsController from 'agent-teams-controller';
import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { jsonTextContent } from '../utils/format';

const { specGateway } = agentTeamsController;

/** Registry-owned tools and schemas, exposed only after scoped MCP discovery succeeds. */
const SPEC_URL_ENV = 'OMP_SPEC_REGISTRY_URL';
const SPEC_TOKEN_ENV = 'OMP_SPEC_REGISTRY_TOKEN';
const SPEC_SCOPE_ENV = 'AGENT_TEAMS_SPEC_SCOPE';
const TOOL_PREFIX = 'team_spec_';
const REQUEST_TIMEOUT_MS = 30_000;
const JsonObject = z.record(z.string(), z.unknown());
const RpcResponse = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  result: JsonObject.optional(),
  error: z.object({ code: z.number(), message: z.string().optional() }).optional(),
});

function registryError(code: string, message: string) {
  return Object.assign(new Error(message), { code });
}

function parseRpc(text: string, id: number) {
  if (text.trim().startsWith('{')) return RpcResponse.parse(JSON.parse(text));
  for (const frame of text.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) continue;
    const parsed = RpcResponse.safeParse(JSON.parse(data));
    if (parsed.success && parsed.data.id === id) return parsed.data;
  }
  throw registryError('REGISTRY_BAD_RESPONSE', 'Spec registry returned no matching MCP response');
}

/** One initialized Streamable HTTP session for discovery and subsequent calls. */
async function connectRegistry(url: string, token: string) {
  let sessionId: string | null = null;
  let protocolVersion: string | null = null;
  let nextId = 0;
  async function exchange(method: string, params: Record<string, unknown>, notification = false) {
    const id = ++nextId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
          ...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, params }),
        signal: controller.signal,
      });
      if (!response.ok) throw registryError(`REGISTRY_HTTP_${response.status}`, `Spec registry answered ${response.status}`);
      if (notification) {
        await response.body?.cancel();
        return {};
      }
      const payload = parseRpc(await response.text(), id);
      if (payload.id !== id) throw registryError('REGISTRY_BAD_RESPONSE', 'Spec registry returned a mismatched request id');
      if (payload.error) throw registryError(`REGISTRY_RPC_${payload.error.code}`, 'Spec registry refused the MCP request');
      if (!payload.result) throw registryError('REGISTRY_BAD_RESPONSE', 'Spec registry returned no MCP result');
      sessionId = response.headers.get('mcp-session-id') ?? sessionId;
      return payload.result;
    } finally {
      clearTimeout(timer);
    }
  }
  const initialized = await exchange('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'agent-teams-spec-proxy', version: '1.0.0' },
  });
  if (typeof initialized.protocolVersion !== 'string' || !initialized.protocolVersion) {
    throw registryError('REGISTRY_BAD_RESPONSE', 'Spec registry returned no negotiated protocol version');
  }
  protocolVersion = initialized.protocolVersion;
  await exchange('notifications/initialized', {}, true);
  return {
    async listTools() {
      const tools: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await exchange('tools/list', cursor ? { cursor } : {});
        if (!Array.isArray(page.tools)) throw registryError('REGISTRY_BAD_DISCOVERY', 'Spec registry returned no tools array');
        tools.push(...page.tools);
        if (page.nextCursor !== undefined && page.nextCursor !== null && typeof page.nextCursor !== 'string') {
          throw registryError('REGISTRY_BAD_DISCOVERY', 'Spec registry returned an invalid discovery cursor');
        }
        cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : undefined;
        if (cursor && cursors.has(cursor)) throw registryError('REGISTRY_BAD_DISCOVERY', 'Spec registry repeated a discovery cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { tools };
    },
    async callTool(name: string, args: Record<string, unknown>) {
      const result = await exchange('tools/call', { name, arguments: args });
      const structured = JsonObject.safeParse(result.structuredContent);
      if (!structured.success || typeof structured.data.ok !== 'boolean' || (result.isError === true && structured.data.ok)) {
        throw registryError('REGISTRY_BAD_RESPONSE', 'Spec registry returned no valid structured tool outcome');
      }
      return structured.data;
    },
  };
}

/** Publish the authoritative registry JSON Schema without maintaining a local copy. */
function jsonSchemaParameters(schema: Record<string, unknown>) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'agent-teams-spec-proxy',
      // The registry validates its own arguments; this adapter preserves its schema.
      validate: async (value: unknown) => ({ value }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  };
}

export async function registerSpecProxyTools(server: Pick<FastMCP, 'addTool'>): Promise<void> {
  const url = process.env[SPEC_URL_ENV]?.trim();
  const token = process.env[SPEC_TOKEN_ENV]?.trim();
  const rawScope = process.env[SPEC_SCOPE_ENV];
  if (!url || !token || !rawScope?.trim()) {
    throw registryError('SPEC_CONFIGURATION_REQUIRED', 'Team MCP requires registry URL, token and project scope');
  }
  let endpoint: URL;
  try { endpoint = new URL(url); }
  catch { throw registryError('SPEC_CONFIGURATION_INVALID', 'Spec registry URL is invalid'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) {
    throw registryError('SPEC_CONFIGURATION_INVALID', 'Spec registry requires an HTTP endpoint without embedded credentials or fragment');
  }
  let parsedScope: unknown;
  try { parsedScope = JSON.parse(rawScope); }
  catch { throw registryError('SPEC_CONFIGURATION_INVALID', 'Team spec scope is not valid JSON'); }
  const scope = specGateway.validateTeamSpecScope(parsedScope);
  const transport = await connectRegistry(url, token);
  const gateway = specGateway.createTeamSpecGateway({ transport, readScope: async () => scope });
  const tools = await gateway.listTools();
  for (const tool of tools) {
    server.addTool({
      name: `${TOOL_PREFIX}${tool.name}`,
      description: tool.description,
      parameters: jsonSchemaParameters(tool.inputSchema),
      execute: async (args: unknown) => {
        const input = JsonObject.parse(args);
        try {
          return jsonTextContent(await gateway.callTool(tool.name, input));
        } catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || typeof error.code !== 'string') throw error;
          const message = 'message' in error && typeof error.message === 'string' ? error.message : error.code;
          return jsonTextContent({ ok: false, data: null, error: { code: error.code, message }, diagnostics: [], provenance: null });
        }
      },
    });
  }
}
