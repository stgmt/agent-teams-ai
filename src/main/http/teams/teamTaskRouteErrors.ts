import { ExecutionTaskStoreError } from '@main/services/team/execution/ExecutionTaskStore';
import { RegistryTaskProviderError } from '@main/services/team/registry/RegistryTaskProvider';
import { RegistryTeamTaskWriteError } from '@main/services/team/registry/RegistryTeamTaskWriter';
import { createLogger } from '@shared/utils/logger';

import type { FastifyReply } from 'fastify';

const logger = createLogger('HTTP:team-tasks');

interface TaskHttpErrorBody {
  code: string;
  message: string;
  currentStatus?: string | null;
}

/** A client-side failure of this adapter; already carries its HTTP status. */
export class TeamTaskHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'TeamTaskHttpError';
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function badRequest(code: string, message: string): TeamTaskHttpError {
  return new TeamTaskHttpError(400, code, message);
}
interface MappedTaskError {
  statusCode: number;
  body: TaskHttpErrorBody;
}

function isTeamNotFoundMessage(message: string): boolean {
  return message.startsWith('Team not found') || /^Team "[^"]+" not found\b/.test(message);
}

/** Typed failures → HTTP. Anything else is a genuine 500, never a guess. */
function mapTaskRouteError(error: unknown): MappedTaskError | null {
  if (error instanceof TeamTaskHttpError) {
    return { statusCode: error.statusCode, body: { code: error.code, message: error.message } };
  }

  if (error instanceof ExecutionTaskStoreError) {
    return { statusCode: 400, body: { code: 'INVALID_TASK_FIELD', message: error.message } };
  }

  if (error instanceof RegistryTeamTaskWriteError) {
    switch (error.code) {
      case 'REQUIREMENTS_REQUIRED':
        return { statusCode: 400, body: { code: error.code, message: error.message } };
      case 'TASK_NOT_FOUND':
        return { statusCode: 404, body: { code: error.code, message: error.message } };
      case 'STATUS_CONFLICT': {
        const currentStatus = error.details.currentStatus;
        return {
          statusCode: 409,
          body: {
            code: error.code,
            message: error.message,
            currentStatus: typeof currentStatus === 'string' ? currentStatus : null,
          },
        };
      }
      case 'LOCAL_ID_TAKEN':
      case 'LINK_CYCLE':
      case 'IDEMPOTENCY_CONFLICT':
      case 'CREATION_OUTCOME_UNKNOWN':
      case 'RELATIONSHIP_PARTIAL':
      case 'RELATIONSHIP_OUTCOME_UNKNOWN':
        return { statusCode: 409, body: { code: error.code, message: error.message } };
      case 'REGISTRY_REFUSED': {
        // A client failure inside the writer means the registry did not answer.
        // A refusal that reached the writer carries no `clientCode`.
        if (typeof error.details.clientCode === 'string') {
          return {
            statusCode: 503,
            body: {
              code: 'REGISTRY_UNAVAILABLE',
              message: 'The spec registry is unavailable; the write was not confirmed',
            },
          };
        }
        return { statusCode: 400, body: { code: error.code, message: error.message } };
      }
      default:
        return { statusCode: 400, body: { code: error.code, message: error.message } };
    }
  }

  if (error instanceof RegistryTaskProviderError) {
    if (error.code === 'REGISTRY_UNAVAILABLE') {
      return {
        statusCode: 503,
        body: {
          code: 'REGISTRY_UNAVAILABLE',
          message: 'The spec registry is unavailable; no task state could be read',
        },
      };
    }
    return { statusCode: 400, body: { code: error.code, message: error.message } };
  }

  if (error instanceof Error && isTeamNotFoundMessage(error.message)) {
    return { statusCode: 404, body: { code: 'TEAM_NOT_FOUND', message: error.message } };
  }

  return null;
}

export function sendTaskRouteError(
  reply: FastifyReply,
  error: unknown,
  route: string
): FastifyReply {
  const mapped = mapTaskRouteError(error);
  if (!mapped) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`Error in ${route}:`, detail);
    return reply.status(500).send({ code: 'INTERNAL_ERROR', message: 'Internal server error' });
  }
  if (mapped.statusCode >= 500) {
    logger.error(`Error in ${route}:`, mapped.body.message);
  }
  return reply.status(mapped.statusCode).send(mapped.body);
}
