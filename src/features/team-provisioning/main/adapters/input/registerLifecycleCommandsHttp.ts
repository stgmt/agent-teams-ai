import { BOUND_CONTROL_CONTEXT_HEADER } from '@features/external-agent-connection/contracts';
import { AppContextMismatchError } from '@features/external-agent-connection/main';

import { TeamRunMismatchError } from '../../../core/application/TeamRunMismatchError';
import { MemberRestartConflictError } from '../../../core/domain/MemberRestartConflictError';
import { MemberSkipConflictError } from '../../../core/domain/MemberSkipConflictError';

import type { LifecycleCommands } from '../../../core/application/ports/LifecycleCommands';
import type { FastifyInstance } from 'fastify';

/** Registered after the desktop control Host/Origin guard, never as an independent control server. */
export function registerLifecycleCommandsHttp(
  server: FastifyInstance,
  commands: LifecycleCommands
): void {
  for (const command of ['launch', 'stop', 'restart-member', 'skip-member'] as const) {
    server.post<{ Params: { teamName: string } }>(
      `/api/team-runtime/:teamName/${command}`,
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
          return reply.code(400).send({ error: 'Lifecycle commands accept no query fields' });
        const body = request.body ?? {};
        if (typeof body !== 'object' || Array.isArray(body))
          return reply.code(400).send({ error: 'A lifecycle command body must be an object' });
        const fields = body as Record<string, unknown>;
        const allowed =
          command === 'restart-member' || command === 'skip-member'
            ? ['runId', 'memberName', 'generation']
            : command === 'stop'
              ? ['runId']
              : [];
        if (Object.keys(fields).some((key) => !allowed.includes(key)))
          return reply
            .code(400)
            .send({ error: `Only ${allowed.join(', ') || 'no fields'} are accepted` });
        const input = { ...fields, expectedContext, teamName: request.params.teamName };
        try {
          if (command === 'launch') return await commands.launch(input);
          if (command === 'restart-member') return await commands.restartMember(input);
          if (command === 'skip-member') {
            await commands.skipMember(input);
            return { skipped: true };
          }
          await commands.stop(input);
          return { stopped: true };
        } catch (error) {
          if (error instanceof AppContextMismatchError) throw error;
          if (
            error instanceof TeamRunMismatchError ||
            error instanceof MemberRestartConflictError ||
            error instanceof MemberSkipConflictError
          )
            return reply.code(409).send({ error: error.message });
          if (error instanceof TypeError) return reply.code(400).send({ error: error.message });
          throw error;
        }
      }
    );
  }
}
