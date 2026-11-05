import { randomUUID } from 'node:crypto';

import { RegistryMcpTransport } from './RegistryMcpTransport';
import {
  resolveRegistryTaskClientConfig,
  type ResolveRegistryTaskClientConfigInput,
  type ResolvedRegistryTaskClientConfig,
} from './RegistryTaskClientConfig';
import {
  REGISTRY_TASK_STATUSES,
  type ListRegistryTasksInput,
  type RegistryPatchPayload,
  type RegistryTask,
  type RegistryTaskRefusal,
  type RegistryTaskStatus,
  type RegistryTaskStatusResult,
  type RegistryTaskTransition,
  type RegistryTaskWriteResult,
  type RegistryTasksPayload,
  type RegistryToolEnvelope,
  type ReplaceRegistryTaskLinksInput,
  type ReplaceRegistryTaskOwnerInput,
  type ReplaceRegistryTaskStatusInput,
  type UpsertRegistryTaskInput,
} from './RegistryTaskClientTypes';
import { isRecord, stringOrNull } from './RegistryJson';
import {
  RegistryStatusConflictError,
  RegistryTaskClientError,
  RegistryTaskProtocolError,
  RegistryTaskWriteRefusedError,
} from './RegistryTaskClientErrors';

export type {
  ListRegistryTasksInput,
  RegistryTask,
  RegistryTaskStatus,
  RegistryTaskStatusResult,
  RegistryTaskTransition,
  RegistryTaskWriteOutcome,
  RegistryTaskWriteResult,
  ReplaceRegistryTaskLinksInput,
  ReplaceRegistryTaskOwnerInput,
  ReplaceRegistryTaskStatusInput,
  UpsertRegistryTaskInput,
} from './RegistryTaskClientTypes';

/**
 * The kernel schema the registry speaks. `spec-kernel@2` keeps structured task
 * operations as fields on nodes, not as new node kinds.
 */
const REGISTRY_SCHEMA_VERSION = 'spec-kernel@2';
/** TASKS.md is the one document the structured task operations may touch. */
const TASK_DOCUMENT = 'TASKS.md';
/** Safety cap: a paginating registry must never spin the caller forever. */
const MAX_TASK_PAGES = 100;

export interface RegistryTaskClientOptions extends ResolveRegistryTaskClientConfigInput {
  /** Injectable fetch for tests; defaults to the runtime's global fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Registry-owned team tasks: read through `spec_tasks`, write through the
 * structured `spec_patch` operations. There is no local fallback — a failure
 * means the registry did not confirm the write, and the caller must decide.
 */
export class RegistryTaskClient {
  readonly #transport: RegistryMcpTransport;

  private constructor(transport: RegistryMcpTransport) {
    this.#transport = transport;
  }

  /** Resolves URL/token/timeouts (env → token file) and fails closed. */
  static async create(options: RegistryTaskClientOptions = {}): Promise<RegistryTaskClient> {
    const config = await resolveRegistryTaskClientConfig(options);
    return RegistryTaskClient.fromConfig(config, options.fetchImpl);
  }

  /** Builds a client from already-resolved configuration. */
  static fromConfig(
    config: ResolvedRegistryTaskClientConfig,
    fetchImpl?: typeof globalThis.fetch
  ): RegistryTaskClient {
    return new RegistryTaskClient(
      new RegistryMcpTransport({
        url: config.url,
        token: config.token,
        requestTimeoutMs: config.requestTimeoutMs,
        fetchImpl,
      })
    );
  }

