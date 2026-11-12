import { randomUUID } from 'node:crypto';

import { type RegistryRegistrationIdentity, type RegistryTaskEntity } from '@shared/types';

import { isRecord } from './RegistryJson';
import { RegistryMcpTransport } from './RegistryMcpTransport';
import {
  type ResolvedRegistryTaskClientConfig,
  resolveRegistryTaskClientConfig,
  type ResolveRegistryTaskClientConfigInput,
} from './RegistryTaskClientConfig';
import {
  RegistryStatusConflictError,
  RegistryTaskProtocolError,
  RegistryTaskWriteRefusedError,
} from './RegistryTaskClientErrors';
import {
  readGenesisAttestations,
  readRegistryTaskGenesisReplay,
} from './RegistryTaskClientGenesis';
import { assertGenesisLifecycleReceipt } from './RegistryTaskClientLifecycle';
import { assertRequiredTaskPolicy } from './RegistryTaskClientPolicy';
import { getRegistryTaskEntity, listRegistryTasks } from './RegistryTaskClientReads';
import {
  type ListRegistryTasksInput,
  type RegistryPatchPayload,
  type RegistryTask,
  type RegistryTaskGenesisReplayRecord,
  type RegistryTaskReview,
  type RegistryTaskStatus,
  type RegistryTaskStatusResult,
  type RegistryTaskUpsertResult,
  type RegistryTaskWriteResult,
  type RegistryToolEnvelope,
  type ReplaceRegistryTaskLinksInput,
  type ReplaceRegistryTaskOwnerInput,
  type ReplaceRegistryTaskStatusInput,
  type UpsertRegistryTaskInput,
} from './RegistryTaskClientTypes';
import {
  assertEntity,
  assertNonEmptyString,
  assertOpaqueToken,
  assertRegistrationIdentity,
  assertScope,
  assertStatuses,
  assertStringArray,
  assertTaskStatus,
  assertUuid,
  digestCreationTokenSafely,
  invalidArgument,
  REGISTRY_SCHEMA_VERSION,
  TASK_DOCUMENT,
} from './RegistryTaskClientValidation';
import {
  executeRegistryTaskUpsertPatch,
  readPatchPayload,
  RegistryTaskCapabilities,
  toWriteResult,
} from './RegistryTaskClientWrites';
import { RegistryTeamTaskWriteError } from './RegistryTeamTaskWriter';

export type {
  ListRegistryTasksInput,
  RegistryTask,
  RegistryTaskCompletionChallenge,
  RegistryTaskCompletionChallengeInput,
  RegistryTaskCompletionInput,
  RegistryTaskCompletionReplayRecord,
  RegistryTaskCompletionResult,
  RegistryTaskEntity,
  RegistryTaskGenesisAttestation,
  RegistryTaskGenesisChallenge,
  RegistryTaskGenesisChallengeEntry,
  RegistryTaskGenesisChallengeResult,
  RegistryTaskLifecycleOperationReceipt,
  RegistryTaskLifecycleReceipt,
  RegistryTaskPolicyChangeChallenge,
  RegistryTaskPolicyChangeChallengeInput,
  RegistryTaskPolicyChangeInput,
  RegistryTaskPolicyChangeReplayRecord,
  RegistryTaskPolicyChangeResult,
  RegistryTaskStatus,
  RegistryTaskStatusResult,
  RegistryTaskTransition,
  RegistryTaskUpsertResult,
  RegistryTaskWriteOutcome,
  RegistryTaskWriteResult,
  ReplaceRegistryTaskLinksInput,
  ReplaceRegistryTaskOwnerInput,
  ReplaceRegistryTaskStatusInput,
  UpsertRegistryTaskInput,
} from './RegistryTaskClientTypes';

export interface RegistryTaskClientOptions extends ResolveRegistryTaskClientConfigInput {
  /** Injectable fetch for tests; defaults to the runtime's global fetch. */
  fetchImpl?: typeof globalThis.fetch;
}

/**
 * Registry-owned team tasks: read through `spec_tasks`, write through the
 * structured `spec_patch` operations. There is no local fallback — a failure
 * means the registry did not confirm the write, and the caller must decide.
 */
/** The registry addresses a task by its canonical `TASK-<n>` entity. */
function canonicalizeTaskEntity(entity: string): string {
  const trimmed = entity.trim();
  return /^\d+$/u.test(trimmed) ? `TASK-${trimmed}` : trimmed;
}

