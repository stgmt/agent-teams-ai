/**
 * Task routes for the HTTP sidecar.
 *
 * This module validates wire payloads, calls the public `TeamDataService`
 * methods that route canonical tasks to the spec registry, and maps typed
 * service failures onto HTTP status codes. It never reads the registry token.
 *
 * The MCP child process (`agent-teams-controller`) talks to these routes
 * instead of the task files, which is why the payloads carry the controller's
 * own vocabulary (`requirements`, `expectedStatus`) and why responses keep the
 * renderer-facing `TeamTask` shape unchanged.
 */
import {
  EXECUTION_TASK_LOCAL_FIELDS,
  ExecutionTaskStoreError,
  validateExecutionTaskPatch,
  type ExecutionTaskPatch,
} from '@main/services/team/execution/ExecutionTaskStore';
import { RegistryTaskProviderError } from '@main/services/team/registry/RegistryTaskProvider';
import { RegistryTeamTaskWriteError } from '@main/services/team/registry/RegistryTeamTaskWriter';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';
import { createLogger } from '@shared/utils/logger';

import type { HttpServices } from '../index';
import type {
  TeamHttpDataApi,
  TeamHttpTaskRelationshipType,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type {
  CreateTaskRequest,
  TaskFieldUpdates,
  TeamTask,
  TeamTaskStatus,
} from '@shared/types/team';
import type { FastifyInstance, FastifyReply } from 'fastify';

const logger = createLogger('HTTP:team-tasks');

/** Status transitions include registry-backed trash and restoration. */
const WRITABLE_TASK_STATUSES = ['pending', 'in_progress', 'completed', 'deleted'] as const;

const MAX_SUBJECT_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 20_000;
const MAX_REQUIREMENT_LENGTH = 200;
const MAX_REQUIREMENTS_COUNT = 200;
const MAX_OWNER_LENGTH = 200;
const MAX_GROUP_CHAT_ID_LENGTH = 200;
const MAX_PROMPT_LENGTH = 20_000;
const MAX_LINKS = 500;

type WriteStatus = (typeof WRITABLE_TASK_STATUSES)[number];

type TaskHttpErrorBody = {
  code: string;
  message: string;
  currentStatus?: string | null;
};

/** A client-side failure of this adapter; already carries its HTTP status. */
class TeamTaskHttpError extends Error {
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

function badRequest(code: string, message: string): TeamTaskHttpError {
  return new TeamTaskHttpError(400, code, message);
}

function requireTaskApi(services: HttpServices): TeamHttpDataApi {
  if (!services.teamDataApi) {
    throw new TeamTaskHttpError(
      501,
      'TEAM_DATA_UNAVAILABLE',
      'Team data control is not available in this mode'
    );
  }
  return services.teamDataApi;
}

function requireExactTeamName(teamName: string): string {
  const validation = validateTeamName(teamName);
  if (!validation.valid || validation.value !== teamName) {
    throw badRequest('INVALID_TEAM_NAME', 'Exact teamName is required');
  }
  return teamName;
}

function asBodyObject(body: unknown): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw badRequest('INVALID_TASK_BODY', 'Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function readOptionalString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
  preserveWhitespace = false
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw badRequest('INVALID_TASK_FIELD', `${field} must be a string`);
  }
  const result = preserveWhitespace ? value : value.trim();
  if (result.length > maxLength) {
    throw badRequest('INVALID_TASK_FIELD', `${field} must be at most ${maxLength} characters`);
  }
  return result;
}

function readRequiredText(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = readOptionalString(body, field, maxLength);
  if (!value) {
    throw badRequest('INVALID_TASK_FIELD', `${field} is required and must not be empty`);
  }
  return value;
}

function readStringArray(
  body: Record<string, unknown>,
  field: string,
  options: { maxCount: number; maxItemLength: number }
): string[] | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw badRequest('INVALID_TASK_FIELD', `${field} must be an array of strings`);
  }
  if (value.length > options.maxCount) {
    throw badRequest(
      'INVALID_TASK_FIELD',
      `${field} must contain at most ${options.maxCount} items`
    );
  }
  const normalized: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      throw badRequest('INVALID_TASK_FIELD', `${field} must be an array of strings`);
    }
    const trimmed = item.trim();
    if (!trimmed) {
      throw badRequest('INVALID_TASK_FIELD', `${field} must not contain empty strings`);
    }
    if (trimmed.length > options.maxItemLength) {
      throw badRequest(
        'INVALID_TASK_FIELD',
        `${field} items must be at most ${options.maxItemLength} characters`
      );
    }
    normalized.push(trimmed);
  }
  return normalized;
}

