import { type RegistryTaskEntity } from '@shared/types';

import { isRecord, numberOrNull, stringOrNull } from './RegistryJson';
import { RegistryMcpTransport } from './RegistryMcpTransport';
import { RegistryTaskProtocolError } from './RegistryTaskClientErrors';
import {
  type ListRegistryTasksInput,
  REGISTRY_TASK_STATUSES,
  type RegistryTask,
  type RegistryTaskReview,
  type RegistryTaskSourceSnapshot,
  type RegistryTasksPayload,
  type RegistryToolEnvelope,
} from './RegistryTaskClientTypes';
import {
  assertScope,
  invalidArgument,
  MAX_TASK_PAGES,
  REGISTRY_SCHEMA_VERSION,
} from './RegistryTaskClientValidation';

export function readTasksPayload(envelope: RegistryToolEnvelope<unknown>): RegistryTasksPayload {
  const data = envelope.data;
  if (!isRecord(data)) {
    throw new RegistryTaskProtocolError('listTasks', 'spec_tasks returned no tasks payload');
  }
  const rawTasks = data.tasks;
  if (!Array.isArray(rawTasks)) {
    throw new RegistryTaskProtocolError('listTasks', 'spec_tasks payload has no tasks array');
  }
  const spec = stringOrNull(data.spec) ?? '';
  return {
    kind: 'tasks',
    spec,
    tasks: rawTasks.map((rawTask, index) => readTask(rawTask, index)),
    count: rawTasks.length,
  };
}

export function readTask(rawTask: unknown, index: number): RegistryTask {
  if (!isRecord(rawTask)) {
    throw new RegistryTaskProtocolError('listTasks', `task #${index} is not an object`);
  }
  const canonicalId = stringOrNull(rawTask.canonicalId);
  const specSlug = stringOrNull(rawTask.specSlug);
  const localId = stringOrNull(rawTask.localId);
  const title = stringOrNull(rawTask.title);
  if (canonicalId === null || specSlug === null || localId === null || title === null) {
    throw new RegistryTaskProtocolError(
      'listTasks',
      `task #${index} is missing canonicalId, specSlug, localId or title`
    );
  }
  const description = nullableStringField(rawTask.description, `task #${index}.description`);
  const creationToken = nullableStringField(rawTask.creationToken, `task #${index}.creationToken`);
  const phase = nullableStringField(rawTask.phase, `task #${index}.phase`);
  const status = REGISTRY_TASK_STATUSES.find(
    (candidate) => candidate === stringOrNull(rawTask.status)
  );
  if (status === undefined) {
    throw new RegistryTaskProtocolError('listTasks', `task #${index} has invalid status`);
  }
  if ('body' in rawTask && typeof rawTask.body !== 'string') {
    throw new RegistryTaskProtocolError('listTasks', `task #${index} has invalid body`);
  }
  return {
    ...rawTask,
    canonicalId,
    specSlug,
    localId,
    title,
    description,
    creationToken,
    status,
    phase,
    owner: nullableStringField(rawTask.owner, `task #${index}.owner`),
    tracking: nullableStringField(rawTask.tracking, `task #${index}.tracking`),
    contentHash: nullableStringField(rawTask.contentHash, `task #${index}.contentHash`),
    source: readTaskSource(rawTask.source, `task #${index}.source`),
    requirements: readLinkArray(rawTask.requirements, `task #${index}.requirements`),
    dependsOn: readLinkArray(rawTask.dependsOn, `task #${index}.dependsOn`),
    blocks: readLinkArray(rawTask.blocks, `task #${index}.blocks`),
    blockedBy: readLinkArray(rawTask.blockedBy, `task #${index}.blockedBy`),
    refs: readLinkArray(rawTask.refs, `task #${index}.refs`),
    review: readTaskReview(rawTask.review),
    ...('body' in rawTask ? { body: rawTask.body as string } : {}),
  };
}

export function readTaskReview(value: unknown): RegistryTaskReview {
  if (value === undefined || value === null) return 'none';
  if (
    value === 'none' ||
    value === 'requested' ||
    value === 'approved' ||
    value === 'changes-requested'
  ) {
    return value;
  }
  throw new RegistryTaskProtocolError(
    'listTasks',
    `task review has an unknown value: ${String(value)}`
  );
}

export function readRegistryTaskEntity(rawEntity: Record<string, unknown>): RegistryTaskEntity {
  const canonicalId = stringOrNull(rawEntity.canonicalId);
  const specSlug = stringOrNull(rawEntity.specSlug);
  const localId = stringOrNull(rawEntity.localId);
  const kind = stringOrNull(rawEntity.kind);
  const title = stringOrNull(rawEntity.title);
  const body = stringOrNull(rawEntity.body);
  if (
    canonicalId === null ||
    specSlug === null ||
    localId === null ||
    kind !== 'TASK' ||
    title === null ||
    body === null
  ) {
    throw new RegistryTaskProtocolError(
      'getTaskEntity',
      'registry returned an incomplete task entity'
    );
  }
  const rawSpan = rawEntity.span;
  const span =
    rawSpan === null || rawSpan === undefined
      ? null
      : readTaskSource(rawSpan, 'entity.span', 'getTaskEntity');
  const rawAttributes = rawEntity.attributes;
  if (rawAttributes !== undefined && rawAttributes !== null && !isRecord(rawAttributes)) {
    throw new RegistryTaskProtocolError('getTaskEntity', 'entity.attributes is not an object');
  }
  return {
    ...rawEntity,
    canonicalId,
    specSlug,
    localId,
    kind,
    title,
    body,
    attributes: isRecord(rawAttributes) ? rawAttributes : {},
    contentHash: nullableStringField(rawEntity.contentHash, 'entity.contentHash', 'getTaskEntity'),
    span,
  };
}