  /** All tasks of one spec, following the registry's cursor pagination. */
  async listTasks(input: ListRegistryTasksInput): Promise<RegistryTask[]> {
    const scope = assertScope(input, 'listTasks');
    const statuses = assertStatuses(input.statuses, 'listTasks');
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
      const envelope = await this.#transport.callTool(
        'spec_tasks',
        {
          schemaVersion: REGISTRY_SCHEMA_VERSION,
          project: scope.project,
          spec: scope.spec,
          ...(statuses === null ? {} : { statuses }),
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

    return tasks;
  }

  /**
   * Idempotent create-or-update. `REFUSED` is returned, not thrown: the payload
   * owner needs the registry's reason (usually "status changes go through
   * replace_task_status").
   */
  async upsertTask(input: UpsertRegistryTaskInput): Promise<RegistryTaskWriteResult> {
    const scope = assertScope(input, 'upsertTask');
    const localId = assertNonEmptyString(input.localId, 'upsertTask', 'localId');
    const title = assertNonEmptyString(input.title, 'upsertTask', 'title');
    const requirements = assertStringArray(input.requirements, 'upsertTask', 'requirements');
    const status =
      input.status === undefined ? undefined : assertTaskStatus(input.status, 'upsertTask');
    const owner =
      input.owner === undefined
        ? undefined
        : assertNonEmptyString(input.owner, 'upsertTask', 'owner');
    const tracking =
      input.tracking === undefined
        ? undefined
        : assertNonEmptyString(input.tracking, 'upsertTask', 'tracking');
    const dependsOn =
      input.dependsOn === undefined
        ? undefined
        : assertStringArray(input.dependsOn, 'upsertTask', 'dependsOn');
    const refs =
      input.refs === undefined ? undefined : assertStringArray(input.refs, 'upsertTask', 'refs');

    const operation = {
      kind: 'upsert_task',
      document: TASK_DOCUMENT,
      localId,
      title,
      requirements,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(status === undefined ? {} : { status }),
      ...(owner === undefined ? {} : { owner }),
      ...(tracking === undefined ? {} : { tracking }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
      ...(refs === undefined ? {} : { refs }),
    };

    const payload = await this.#executePatch(operation, scope, input.signal);
    return toWriteResult(payload);
  }

  /**
   * Optimistic status transition. A `STATUS_CONFLICT` refusal becomes
   * `RegistryStatusConflictError` carrying the registry's `currentStatus`, so a
   * caller cannot mistake a lost race for a successful write.
   */
  async replaceTaskStatus(
    input: ReplaceRegistryTaskStatusInput
  ): Promise<RegistryTaskStatusResult> {
    const scope = assertScope(input, 'replaceTaskStatus');
    const entity = assertEntity(input.entity, scope, 'replaceTaskStatus');
    const status = assertTaskStatus(input.status, 'replaceTaskStatus');
    const expectedStatus = assertTaskStatus(input.expectedStatus, 'replaceTaskStatus');

    const payload = await this.#executePatch(
      {
        kind: 'replace_task_status',
        document: TASK_DOCUMENT,
        entity,
        status,
        expectedStatus,
      },
      scope,
      input.signal
    );

    if (payload.outcome === 'REFUSED') {
      throw this.#refusalError(payload, 'replaceTaskStatus');
    }
    return { outcome: payload.outcome, transitions: payload.transitions };
  }

  /** Replaces the owner of one task; same idempotency contract as upsert. */
  async replaceTaskOwner(input: ReplaceRegistryTaskOwnerInput): Promise<RegistryTaskWriteResult> {
    const scope = assertScope(input, 'replaceTaskOwner');
    const entity = assertEntity(input.entity, scope, 'replaceTaskOwner');
    const owner = assertNonEmptyString(input.owner, 'replaceTaskOwner', 'owner');

    const payload = await this.#executePatch(
      { kind: 'replace_task_owner', document: TASK_DOCUMENT, entity, owner },
      scope,
      input.signal
    );
    return toWriteResult(payload);
  }

  /** Replaces requirement/dependency/ref links of one task. */
  async replaceTaskLinks(input: ReplaceRegistryTaskLinksInput): Promise<RegistryTaskWriteResult> {
    const scope = assertScope(input, 'replaceTaskLinks');
    const entity = assertEntity(input.entity, scope, 'replaceTaskLinks');
    const requirements =
      input.requirements === undefined
        ? undefined
        : assertStringArray(input.requirements, 'replaceTaskLinks', 'requirements');
    const dependsOn =
      input.dependsOn === undefined
        ? undefined
        : assertStringArray(input.dependsOn, 'replaceTaskLinks', 'dependsOn');
    const refs =
      input.refs === undefined
        ? undefined
        : assertStringArray(input.refs, 'replaceTaskLinks', 'refs');
    if (requirements === undefined && dependsOn === undefined && refs === undefined) {
      throw invalidArgument(
        'replaceTaskLinks',
        'replaceTaskLinks needs at least one of requirements, dependsOn or refs'
      );
    }

    const payload = await this.#executePatch(
      {
        kind: 'replace_task_links',
        document: TASK_DOCUMENT,
        entity,
        ...(requirements === undefined ? {} : { requirements }),
        ...(dependsOn === undefined ? {} : { dependsOn }),
        ...(refs === undefined ? {} : { refs }),
      },
      scope,
      input.signal
    );
    return toWriteResult(payload);
  }

