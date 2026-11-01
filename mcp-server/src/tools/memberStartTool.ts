import type { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { jsonTextContent } from '../utils/format';

export interface BoundLeadMemberStart {
  start(memberName: string): Promise<unknown>;
}

export function createBoundLeadMemberStart(env: NodeJS.ProcessEnv): BoundLeadMemberStart {
  const controlUrl = env.AGENT_TEAMS_BOUND_CONTROL_URL;
  const credential = env.AGENT_TEAMS_LEAD_START_CREDENTIAL;
  if (!controlUrl || !credential || credential.length > 256) throw new Error('Bound lead start context is required');
  const url = new URL(controlUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ||
    !url.port || url.origin !== controlUrl) throw new Error('Invalid bound lead control URL');
  return {
    async start(memberName) {
      const response = await fetch(`${url.origin}/api/team-runtime/member-start`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${credential}` },
        body: JSON.stringify({ memberName }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(`Member start rejected (${response.status})`);
      return body;
    },
  };
}

export function registerMemberStartTool(server: Pick<FastMCP, 'addTool'>, lead: BoundLeadMemberStart): void {
  server.addTool({
    name: 'member_start',
    description: 'Start an existing configured member of your own team. A running member is not restarted; repeated requests share one start operation. This cannot create teams or members.',
    parameters: z.object({ memberName: z.string().min(1).max(200) }).strict(),
    execute: async ({ memberName }) => jsonTextContent(await lead.start(memberName)),
  });
}
