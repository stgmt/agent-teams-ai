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
import { createHash } from 'node:crypto';

import {
  EXECUTION_TASK_LOCAL_FIELDS,
  type ExecutionTaskPatch,
  validateExecutionTaskPatch,
} from '@main/services/team/execution/ExecutionTaskStore';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';

import { badRequest, sendTaskRouteError, TeamTaskHttpError } from './teamTaskRouteErrors';

import type { HttpServices } from '../index';
import type {
  TeamHttpDataApi,
  TeamHttpTaskRelationshipType,
  TeamHttpTaskScope,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type {
  CreateTaskRequest,
  TaskArtifactFile,
  TaskFieldUpdates,
  TeamTask,
  TeamTaskStatus,
} from '@shared/types/team';
import type { FastifyInstance } from 'fastify';

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
const MAX_TASK_ARTIFACT_BYTES = 20 * 1024 * 1024;
const MAX_TASK_ARTIFACT_BASE64_CHARS = Math.ceil(MAX_TASK_ARTIFACT_BYTES / 3) * 4;
const MAX_TASK_PATCH_BODY_BYTES = MAX_TASK_ARTIFACT_BASE64_CHARS + 64 * 1024;

type WriteStatus = (typeof WRITABLE_TASK_STATUSES)[number];

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
function readTaskScope(value: Record<string, unknown>): TeamHttpTaskScope | undefined {
  const project = readOptionalString(value, 'project', 200);
  const spec = readOptionalString(value, 'spec', 200);
  if (project === undefined && spec === undefined) return undefined;
  if (!project || !spec) {
    throw badRequest('INVALID_TASK_SCOPE', 'project and spec must be provided together');
  }
  return { project, spec };
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

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;

function isCanonicalBase64(value: string): boolean {
  if (
    value.length > MAX_TASK_ARTIFACT_BASE64_CHARS ||
    value.length % 4 !== 0 ||
    !CANONICAL_BASE64.test(value)
  ) {
    return false;
  }
  if (value.endsWith('==')) {
    const lastValue = BASE64_ALPHABET.indexOf(value.charAt(value.length - 3));
    return lastValue >= 0 && (lastValue & 0x0f) === 0;
  }
  if (value.endsWith('=')) {
    const lastValue = BASE64_ALPHABET.indexOf(value.charAt(value.length - 2));
    return lastValue >= 0 && (lastValue & 0x03) === 0;
  }
  return true;
}

function isSafeArtifactFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/:\x00-\x1f\x7f]/u.test(value)
  );
}