  async #executePatch(
    operation: Record<string, unknown>,
    scope: { project: string; spec: string },
    signal: AbortSignal | undefined
  ): Promise<RegistryPatchPayload> {
    const requestId = randomUUID();
    const envelope = await this.#transport.callTool(
      'spec_patch',
      {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        intent: 'patch',
        project: scope.project,
        spec: scope.spec,
        requestId,
        reason: `agent-teams task registry: ${String(operation.kind)}`,
        dryRun: false,
        operations: [operation],
      },
      String(operation.kind),
      signal
    );
    return readPatchPayload(envelope, String(operation.kind));
  }

  #refusalError(
    payload: RegistryPatchPayload,
    operation: string
  ): RegistryStatusConflictError | RegistryTaskWriteRefusedError {
    const refusal = payload.refusal;
    if (refusal === null) {
      throw invalidArgument(operation, 'registry refused a write without a reason');
    }
    if (refusal.code === 'STATUS_CONFLICT') {
      return new RegistryStatusConflictError({
        operation,
        message: this.#transport.redact(refusal.message),
        currentStatus: refusal.currentStatus,
        expectedStatus: refusal.expectedStatus,
        localId: refusal.localId,
      });
    }
    return new RegistryTaskWriteRefusedError(operation, {
      ...refusal,
      message: this.#transport.redact(refusal.message),
    });
  }
}

function readTasksPayload(envelope: RegistryToolEnvelope<unknown>): RegistryTasksPayload {
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

function readTask(rawTask: unknown, index: number): RegistryTask {
  if (!isRecord(rawTask)) {
    throw new RegistryTaskProtocolError('listTasks', `task #${index} is not an object`);
  }
  const canonicalId = stringOrNull(rawTask.canonicalId);
  const localId = stringOrNull(rawTask.localId);
  const title = stringOrNull(rawTask.title);
  if (canonicalId === null || localId === null || title === null) {
    throw new RegistryTaskProtocolError(
      'listTasks',
      `task #${index} is missing canonicalId, localId or title`
    );
  }
  return {
    canonicalId,
    localId,
    title,
    status: normalizeStatus(stringOrNull(rawTask.status)),
    owner: stringOrNull(rawTask.owner),
    tracking: stringOrNull(rawTask.tracking),
    requirements: readLinkArray(rawTask.requirements, `task #${index}.requirements`),
    dependsOn: readLinkArray(rawTask.dependsOn, `task #${index}.dependsOn`),
    blocks: readLinkArray(rawTask.blocks, `task #${index}.blocks`),
    blockedBy: readLinkArray(rawTask.blockedBy, `task #${index}.blockedBy`),
    contentHash: stringOrNull(rawTask.contentHash),
  };
}

function readPatchPayload(
  envelope: RegistryToolEnvelope<unknown>,
  operation: string
): RegistryPatchPayload {
  const data = envelope.data;
  if (!isRecord(data)) {
    throw new RegistryTaskProtocolError(operation, 'spec_patch returned no patch payload');
  }
  const outcome = stringOrNull(data.outcome);
  if (outcome !== 'APPLIED' && outcome !== 'UNCHANGED' && outcome !== 'REFUSED') {
    throw new RegistryTaskProtocolError(
      operation,
      `spec_patch returned outcome ${outcome ?? 'null'}`,
      {
        outcome,
      }
    );
  }

  const receipt = isRecord(data.receipt) ? data.receipt : null;
  const transitions = readTransitions(data.transitions ?? receipt?.transitions, operation);
  const refusal = outcome === 'REFUSED' ? readRefusal(data.error, operation) : null;
  if (outcome === 'REFUSED' && refusal === null) {
    throw new RegistryTaskProtocolError(
      operation,
      'spec_patch refused the write without an error object'
    );
  }

  const spec = stringOrNull(data.spec);
  return {
    schemaVersion: stringOrNull(data.schemaVersion) ?? '',
    requestId: stringOrNull(data.requestId) ?? envelope.requestId,
    dryRun: data.dryRun === true,
    proposalHash: stringOrNull(data.proposalHash),
    outcome,
    ...(spec === null ? {} : { spec }),
    unchanged: data.unchanged === true,
    transitions,
    refusal,
  };
}

function readTransitions(rawTransitions: unknown, operation: string): RegistryTaskTransition[] {
  if (rawTransitions === undefined || rawTransitions === null) {
    return [];
  }
  if (!Array.isArray(rawTransitions)) {
    throw new RegistryTaskProtocolError(operation, 'spec_patch transitions is not an array');
  }
  return rawTransitions.map((rawTransition, index) => {
    if (!isRecord(rawTransition)) {
      throw new RegistryTaskProtocolError(operation, `transition #${index} is not an object`);
    }
    const localId = stringOrNull(rawTransition.localId);
    if (localId === null) {
      throw new RegistryTaskProtocolError(operation, `transition #${index} has no localId`);
    }
    return {
      localId,
      from: stringOrNull(rawTransition.from),
      to: stringOrNull(rawTransition.to),
      requestId: stringOrNull(rawTransition.requestId),
      actor: stringOrNull(rawTransition.actor),
      at: stringOrNull(rawTransition.at),
    };
  });
}

function readRefusal(rawError: unknown, operation: string): RegistryTaskRefusal | null {
  if (!isRecord(rawError)) {
    return null;
  }
  const code = stringOrNull(rawError.code);
  if (code === null) {
    throw new RegistryTaskProtocolError(operation, 'refusal error has no code');
  }
  return {
    code,
    message: stringOrNull(rawError.message) ?? `spec_patch refused ${operation}`,
    retryable: rawError.retryable === true,
    localId: stringOrNull(rawError.localId),
    currentStatus: stringOrNull(rawError.currentStatus),
    expectedStatus: stringOrNull(rawError.expectedStatus),
    causeCode: stringOrNull(rawError.causeCode),
  };
}

function readLinkArray(value: unknown, field: string): string[] {
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

function toWriteResult(payload: RegistryPatchPayload): RegistryTaskWriteResult {
  return {
    outcome: payload.outcome,
    transitions: payload.transitions,
    refusal: payload.refusal,
  };
}

function assertScope(
  input: { project: string; spec: string },
  operation: string
): { project: string; spec: string } {
  return {
    project: assertNonEmptyString(input.project, operation, 'project'),
    spec: assertNonEmptyString(input.spec, operation, 'spec'),
  };
}

function assertNonEmptyString(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidArgument(operation, `${operation} requires a non-empty ${field}`);
  }
  return value.trim();
}

function assertStringArray(value: unknown, operation: string, field: string): string[] {
  if (!Array.isArray(value)) {
    throw invalidArgument(operation, `${operation}.${field} must be an array of ids`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw invalidArgument(operation, `${operation}.${field}[${index}] must be a non-empty id`);
    }
    return entry.trim();
  });
}