export function readTaskSource(
  value: unknown,
  field: string,
  operation = 'listTasks'
): RegistryTaskSourceSnapshot {
  if (!isRecord(value)) {
    throw new RegistryTaskProtocolError(operation, `${field} is not an object`);
  }
  return {
    path: nullableStringField(value.path, `${field}.path`, operation),
    startLine: nullableNumberField(value.startLine, `${field}.startLine`, operation),
    startColumn: nullableNumberField(value.startColumn, `${field}.startColumn`, operation),
    endLine: nullableNumberField(value.endLine, `${field}.endLine`, operation),
    endColumn: nullableNumberField(value.endColumn, `${field}.endColumn`, operation),
  };
}

export function nullableStringField(
  value: unknown,
  field: string,
  operation = 'listTasks'
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new RegistryTaskProtocolError(operation, `${field} is not a string or null`);
  }
  return value;
}

export function nullableNumberField(
  value: unknown,
  field: string,
  operation = 'listTasks'
): number | null {
  if (value === null || value === undefined) return null;
  const parsed = numberOrNull(value);
  if (parsed === null) {
    throw new RegistryTaskProtocolError(operation, `${field} is not a number or null`);
  }
  return parsed;
}

export function readLinkArray(value: unknown, field: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new RegistryTaskProtocolError('listTasks', `${field} is not an array`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new RegistryTaskProtocolError(
        'listTasks',
        `${field}[${index}] is not a canonical id string`
      );
    }
    return entry;
  });
}

export async function listRegistryTasks(
  transport: RegistryMcpTransport,
  input: ListRegistryTasksInput,
  scope: { project: string; spec: string },
  statuses: string[] | null
): Promise<RegistryTask[]> {
  const tasks: RegistryTask[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;

  do {
    pageCount += 1;
    if (pageCount > MAX_TASK_PAGES) {
      throw new RegistryTaskProtocolError(
        'listTasks',
        `registry paginated past ${MAX_TASK_PAGES} pages; refusing to loop`
      );
    }
    const envelope = await transport.callTool(
      'spec_tasks',
      {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        project: scope.project,
        spec: scope.spec,
        ...(statuses === null ? {} : { statuses }),
        ...(input.includeBodies === true ? { includeComments: true } : {}),
        ...(cursor === null ? {} : { cursor }),
      },
      'listTasks',
      input.signal
    );
    const payload = readTasksPayload(envelope);
    tasks.push(...payload.tasks);
    cursor = envelope.page?.nextCursor ?? null;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) {
        throw new RegistryTaskProtocolError(
          'listTasks',
          'registry repeated a pagination cursor; refusing to loop',
          { cursor }
        );
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== null);

  if (input.includeBodies === true && tasks.some((task) => task.body === undefined)) {
    throw new RegistryTaskProtocolError(
      'listTasks',
      'registry omitted raw task body despite includeComments'
    );
  }
  return tasks;
}

/** Loads one exact task entity only for an opened card, not for every board row. */
export async function getRegistryTaskEntity(
  transport: RegistryMcpTransport,
  input: {
    project: string;
    spec: string;
    canonicalId: string;
    signal?: AbortSignal;
  }
): Promise<RegistryTaskEntity> {
  const scope = assertScope(input, 'getTaskEntity');
  if (!input.canonicalId.startsWith(`${scope.spec}:TASK-`)) {
    throw invalidArgument('getTaskEntity', 'canonicalId must belong to the requested spec');
  }
  const expected = input.canonicalId;
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let result: RegistryTaskEntity | null = null;
  let pageCount = 0;
  do {
    if (++pageCount > MAX_TASK_PAGES) {
      throw new RegistryTaskProtocolError(
        'getTaskEntity',
        `registry paginated past ${MAX_TASK_PAGES} pages; refusing to loop`
      );
    }
    const envelope = await transport.callTool(
      'spec_entities',
      {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        project: scope.project,
        mode: 'find',
        canonicalIds: [expected],
        projection: 'full',
        limit: 50,
        ...(cursor === null ? {} : { cursor }),
      },
      'getTaskEntity',
      input.signal
    );
    if (!isRecord(envelope.data) || !Array.isArray(envelope.data.nodes)) {
      throw new RegistryTaskProtocolError(
        'getTaskEntity',
        'registry returned an invalid entity page'
      );
    }
    for (const node of envelope.data.nodes) {
      if (!isRecord(node) || node.canonicalId !== expected || result !== null) {
        throw new RegistryTaskProtocolError(
          'getTaskEntity',
          'registry returned an unexpected or duplicate task entity'
        );
      }
      result = readRegistryTaskEntity(node);
    }
    cursor = envelope.page?.nextCursor ?? null;
    if (cursor !== null) {
      if (seenCursors.has(cursor)) {
        throw new RegistryTaskProtocolError('getTaskEntity', 'registry repeated an entity cursor');
      }
      seenCursors.add(cursor);
    }
  } while (cursor !== null);
  if (result === null) {
    throw new RegistryTaskProtocolError(
      'getTaskEntity',
      'registry omitted the requested task entity'
    );
  }
  return result;
}