function readTaskArtifactFile(value: unknown): TaskArtifactFile {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw badRequest('INVALID_TASK_FIELD', 'artifactFile must contain filename and base64Data');
  }
  const keys = Reflect.ownKeys(value);
  const filenameDescriptor = Object.getOwnPropertyDescriptor(value, 'filename');
  const base64Descriptor = Object.getOwnPropertyDescriptor(value, 'base64Data');
  if (
    keys.length !== 2 ||
    keys.some((key) => key !== 'filename' && key !== 'base64Data') ||
    !filenameDescriptor ||
    !('value' in filenameDescriptor) ||
    !base64Descriptor ||
    !('value' in base64Descriptor)
  ) {
    throw badRequest(
      'INVALID_TASK_FIELD',
      'artifactFile must contain only filename and base64Data'
    );
  }
  const rawFilename = filenameDescriptor.value;
  const base64Data = base64Descriptor.value;
  if (typeof rawFilename !== 'string' || typeof base64Data !== 'string') {
    throw badRequest('INVALID_TASK_FIELD', 'artifactFile must contain filename and base64Data');
  }
  const filename = rawFilename.trim();
  if (!isSafeArtifactFilename(filename)) {
    throw badRequest('INVALID_TASK_FIELD', 'artifactFile.filename must be a safe filename');
  }
  if (!isCanonicalBase64(base64Data)) {
    throw badRequest(
      'INVALID_TASK_FIELD',
      'artifactFile.base64Data must be canonical base64 within 20 MiB'
    );
  }
  return { filename, base64Data };
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
  const hasProject = Object.hasOwn(payload, 'project');
  const hasSpec = Object.hasOwn(payload, 'spec');
  const hasSpecProject = Object.hasOwn(payload, 'specProject');
  const hasSpecSlug = Object.hasOwn(payload, 'specSlug');
  const hasRequirements = Object.hasOwn(payload, 'requirements');
  const usingLegacyScope = hasProject || hasSpec;
  const usingCanonicalScope = hasSpecProject || hasSpecSlug;
  let registryScope: { specProject: string; specSlug: string; requirements: string[] } | undefined;
  if (usingLegacyScope || usingCanonicalScope || hasRequirements) {
    if (
      (usingLegacyScope && usingCanonicalScope) ||
      (usingLegacyScope && !(hasProject && hasSpec)) ||
      (usingCanonicalScope && !(hasSpecProject && hasSpecSlug)) ||
      (!usingLegacyScope && !usingCanonicalScope)
    ) {
      throw badRequest(
        'INVALID_TASK_SCOPE',
        'A registry task requires project, spec, and requirements together'
      );
    }
    const project = readRequiredText(payload, usingLegacyScope ? 'project' : 'specProject', 200);
    const spec = readRequiredText(payload, usingLegacyScope ? 'spec' : 'specSlug', 200);
    registryScope = {
      specProject: project,
      specSlug: spec,
      requirements: readRequirements(payload),
    };
  }
  // These execution fields have the same bounds as the corresponding UI inputs.
  readOptionalString(payload, 'activeForm', MAX_SUBJECT_LENGTH);
  readOptionalString(payload, 'projectPath', MAX_PROMPT_LENGTH);

  const commonRequest = {
    subject,
    description,
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
  };
  return {
    request: registryScope ? { ...commonRequest, ...registryScope } : commonRequest,
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
  if (Object.hasOwn(payload, 'requirements')) {
    patch.fields.requirements = readRequirements(payload);
  }
  if (Object.hasOwn(payload, 'artifactRequired')) {
    if (typeof payload.artifactRequired !== 'boolean') {
      throw badRequest('INVALID_TASK_FIELD', 'artifactRequired must be a boolean');
    }
    patch.fields.artifactRequired = payload.artifactRequired;
  }
  const artifactExpectedFilename = readOptionalString(payload, 'artifactExpectedFilename', 255);
  if (artifactExpectedFilename !== undefined) {
    if (!isSafeArtifactFilename(artifactExpectedFilename)) {
      throw badRequest('INVALID_TASK_FIELD', 'artifactExpectedFilename must be a safe filename');
    }
    patch.fields.artifactExpectedFilename = artifactExpectedFilename;
  }
  if (Object.hasOwn(payload, 'artifactFile')) {
    patch.fields.artifactFile = readTaskArtifactFile(payload.artifactFile);
  }

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

export function registerTeamTaskRoutes(app: FastifyInstance, services: HttpServices): void {
  app.get<{
    Params: { teamName: string };
    Querystring: { includeDeleted?: string; project?: string; spec?: string };
  }>('/api/teams/:teamName/tasks', async (request, reply) => {
    const route = `GET /api/teams/${request.params.teamName}/tasks`;
    try {
      const api = requireTaskApi(services);
      const teamName = requireExactTeamName(request.params.teamName);
      const scope = readTaskScope(request.query);
      const tasks = await api.getTasks(teamName, scope);
      const deleted =
        request.query.includeDeleted === 'true' ? await api.getDeletedTasks(teamName, scope) : [];
      return reply.send({ tasks: [...tasks, ...deleted] });
    } catch (error) {
      return sendTaskRouteError(reply, error, route);
    }
  });

  app.get<{
    Params: { teamName: string; taskId: string };
    Querystring: { project?: string; spec?: string };
  }>('/api/teams/:teamName/tasks/:taskId', async (request, reply) => {
    const route = `GET /api/teams/${request.params.teamName}/tasks/${request.params.taskId}`;
    try {
      const api = requireTaskApi(services);
      const teamName = requireExactTeamName(request.params.teamName);
      const taskId = request.params.taskId.trim();
      if (!taskId) throw badRequest('TASK_NOT_FOUND', 'Task id is required');
      const task = await api.getTask(teamName, taskId, readTaskScope(request.query));
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
  });
  app.get<{
    Params: { teamName: string; taskId: string; attachmentId: string };
    Body: unknown;
    Querystring: Record<string, string | undefined>;
  }>('/api/teams/:teamName/tasks/:taskId/artifact/:attachmentId', async (request, reply) => {
    const route = `GET /api/teams/${request.params.teamName}/tasks/${request.params.taskId}/artifact/${request.params.attachmentId}`;
    try {
      const api = requireTaskApi(services);
      const teamName = requireExactTeamName(request.params.teamName);
      const taskId = request.params.taskId.trim();
      const attachmentId = request.params.attachmentId.trim();
      const contentLength = request.raw.headers['content-length'];
      const hasRequestBody =
        request.raw.headers['transfer-encoding'] !== undefined ||
        (contentLength !== undefined && contentLength !== '0');
      if (
        !taskId ||
        !attachmentId ||
        request.body !== undefined ||
        hasRequestBody ||
        Object.keys(request.query).length > 0
      ) {
        throw badRequest(
          'INVALID_TASK_ARTIFACT_READ',
          'Task artifact reads accept only team, task and attachment IDs'
        );
      }

      const task = await api.getTask(teamName, taskId);
      const proof = task?.artifactRequirement?.proof;
      const attachment = task?.attachments?.find((item) => item.id === attachmentId);
      if (
        !task ||
        task.artifactRequirement?.required !== true ||
        !proof ||
        proof.attachmentId !== attachmentId ||
        !attachment
      ) {
        return reply.status(404).send({ code: 'TASK_NOT_FOUND', error: 'Task artifact not found' });
      }

      const base64Data = await api.readTaskArtifactData(teamName, taskId, attachmentId);
      if (base64Data === null) {
        return reply.status(404).send({ code: 'TASK_NOT_FOUND', error: 'Task artifact not found' });
      }

      let artifact: TaskArtifactFile;
      try {
        artifact = readTaskArtifactFile({ filename: attachment.filename, base64Data });
      } catch {
        throw new TeamTaskHttpError(
          409,
          'ARTIFACT_UNVERIFIED',
          'Stored task artifact failed integrity validation'
        );
      }
      const bytes = Buffer.from(artifact.base64Data, 'base64');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (
        !Number.isSafeInteger(proof.size) ||
        proof.size < 0 ||
        proof.sha256 !== sha256 ||
        proof.size !== bytes.length ||
        attachment.size !== bytes.length ||
        typeof attachment.mimeType !== 'string' ||
        !attachment.mimeType.trim()
      ) {
        throw new TeamTaskHttpError(
          409,
          'ARTIFACT_UNVERIFIED',
          'Stored task artifact failed integrity validation'
        );
      }

      reply.header('cache-control', 'no-store');
      return reply.send({
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: proof.size,
        sha256: proof.sha256,
        base64Data: artifact.base64Data,
      });
    } catch (error) {
      return sendTaskRouteError(reply, error, route);
    }
  });

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

  app.post<{
    Params: { teamName: string; taskId: string };
    Body: unknown;
    Querystring: { project?: string; spec?: string };
  }>('/api/teams/:teamName/tasks/:taskId/status', async (request, reply) => {
    const route = `POST /api/teams/${request.params.teamName}/tasks/${request.params.taskId}/status`;
    try {
      const api = requireTaskApi(services);
      const teamName = requireExactTeamName(request.params.teamName);
      const taskId = request.params.taskId.trim();
      if (!taskId) throw badRequest('TASK_NOT_FOUND', 'Task id is required');
      const { status, expectedStatus, actor } = parseStatusBody(request.body);
      const scope = readTaskScope(request.query);
      const transitions = await api.updateTaskStatusWithReceipt(
        teamName,
        taskId,
        status,
        actor,
        expectedStatus,
        scope
      );
      const task = await api.getTask(teamName, taskId, scope);
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
  });

  app.patch<{
    Params: { teamName: string; taskId: string };
    Body: unknown;
    Querystring: { project?: string; spec?: string };
  }>(
    '/api/teams/:teamName/tasks/:taskId',
    { bodyLimit: MAX_TASK_PATCH_BODY_BYTES },
    async (request, reply) => {
      const route = `PATCH /api/teams/${request.params.teamName}/tasks/${request.params.taskId}`;
      try {
        const api = requireTaskApi(services);
        const teamName = requireExactTeamName(request.params.teamName);
        const taskId = request.params.taskId.trim();
        if (!taskId) throw badRequest('TASK_NOT_FOUND', 'Task id is required');
        const patch = parsePatchBody(request.body);

        const scope = readTaskScope(request.query);
        const current = await api.getTask(teamName, taskId, scope);
        if (!current) {
          return reply.status(404).send({
            code: 'TASK_NOT_FOUND',
            message: `Task "${taskId}" was not found in team "${teamName}"`,
          });
        }

        await applyLinkPatch(api, teamName, taskId, current, patch, scope);
        if (patch.owner !== undefined) {
          await api.updateTaskOwner(teamName, taskId, patch.owner, patch.actor, scope);
        }
        if (Object.keys(patch.fields).length > 0) {
          await api.updateTaskFields(teamName, taskId, patch.fields, scope);
        }
        if (Object.keys(patch.execution).length > 0) {
          await api.applyTaskExecutionPatch(teamName, taskId, patch.execution, scope);
        }

        const task = await api.getTask(teamName, taskId, scope);
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
  patch: ParsedTaskPatch,
  scope?: TeamHttpTaskScope
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
        await api.removeTaskRelationship(teamName, taskId, targetId, relation.type, scope);
      }
    }
    for (const targetId of desired) {
      if (!existing.has(targetId)) {
        await api.addTaskRelationship(teamName, taskId, targetId, relation.type, scope);
      }
    }
  }
}