/** Registry-owned canonical tasks; failures never fall back to local state. */
export class RegistryTaskClient {
  readonly #capabilities: RegistryTaskCapabilities;

  readonly #transport: RegistryMcpTransport;

  private constructor(transport: RegistryMcpTransport) {
    this.#transport = transport;
    this.#capabilities = new RegistryTaskCapabilities(transport);
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
  /** Turns a registry envelope refusal into the typed error callers expect. */
  refusalFromEnvelope(
    envelope: { error?: unknown },
    operation: string
  ): RegistryTeamTaskWriteError {
    const record = envelope.error;
    const error = record !== null && typeof record === 'object' ? record : {};
    const code =
      'code' in error && typeof error.code === 'string' ? error.code : 'REGISTRY_REFUSED';
    const message =
      'message' in error && typeof error.message === 'string'
        ? error.message
        : 'the registry refused the write';
    return new RegistryTeamTaskWriteError('REGISTRY_REFUSED', `${operation}: ${message}`, {
      details: { registryCode: code },
    });
  }

  private confirmTaskIntent(
    envelope: RegistryToolEnvelope<unknown>,
    operation: string
  ): { ok: true } {
    const data = envelope.data;
    if (!envelope.ok) throw this.refusalFromEnvelope(envelope, operation);
    if (data !== null && typeof data === 'object' && 'outcome' in data) {
      if (data.outcome === 'REFUSED') {
        throw this.refusalFromEnvelope(
          {
            error: 'error' in data ? data.error : envelope.error,
          },
          operation
        );
      }
      if (data.outcome === 'APPLIED' || data.outcome === 'UNCHANGED') return { ok: true };
    }
    throw new RegistryTaskProtocolError(
      operation,
      'The registry did not confirm the task write outcome'
    );
  }

  /** Creates one canonical task with the registry's own `spec_patch` intent. */
  async createTaskFields(input: {
    project: string;
    spec: string;
    entity: string;
    subject: string;
    requirements: readonly string[];
    owner?: string | null;
    description?: string;
    status?: RegistryTaskStatus;
    creationToken?: string;
    signal?: AbortSignal;
  }): Promise<{ ok?: unknown; error?: unknown }> {
    const scope = assertScope({ project: input.project, spec: input.spec }, 'createTask');
    const entity = assertNonEmptyString(input.entity, 'createTask', 'entity');
    const subject = assertNonEmptyString(input.subject, 'createTask', 'subject');
    if (input.requirements.length === 0) {
      throw invalidArgument(
        'createTask',
        'a registry task requires at least one requirement id: read the corpus entity ids (FR-/NFR-/AC-) and pass them in requirements'
      );
    }
    const envelope = await this.#transport.callTool(
      'spec_patch',
      {
        requestId: randomUUID(),
        reason: `task create ${entity}`,
        project: scope.project,
        spec: scope.spec,
        intent: 'confirmTaskCreation',
        dryRun: false,
        entity,
        subject,
        requirements: [...new Set(input.requirements)],
        ...(input.owner === undefined || input.owner === null ? {} : { owner: input.owner }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.creationToken === undefined ? {} : { creationToken: input.creationToken }),
      },
      'createTask',
      input.signal
    );
    return this.confirmTaskIntent(envelope, 'createTask');
  }