function readRequirements(body: Record<string, unknown>): string[] {
  const requirements = readStringArray(body, 'requirements', {
    maxCount: MAX_REQUIREMENTS_COUNT,
    maxItemLength: MAX_REQUIREMENT_LENGTH,
  });
  const unique = [...new Set(requirements ?? [])];
  if (unique.length === 0) {
    throw badRequest(
      'REQUIREMENTS_REQUIRED',
      'Tasks must name the requirements they implement (non-empty string array of FR/NFR/AC ids)'
    );
  }
  return unique;
}

function readWritableStatus(value: unknown, field: string): WriteStatus {
  if (typeof value !== 'string') {
    throw badRequest('INVALID_TASK_STATUS', `${field} must be a task status string`);
  }
  if (!(WRITABLE_TASK_STATUSES as readonly string[]).includes(value)) {
    throw badRequest(
      'INVALID_TASK_STATUS',
      `${field} must be one of ${WRITABLE_TASK_STATUSES.join(', ')}`
    );
  }
  return value as WriteStatus;
}

function readExecutionPatch(body: Record<string, unknown>): ExecutionTaskPatch {
  const fields: Record<string, unknown> = {};
  for (const key of EXECUTION_TASK_LOCAL_FIELDS) {
    if (Object.hasOwn(body, key)) fields[key] = body[key];
  }
  return validateExecutionTaskPatch(fields);
}

function parseCreateTaskBody(body: unknown): {
  request: CreateTaskRequest & { status?: TeamTaskStatus; actor?: string };
  execution: ExecutionTaskPatch;
} {
  const payload = asBodyObject(body);
  const subject = readRequiredText(payload, 'subject', MAX_SUBJECT_LENGTH);
  const requirements = readRequirements(payload);
  const description = readOptionalString(payload, 'description', MAX_DESCRIPTION_LENGTH, true);
  const owner = readOptionalString(payload, 'owner', MAX_OWNER_LENGTH);
  const groupChatId = readOptionalString(payload, 'groupChatId', MAX_GROUP_CHAT_ID_LENGTH);
  const prompt = readOptionalString(payload, 'prompt', MAX_PROMPT_LENGTH);
  const actor = readOptionalString(payload, 'actor', MAX_OWNER_LENGTH);
  const status =
    payload.status === undefined ? undefined : readWritableStatus(payload.status, 'status');
  const tracking = readOptionalString(payload, 'tracking', MAX_PROMPT_LENGTH);
  const blockedBy = readStringArray(payload, 'blockedBy', {
    maxCount: MAX_LINKS,
    maxItemLength: MAX_OWNER_LENGTH,
  });
  const related = readStringArray(payload, 'related', {
    maxCount: MAX_LINKS,
    maxItemLength: MAX_OWNER_LENGTH,
  });
  if (payload.startImmediately !== undefined && typeof payload.startImmediately !== 'boolean') {
    throw badRequest('INVALID_TASK_FIELD', 'startImmediately must be a boolean');
  }
  const execution = readExecutionPatch(payload);
  // These execution fields have the same bounds as the corresponding UI inputs.
  readOptionalString(payload, 'activeForm', MAX_SUBJECT_LENGTH);
  readOptionalString(payload, 'projectPath', MAX_PROMPT_LENGTH);

  return {
    request: {
      subject,
      description,
      requirements,
      ...(status ? { status } : {}),
      ...(actor ? { actor } : {}),
      ...(owner ? { owner } : {}),
      ...(groupChatId ? { groupChatId } : {}),
      ...(prompt ? { prompt } : {}),
      ...(tracking ? { tracking } : {}),
      ...(blockedBy ? { blockedBy } : {}),
      ...(related ? { related } : {}),
      ...(typeof payload.startImmediately === 'boolean'
        ? { startImmediately: payload.startImmediately }
        : {}),
      ...(execution.creationCommand ? { creationCommand: execution.creationCommand } : {}),
    },
    execution,
  };
}

