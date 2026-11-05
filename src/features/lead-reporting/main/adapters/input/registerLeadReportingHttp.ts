import { boundedDiagnosticString } from '@shared/utils/diagnosticsRedaction';
import { z } from 'zod';

import type { LeadReporting } from '../../../core/application/LeadReporting';
import type { NodeLeadReporting } from '../../composition/createNodeLeadReporting';
import type { FastifyInstance } from 'fastify';

function diagnostic(error: unknown, defaultMessage: string): string {
  return (
    boundedDiagnosticString(error instanceof Error ? error.message : undefined) ?? defaultMessage
  );
}

const statement = z
  .object({
    kind: z.enum(['result', 'blocker', 'action', 'observation']),
    text: z.string().trim().min(1).max(4000),
    evidenceIds: z.array(z.string().min(1).max(512)).min(1).max(100),
  })
  .strict();

const draftSchema = z
  .object({
    inspectionId: z.string().min(1).max(256),
    summary: z.string().trim().min(1).max(4000),
    members: z
      .array(
        z
          .object({
            memberName: z.string().min(1).max(200),
            statements: z.array(statement).min(1).max(20),
          })
          .strict()
      )
      .max(200),
    nextStep: z.string().trim().min(1).max(4000),
  })
  .strict();

/** Register behind the application's bound Host/Origin admission, with its existing lead credential. */
export function registerLeadReportingHttp(
  server: FastifyInstance,
  input: {
    reports: LeadReporting;
    reply: NodeLeadReporting['reply'];
  }
): void {
  const feature = input.reports;
  const credential = (authorization: string | undefined): string => {
    if (!authorization?.startsWith('Bearer ') || authorization.length > 512)
      throw new Error('Unauthorized lead reporting request');
    return authorization.slice(7);
  };
  server.post('/api/lead-reporting/inspect', async (request, reply) => {
    try {
      if (!z.object({}).strict().safeParse(request.body).success)
        return reply.code(400).send({ error: 'Inspection accepts only an empty object' });
      return await feature.briefing(credential(request.headers.authorization));
    } catch (error) {
      const message = diagnostic(error, 'Inspection failed');
      return reply.code(message.startsWith('Unauthorized') ? 403 : 409).send({ error: message });
    }
  });
  server.post('/api/lead-reporting/reply', async (request, reply) => {
    const parsed = z
      .object({
        requestMessageId: z.string().min(1).max(256),
        text: z.string().trim().min(1).max(32_000),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid ordinary reply' });
    try {
      return await input.reply(
        credential(request.headers.authorization),
        parsed.data.requestMessageId,
        parsed.data.text
      );
    } catch (error) {
      const message = diagnostic(error, 'Reply failed');
      return reply.code(message.startsWith('Unauthorized') ? 403 : 409).send({ error: message });
    }
  });
  server.post('/api/lead-reporting/publish', async (request, reply) => {
    const parsed = draftSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid lead report draft' });
    try {
      return await feature.publish(credential(request.headers.authorization), parsed.data);
    } catch (error) {
      const message = diagnostic(error, 'Publication failed');
      return reply.code(message.startsWith('Unauthorized') ? 403 : 409).send({ error: message });
    }
  });
}
