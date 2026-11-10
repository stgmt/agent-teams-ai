import { specGateway } from 'agent-teams-controller';
import type { FastMCP } from 'fastmcp';

import { jsonTextContent } from '../utils/format';

/**
 * The specification registry surface, proxied under the app's own MCP server.
 *
 * The registry owns the tools and their argument schemas; this module only
 * forwards them. Tool descriptors are read once from the registry at startup, so
 * a contract change upstream needs no edit here. Team scope (bound
 * `project`/`spec` pairs and the registry team id) arrives with the launch.
 */

const SPEC_URL_ENV = 'OMP_SPEC_REGISTRY_URL';
const SPEC_TOKEN_ENV = 'OMP_SPEC_REGISTRY_TOKEN';
const SPEC_SCOPE_ENV = 'AGENT_TEAMS_SPEC_SCOPE';
const TOOL_PREFIX = 'team_spec_';
const REQUEST_TIMEOUT_MS = 30_000;

interface SpecScopeEnv {
  teamId: string | null;
  bindings: { project: string; spec: string }[];
}

type JsonRpcResponse = {
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

async function readRpc(url: string, token: string, method: string, params: Record<string, unknown>) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw Object.assign(new Error(`spec registry answered ${response.status}`), {
        code: `REGISTRY_HTTP_${response.status}`,
      });
    }
    const text = await response.text();
    const payload = text.trim().startsWith('{')
      ? (JSON.parse(text) as JsonRpcResponse)
      : parseEventStream(text);
    if (!payload) throw Object.assign(new Error('spec registry returned no payload'), { code: 'REGISTRY_BAD_RESPONSE' });
    if (payload.error) {
      throw Object.assign(new Error(payload.error.message ?? 'spec registry error'), {
        code: `REGISTRY_RPC_${payload.error.code ?? 'ERROR'}`,
      });
    }
    return payload.result ?? {};
  } finally {
    clearTimeout(timer);
  }
}

/** The registry may answer as a single event-stream frame; take its data line. */
function parseEventStream(text: string): JsonRpcResponse | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    try {
      return JSON.parse(trimmed.slice('data:'.length).trim()) as JsonRpcResponse;
    } catch {
      continue;
    }
  }
  return null;
}

/** Publishes the upstream JSON Schema unchanged through Standard Schema. */
function jsonSchemaParameters(schema: Record<string, unknown>) {
  return {
    '~standard': {
      version: 1 as const,
      vendor: 'agent-teams-spec-proxy',
      validate: async (value: unknown) => ({ value }),
      jsonSchema: {
        input: () => schema,
        output: () => schema,
      },
    },
  };
}

function readScope(): SpecScopeEnv | null {
  const raw = process.env[SPEC_SCOPE_ENV];
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as SpecScopeEnv;
    if (!Array.isArray(parsed.bindings)) return null;
    return {
      teamId: typeof parsed.teamId === 'string' && parsed.teamId.trim() ? parsed.teamId : null,
      bindings: parsed.bindings
        .filter((binding) => binding && typeof binding.project === 'string' && typeof binding.spec === 'string')
        .map((binding) => ({ project: binding.project, spec: binding.spec })),
    };
  } catch {
    return null;
  }
}

/**
 * Registers every registry tool as `team_spec_<name>`. A team with no scope, or
 * a launch without registry coordinates, simply gets no spec tools.
 */
export async function registerSpecProxyTools(server: Pick<FastMCP, 'addTool'>): Promise<void> {
  const url = process.env[SPEC_URL_ENV]?.trim();
  const token = process.env[SPEC_TOKEN_ENV]?.trim();
  const scope = readScope();
  if (!url || !token || !scope || scope.bindings.length === 0) return;

  const transport = {
    listTools: () => readRpc(url, token, 'tools/list', {}),
    callTool: async (name: string, args: Record<string, unknown>) => {
      const result = (await readRpc(url, token, 'tools/call', {
        name,
        arguments: args,
      })) as { structuredContent?: unknown; content?: unknown; isError?: unknown };
      // The registry answers with its own envelope in structuredContent.
      const structured = result.structuredContent;
      if (structured && typeof structured === 'object') {
        return structured as Record<string, unknown>;
      }
      return {
        ok: false,
        data: null,
        error: {
          code: 'REGISTRY_EMPTY_RESPONSE',
          message: 'spec registry returned no structured payload',
        },
        diagnostics: [],
        provenance: null,
      };
    },
  };
  const gateway = specGateway.createTeamSpecGateway({ transport, readScope: async () => scope });
  const tools = await gateway.listTools();
  for (const tool of tools) {
    server.addTool({
      name: `${TOOL_PREFIX}${tool.name}`,
      description: tool.description,
      parameters: jsonSchemaParameters(tool.inputSchema),
      execute: async (args: unknown) => {
        const input = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
        try {
          return jsonTextContent(await gateway.callTool(tool.name, input));
        } catch (error) {
          // A team-scope refusal is a typed answer, not a crash: forward its code.
          const code = (error as { code?: unknown }).code;
          const message = (error as { message?: unknown }).message;
          if (typeof code !== 'string') throw error;
          return jsonTextContent({
            ok: false,
            data: null,
            error: { code, message: typeof message === 'string' ? message : code },
            diagnostics: [],
            provenance: null,
          });
        }
      },
    });
  }
}
