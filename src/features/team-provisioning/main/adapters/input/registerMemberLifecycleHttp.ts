import { AppContextMismatchError } from '@features/external-agent-connection/main';

import type { StartBoundMember } from '../../../core/application/commands/StartBoundMember';
import type { FastifyInstance } from 'fastify';

export function registerMemberLifecycleHttp(
  server: FastifyInstance,
  start: Pick<StartBoundMember, 'execute'>
): void {
  server.post('/api/team-runtime/member-start', async (request, reply) => {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ') || header.length > 512) {
      return reply.code(401).send({ error: 'A bound lead credential is required' });
    }
    try {
      return await start.execute(header.slice(7), request.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status =
        error instanceof AppContextMismatchError
          ? 409
          : message.startsWith('Unauthorized')
            ? 403
            : 400;
      return reply.code(status).send({ error: message });
    }
  });
}
