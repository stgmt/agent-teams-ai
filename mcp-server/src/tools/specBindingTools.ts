import { appScopedSpecBindings } from 'agent-teams-controller';
import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { jsonTextContent } from '../utils/format';


interface TeamSpecBindingToolOptions {
  requestScopedCapability?: boolean;
}

function requestScopedCapability(context: unknown, enabled: boolean): string | null | undefined {
  if (!enabled) return undefined;
  if (!context || typeof context !== 'object') return null;
  const session = (context as { session?: unknown }).session;
  if (!session || typeof session !== 'object' || Array.isArray(session)) return null;
  const credential = (session as Record<string, unknown>).appMcpScopeCredential;
  return typeof credential === 'string' &&
    credential.trim() === credential &&
    credential.length > 0 &&
    credential.length <= 512
    ? credential
    : null;
}

export function registerTeamSpecBindingTools(
  server: Pick<FastMCP, 'addTool'>,
  options: TeamSpecBindingToolOptions = {}
): void {
  server.addTool({
    name: 'team_spec_bindings',
    description:
      'Read registry project/spec bindings for the exact authenticated MCP runtime. Team identity cannot be selected by tool arguments.',
    parameters: z.object({}).strict(),
    execute: async (_args, context) => {
      const credential = requestScopedCapability(
        context,
        options.requestScopedCapability === true
      );
      const bindings = await Promise.resolve(
        appScopedSpecBindings.listTeamSpecBindings(credential)
      );
      return jsonTextContent({ bindings });
    },
  });

  server.addTool({
    name: 'team_link_spec',
    description:
      'Link a registry project/spec to the exact authenticated MCP runtime. The app resolves team identity and the registry authorizes the binding; no team id is accepted.',
    parameters: z
      .object({
        project: z.string().trim().min(1).max(200),
        spec: z.string().trim().min(1).max(200),
      })
      .strict(),
    execute: async ({ project, spec }, context) => {
      const credential = requestScopedCapability(
        context,
        options.requestScopedCapability === true
      );
      const bindings = await Promise.resolve(
        appScopedSpecBindings.linkTeamSpec({ project, spec }, credential)
      );
      return jsonTextContent({ bindings });
    },
  });
}