  /**
   * Writes canonical task fields the way the registry actually accepts them:
   * one `spec_patch` intent, scoped by project and spec. No team identity, no
   * signed policy — the registry declares neither.
   */
  async updateTaskFields(input: {
    project: string;
    spec: string;
    entity: string;
    status?: RegistryTaskStatus;
    owner?: string | null;
    expectedStatus?: RegistryTaskStatus;
    review?: RegistryTaskReview;
    signal?: AbortSignal;
  }): Promise<{ ok?: unknown; error?: unknown }> {
    const scope = assertScope({ project: input.project, spec: input.spec }, 'updateTask');
    const entity = canonicalizeTaskEntity(
      assertNonEmptyString(input.entity, 'updateTask', 'entity')
    );
    const envelope = await this.#transport.callTool(
      'spec_patch',
      {
        requestId: randomUUID(),
        reason: `task update ${entity}`,
        project: scope.project,
        spec: scope.spec,
        intent: 'updateTask',
        dryRun: false,
        entity,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.owner === undefined ? {} : { owner: input.owner }),
        ...(input.expectedStatus === undefined ? {} : { expectedStatus: input.expectedStatus }),
        ...(input.review === undefined ? {} : { review: input.review }),
      },
      'updateTask',
      input.signal
    );
    return this.confirmTaskIntent(envelope, 'updateTask');
  }

  /** Appends one comment to a canonical task; the registry keeps it in TASKS.md. */
  async addTaskComment(input: {
    project: string;
    spec: string;
    entity: string;
    text: string;
    actor?: string;
    signal?: AbortSignal;
  }): Promise<{ ok?: unknown; error?: unknown }> {
    const scope = assertScope({ project: input.project, spec: input.spec }, 'addTaskComment');
    const entity = canonicalizeTaskEntity(
      assertNonEmptyString(input.entity, 'addTaskComment', 'entity')
    );
    const text = assertNonEmptyString(input.text, 'addTaskComment', 'text');
    const envelope = await this.#transport.callTool(
      'spec_patch',
      {
        requestId: randomUUID(),
        reason: `task comment ${entity}`,
        project: scope.project,
        spec: scope.spec,
        intent: 'addTaskComment',
        dryRun: false,
        entity,
        text,
        ...(input.actor ? { actor: input.actor } : {}),
      },
      'addTaskComment',
      input.signal
    );
    return this.confirmTaskIntent(envelope, 'addTaskComment');
  }

  async listTasks(input: ListRegistryTasksInput): Promise<RegistryTask[]> {
    const scope = assertScope(input, 'listTasks');
    const statuses = assertStatuses(input.statuses, 'listTasks');
    if (statuses?.includes('deleted'))
      await this.#capabilities.requireTaskCapability('deleted', input.signal);
    return listRegistryTasks(this.#transport, input, scope, statuses);
  }

  /** Loads the exact canonical entity for one opened task card. */
  getTaskEntity(input: {
    project: string;
    spec: string;
    canonicalId: string;
    signal?: AbortSignal;
  }): Promise<RegistryTaskEntity> {
    return getRegistryTaskEntity(this.#transport, input);
  }

  async readTasksDocumentSha(input: {
    project: string;
    spec: string;
    signal?: AbortSignal;
  }): Promise<string> {
    const scope = assertScope(input, 'readTasksDocumentSha');
    const envelope = await this.#transport.callTool(
      'spec_documents',
      { action: 'read', project: scope.project, spec: scope.spec, doc: TASK_DOCUMENT },
      'readTasksDocumentSha',
      input.signal
    );
    if (
      !isRecord(envelope.data) ||
      typeof envelope.data.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(envelope.data.sha256)
    ) {
      throw new RegistryTaskProtocolError(
        'readTasksDocumentSha',
        'registry returned an invalid TASKS.md SHA-256'
      );
    }
    return envelope.data.sha256;
  }

  /** Confirms provenance against a freshly fetched authoritative Git branch. */
  async confirmTaskCreation(input: {
    project: string;
    spec: string;
    entity: string;
    creationToken: string;
    signal?: AbortSignal;
  }): Promise<boolean> {
    const scope = assertScope(input, 'confirmTaskCreation');
    const entity = assertEntity(input.entity, scope, 'confirmTaskCreation');
    await this.#capabilities.requireTaskCapability('creationToken', input.signal);
    const envelope = await this.#transport.callTool(
      'spec_patch',
      {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        project: scope.project,
        spec: scope.spec,
        requestId: randomUUID(),
        intent: 'confirmTaskCreation',
        reason: 'Confirm task creation',
        dryRun: true,
        entity,
        creationToken: input.creationToken,
      },
      'confirmTaskCreation',
      input.signal
    );
    if (
      !isRecord(envelope.data) ||
      !['CONFIRMED', 'UNKNOWN'].includes(String(envelope.data.outcome))
    ) {
      throw new RegistryTaskProtocolError(
        'confirmTaskCreation',
        'Registry returned an invalid confirmation'
      );
    }
    return envelope.data.outcome === 'CONFIRMED';
  }

  /** Replays one persisted signed request without changing any field or signature. */
  async replayTaskGenesisRequest(input: {
    replay: RegistryTaskGenesisReplayRecord;
    expectedRegistrationIdentity: RegistryRegistrationIdentity;
    signal?: AbortSignal;
  }): Promise<RegistryTaskWriteResult> {
    const replay = readRegistryTaskGenesisReplay(input.replay, input.expectedRegistrationIdentity);
    await this.#capabilities.requireGenesisAttestationCapability(input.signal);
    const envelope = await this.#transport.callTool(
      'spec_patch',
      replay.requestArguments,
      'upsertTask',
      input.signal
    );
    if (!envelope.ok) {
      throw new RegistryTaskProtocolError(
        'upsertTask',
        'The exact signed GENESIS request has no confirmed lifecycle receipt'
      );
    }
    const payload = readPatchPayload(envelope, 'upsertTask');
    const result = toWriteResult(payload);
    if (result.outcome !== 'APPLIED' || !payload.taskLifecycleReceipt) {
      throw new RegistryTaskProtocolError(
        'upsertTask',
        'The exact signed GENESIS request has no confirmed lifecycle receipt'
      );
    }
    assertGenesisLifecycleReceipt(payload.taskLifecycleReceipt, replay.payload);
    return { ...result, taskLifecycleReceipt: payload.taskLifecycleReceipt };
  }

  /**
   * Idempotent create-or-update. `REFUSED` is returned, not thrown: the payload
   * owner needs the registry's reason (usually "status changes go through
   * replace_task_status").
   */
  async upsertTask(input: UpsertRegistryTaskInput): Promise<RegistryTaskUpsertResult> {
    const scope = assertScope(input, 'upsertTask');
    const localId = assertNonEmptyString(input.localId, 'upsertTask', 'localId');
    const title = assertNonEmptyString(input.title, 'upsertTask', 'title');
    const requirements = assertStringArray(input.requirements, 'upsertTask', 'requirements');
    if (input.description !== undefined)
      await this.#capabilities.requireTaskCapability('description', input.signal);
    const creationToken =
      input.creationToken === undefined
        ? undefined
        : assertOpaqueToken(input.creationToken, 'upsertTask', 'creationToken');
    const creationTokenDigest =
      creationToken === undefined
        ? undefined
        : digestCreationTokenSafely(creationToken, 'upsertTask');
    if (creationToken !== undefined)
      await this.#capabilities.requireTaskCapability('creationToken', input.signal);
    const status =
      input.status === undefined ? undefined : assertTaskStatus(input.status, 'upsertTask');
    if (status === 'deleted')
      await this.#capabilities.requireTaskCapability('deleted', input.signal);
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
    const expectedSha =
      input.expectedSha === undefined
        ? undefined
        : assertNonEmptyString(input.expectedSha, 'upsertTask', 'expectedSha');
    if (expectedSha !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha)) {
      throw invalidArgument('upsertTask', 'expectedSha must be a lowercase SHA-256 digest');
    }

    const requestId =
      input.requestId === undefined
        ? randomUUID()
        : assertUuid(input.requestId, 'upsertTask', 'requestId');
    const teamId = assertNonEmptyString(input.teamId, 'upsertTask', 'teamId');
    const policy = input.policy === undefined ? undefined : assertRequiredTaskPolicy(input.policy);
    const expectedRegistrationIdentity =
      input.expectedRegistrationIdentity === undefined
        ? undefined
        : assertRegistrationIdentity(input.expectedRegistrationIdentity, 'upsertTask');
    const genesisAttestations =
      input.genesisAttestations === undefined
        ? undefined
        : readGenesisAttestations(input.genesisAttestations, 'upsertTask');
    if (policy?.required === true) {
      if (!creationToken || !expectedRegistrationIdentity) {
        throw invalidArgument(
          'upsertTask',
          'required initial policy needs a creation token and active registration identity'
        );
      }
      await this.#capabilities.requireTaskCapability('policy', input.signal);
    }
    if (genesisAttestations !== undefined) {
      if (policy?.required !== true || !creationToken || !expectedRegistrationIdentity) {
        throw invalidArgument(
          'upsertTask',
          'initial-policy attestations require the exact required-policy request'
        );
      }
      await this.#capabilities.requireGenesisAttestationCapability(input.signal);
    }
    if (
      (genesisAttestations !== undefined &&
        (!input.genesisChallenge || !input.beforeGenesisAttestationSend)) ||
      (genesisAttestations === undefined &&
        (input.genesisChallenge !== undefined || input.beforeGenesisAttestationSend !== undefined))
    ) {
      throw invalidArgument(
        'upsertTask',
        'a signed initial-policy write requires its challenge and durable pre-send journal'
      );
    }
    if (input.force !== undefined) {
      if (typeof input.force !== 'boolean') {
        throw invalidArgument('upsertTask', 'force must be a boolean when supplied');
      }
      await this.#capabilities.requireTaskCapability('force', input.signal);
    }

    const operation = {
      kind: 'upsert_task',
      document: TASK_DOCUMENT,
      teamId,
      localId,
      title,
      requirements,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(creationToken === undefined ? {} : { creationToken }),
      ...(policy === undefined ? {} : { policy }),
      ...(status === undefined ? {} : { status }),
      ...(owner === undefined ? {} : { owner }),
      ...(tracking === undefined ? {} : { tracking }),
      ...(dependsOn === undefined ? {} : { dependsOn }),
      ...(expectedSha === undefined ? {} : { expectedSha }),
      ...(refs === undefined ? {} : { refs }),
    };

    return executeRegistryTaskUpsertPatch(this.#transport, {
      operation,
      scope,
      requestId,
      signal: input.signal,
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(creationToken === undefined ? {} : { creationToken }),
      ...(creationTokenDigest === undefined ? {} : { creationTokenDigest }),
      ...(policy === undefined ? {} : { policy }),
      ...(expectedRegistrationIdentity === undefined ? {} : { expectedRegistrationIdentity }),
      ...(genesisAttestations === undefined ? {} : { genesisAttestations }),
      ...(input.genesisChallenge === undefined ? {} : { genesisChallenge: input.genesisChallenge }),
      ...(input.beforeGenesisAttestationSend === undefined
        ? {}
        : { beforeGenesisAttestationSend: input.beforeGenesisAttestationSend }),
    });
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
    if (!input.teamId) {
      // Registry-contract path: one spec_patch intent, no team identity.
      const result = await this.updateTaskFields({
        project: input.project,
        spec: input.spec,
        entity: input.entity,
        status,
        expectedStatus,
        signal: input.signal,
      });
      if (result && result.ok === false)
        throw this.refusalFromEnvelope(result, 'replaceTaskStatus');
      return { outcome: 'APPLIED', transitions: [] };
    }
    if (status === 'deleted' || expectedStatus === 'deleted')
      await this.#capabilities.requireTaskCapability('deleted', input.signal);
    const teamId = assertNonEmptyString(input.teamId, 'replaceTaskStatus', 'teamId');

    const payload = await this.#executePatch(
      {
        kind: 'replace_task_status',
        document: TASK_DOCUMENT,
        teamId,
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
    if (!input.teamId) {
      const result = await this.updateTaskFields({
        project: scope.project,
        spec: scope.spec,
        entity: input.entity,
        owner: input.owner ?? null,
        signal: input.signal,
      });
      if (result && result.ok === false) throw this.refusalFromEnvelope(result, 'replaceTaskOwner');
      return { outcome: 'APPLIED', transitions: [], refusal: null };
    }
    const teamId = assertNonEmptyString(input.teamId, 'replaceTaskOwner', 'teamId');
    const entity = assertEntity(input.entity, scope, 'replaceTaskOwner');
    const owner =
      input.owner === null ? null : assertNonEmptyString(input.owner, 'replaceTaskOwner', 'owner');
    if (owner === null) await this.#capabilities.requireTaskCapability('clearOwner', input.signal);

    const payload = await this.#executePatch(
      { kind: 'replace_task_owner', document: TASK_DOCUMENT, teamId, entity, owner },
      scope,
      input.signal
    );
    return toWriteResult(payload);
  }

  /** Replaces requirement/dependency/ref links of one task. */
  async replaceTaskLinks(input: ReplaceRegistryTaskLinksInput): Promise<RegistryTaskWriteResult> {
    const teamId = assertNonEmptyString(input.teamId, 'replaceTaskLinks', 'teamId');
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
    const expectedSha =
      input.expectedSha === undefined
        ? undefined
        : assertNonEmptyString(input.expectedSha, 'replaceTaskLinks', 'expectedSha');
    if (expectedSha !== undefined && !/^[a-f0-9]{64}$/.test(expectedSha)) {
      throw invalidArgument('replaceTaskLinks', 'expectedSha must be a lowercase SHA-256 digest');
    }
    if (requirements === undefined && dependsOn === undefined && refs === undefined) {
      throw invalidArgument(
        'replaceTaskLinks',
        'replaceTaskLinks needs at least one of requirements, dependsOn or refs'
      );
    }

    const payload = await this.#executePatch(
      {
        document: TASK_DOCUMENT,
        teamId,
        entity,
        ...(requirements === undefined ? {} : { requirements }),
        ...(dependsOn === undefined ? {} : { dependsOn }),
        ...(refs === undefined ? {} : { refs }),
        ...(expectedSha === undefined ? {} : { expectedSha }),
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