function assertStatuses(
  value: readonly RegistryTaskStatus[] | undefined,
  operation: string
): string[] | null {
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value)) {
    throw invalidArgument(operation, `${operation}.statuses must be an array`);
  }
  return value.map((status) => assertTaskStatus(status, operation));
}

function assertTaskStatus(value: unknown, operation: string): RegistryTaskStatus {
  const normalized = normalizeStatus(typeof value === 'string' ? value : null);
  if (value !== normalized) {
    throw invalidArgument(
      operation,
      `${operation} status must be one of ${REGISTRY_TASK_STATUSES.join(', ')}, got ${String(value)}`
    );
  }
  return normalized;
}

function normalizeStatus(value: string | null): RegistryTaskStatus {
  const match = REGISTRY_TASK_STATUSES.find((status) => status === value);
  return match ?? 'unknown';
}

/**
 * Structured operations address tasks by local id. A canonical id is accepted
 * only when it belongs to the same spec: silently stripping a foreign prefix
 * would write the wrong task.
 */
function assertEntity(value: unknown, scope: { spec: string }, operation: string): string {
  const entity = assertNonEmptyString(value, operation, 'entity');
  const separator = entity.lastIndexOf(':');
  if (separator < 0) {
    return entity;
  }
  const specPrefix = entity.slice(0, separator);
  const localId = entity.slice(separator + 1);
  if (specPrefix !== scope.spec) {
    throw invalidArgument(
      operation,
      `${operation}.entity ${entity} belongs to spec ${specPrefix}, not ${scope.spec}`
    );
  }
  return assertNonEmptyString(localId, operation, 'entity');
}

function invalidArgument(operation: string, message: string): RegistryTaskClientError {
  return new RegistryTaskClientError({ code: 'INVALID_ARGUMENT', message, operation });
}