function parseStatusBody(body: unknown): {
  status: WriteStatus;
  expectedStatus?: TeamTaskStatus;
  actor?: string;
} {
  const payload = asBodyObject(body);
  const status = readWritableStatus(payload.status, 'status');
  const expectedStatus =
    payload.expectedStatus === undefined
      ? undefined
      : (readWritableStatus(payload.expectedStatus, 'expectedStatus') as TeamTaskStatus);
  const actor = readOptionalString(payload, 'actor', MAX_OWNER_LENGTH);
  return { status, ...(expectedStatus ? { expectedStatus } : {}), ...(actor ? { actor } : {}) };
}

interface ParsedTaskPatch {
  actor?: string;
  execution: ExecutionTaskPatch;
  owner?: string | null;
  blockedBy?: string[];
  related?: string[];
  fields: TaskFieldUpdates;
}

function parsePatchBody(body: unknown): ParsedTaskPatch {
  const payload = asBodyObject(body);
  const patch: ParsedTaskPatch = {
    fields: {},
    execution: readExecutionPatch(payload),
    actor: readOptionalString(payload, 'actor', MAX_OWNER_LENGTH),
  };

  if ('owner' in payload) {
    const value = payload.owner;
    if (value === null) {
      patch.owner = null;
    } else if (typeof value === 'string') {
      const owner = readOptionalString(payload, 'owner', MAX_OWNER_LENGTH);
      if (owner) patch.owner = owner;
    } else {
      throw badRequest('INVALID_TASK_FIELD', 'owner must be a string or null');
    }
  }

  const blockedBy = readStringArray(payload, 'blockedBy', {
    maxCount: MAX_LINKS,
    maxItemLength: MAX_OWNER_LENGTH,
  });
  if (blockedBy !== undefined) patch.blockedBy = blockedBy;
  const related = readStringArray(payload, 'related', {
    maxCount: MAX_LINKS,
    maxItemLength: MAX_OWNER_LENGTH,
  });
  if (related !== undefined) patch.related = related;

  const subject = readOptionalString(payload, 'subject', MAX_SUBJECT_LENGTH);
  if (subject !== undefined) {
    if (!subject) throw badRequest('INVALID_TASK_FIELD', 'subject must not be empty');
    patch.fields.subject = subject;
  }
  const description = readOptionalString(payload, 'description', MAX_DESCRIPTION_LENGTH, true);
  if (description !== undefined) patch.fields.description = description;

  if (
    patch.owner === undefined &&
    patch.blockedBy === undefined &&
    patch.related === undefined &&
    Object.keys(patch.execution).length === 0 &&
    Object.keys(patch.fields).length === 0
  ) {
    throw badRequest('INVALID_TASK_BODY', 'Patch must carry at least one supported task field');
  }
  return patch;
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

function sendTaskRouteError(reply: FastifyReply, error: unknown, route: string): FastifyReply {
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

export function registerTeamTaskRoutes(app: FastifyInstance, services: HttpServices): void {
  app.get<{ Params: { teamName: string }; Querystring: { includeDeleted?: string } }>(
    '/api/teams/:teamName/tasks',
    async (request, reply) => {
      const route = `GET /api/teams/${request.params.teamName}/tasks`;
      try {
        const api = requireTaskApi(services);
        const teamName = requireExactTeamName(request.params.teamName);
        const tasks = await api.getTasks(teamName);
        const deleted =
          request.query.includeDeleted === 'true' ? await api.getDeletedTasks(teamName) : [];
        return reply.send({ tasks: [...tasks, ...deleted] });
      } catch (error) {
        return sendTaskRouteError(reply, error, route);
      }
    }
  );

  app.post<{ Params: { teamName: string }; Body: unknown }>(
    '/api/teams/:teamName/tasks',
    async (request, reply) => {
      const route = `POST /api/teams/${request.params.teamName}/tasks`;
      try {
        const api = requireTaskApi(services);
        const teamName = requireExactTeamName(request.params.teamName);
        const { request: input, execution } = parseCreateTaskBody(request.body);
        const { task, outcome } = await api.createTaskWithOutcome(teamName, input, execution);
        return reply.status(outcome === 'APPLIED' ? 201 : 200).send({ task, outcome });
      } catch (error) {
        return sendTaskRouteError(reply, error, route);
      }
    }
  );

  app.post<{ Params: { teamName: string; taskId: string }; Body: unknown }>(
    '/api/teams/:teamName/tasks/:taskId/status',
    async (request, reply) => {
      const route = `POST /api/teams/${request.params.teamName}/tasks/${request.params.taskId}/status`;
      try {
        const api = requireTaskApi(services);
        const teamName = requireExactTeamName(request.params.teamName);
        const taskId = request.params.taskId.trim();
        if (!taskId) throw badRequest('TASK_NOT_FOUND', 'Task id is required');
        const { status, expectedStatus, actor } = parseStatusBody(request.body);
        const transitions = await api.updateTaskStatusWithReceipt(
          teamName,
          taskId,
          status,
          actor,
          expectedStatus
        );
        const task = await api.getTask(teamName, taskId);
        if (!task) {
          return reply.status(404).send({
            code: 'TASK_NOT_FOUND',
            message: `Task "${taskId}" was not found in team "${teamName}"`,
          });
        }
        return reply.send({ task, transitions });
      } catch (error) {
        return sendTaskRouteError(reply, error, route);
      }
    }
  );

  app.patch<{ Params: { teamName: string; taskId: string }; Body: unknown }>(
    '/api/teams/:teamName/tasks/:taskId',
    async (request, reply) => {
      const route = `PATCH /api/teams/${request.params.teamName}/tasks/${request.params.taskId}`;
      try {
        const api = requireTaskApi(services);
        const teamName = requireExactTeamName(request.params.teamName);
        const taskId = request.params.taskId.trim();
        if (!taskId) throw badRequest('TASK_NOT_FOUND', 'Task id is required');
        const patch = parsePatchBody(request.body);

        const current = await api.getTask(teamName, taskId);
        if (!current) {
          return reply.status(404).send({
            code: 'TASK_NOT_FOUND',
            message: `Task "${taskId}" was not found in team "${teamName}"`,
          });
        }

        await applyLinkPatch(api, teamName, taskId, current, patch);
        if (patch.owner !== undefined) {
          await api.updateTaskOwner(teamName, taskId, patch.owner, patch.actor);
        }
        if (Object.keys(patch.fields).length > 0) {
          await api.updateTaskFields(teamName, taskId, patch.fields);
        }
        if (Object.keys(patch.execution).length > 0) {
          await api.applyTaskExecutionPatch(teamName, taskId, patch.execution);
        }

        const task = await api.getTask(teamName, taskId);
        if (!task) {
          return reply.status(404).send({
            code: 'TASK_NOT_FOUND',
            message: `Task "${taskId}" was not found in team "${teamName}"`,
          });
        }
        return reply.send({ task });
      } catch (error) {
        return sendTaskRouteError(reply, error, route);
      }
    }
  );
}

/**
 * PATCH arrays replace the current set, so the adapter diffs against the task
 * it just read and issues the add/remove calls the service exposes.
 */
async function applyLinkPatch(
  api: TeamHttpDataApi,
  teamName: string,
  taskId: string,
  current: TeamTask,
  patch: ParsedTaskPatch
): Promise<void> {
  const relations: Array<{
    type: TeamHttpTaskRelationshipType;
    desired: string[] | undefined;
    existing: string[] | undefined;
  }> = [
    { type: 'blockedBy', desired: patch.blockedBy, existing: current.blockedBy },
    { type: 'related', desired: patch.related, existing: current.related },
  ];

  for (const relation of relations) {
    if (relation.desired === undefined) continue;
    const desired = new Set(relation.desired);
    const existing = new Set((relation.existing ?? []).map((id) => id.trim()));
    for (const targetId of existing) {
      if (!desired.has(targetId)) {
        await api.removeTaskRelationship(teamName, taskId, targetId, relation.type);
      }
    }
    for (const targetId of desired) {
      if (!existing.has(targetId)) {
        await api.addTaskRelationship(teamName, taskId, targetId, relation.type);
      }
    }
  }
}
