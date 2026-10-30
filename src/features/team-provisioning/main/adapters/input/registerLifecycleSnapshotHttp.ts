import { BOUND_CONTROL_CONTEXT_HEADER } from '@features/external-agent-connection/contracts';
import { AppContextMismatchError } from '@features/external-agent-connection/main';

import type { LifecycleQueries } from '../../../core/application/ports/LifecycleQueries';
import type { FastifyInstance } from 'fastify';

/** Registered after the desktop control Host/Origin guard at the composition root. */
export function registerLifecycleSnapshotHttp(
  server: FastifyInstance,
  queries: Pick<LifecycleQueries, 'snapshot'>
): void {
  server.get<{ Params: { teamName: string } }>(
    '/api/team-runtime/:teamName',
    async (request, reply) => {
      const header = request.headers[BOUND_CONTROL_CONTEXT_HEADER];
      if (typeof header !== 'string' || header.length > 1024) throw new AppContextMismatchError();
      let expectedContext: unknown;
      try {
        expectedContext = JSON.parse(header);
      } catch {
        throw new AppContextMismatchError();
      }
      if (Object.keys(request.query ?? {}).length)
        return reply.code(400).send({ error: 'Lifecycle snapshot queries accept no query fields' });
      try {
        return await queries.snapshot({ expectedContext, teamName: request.params.teamName });
      } catch (error) {
        if (error instanceof AppContextMismatchError) throw error;
        if (error instanceof TypeError) return reply.code(400).send({ error: error.message });
        throw error;
      }
    }
  );
}
