import { randomUUID } from 'node:crypto';

import { RegistryTeamTaskWriteError } from './RegistryTeamTaskWriter';

import { isRecord, numberOrNull, stringOrNull } from './RegistryJson';
import { RegistryMcpTransport } from './RegistryMcpTransport';
import {
  type ResolvedRegistryTaskClientConfig,
  resolveRegistryTaskClientConfig,
  type ResolveRegistryTaskClientConfigInput,
} from './RegistryTaskClientConfig';
import {
  RegistryStatusConflictError,
  RegistryTaskClientError,
  RegistryTaskProtocolError,
  RegistryTaskWriteRefusedError,
} from './RegistryTaskClientErrors';
import type { RegistryTaskEntity } from '@shared/types';
import type { RegistryRegistrationIdentity } from '@shared/types';
import type { TeamSpecBinding } from './TeamSpecBinding';
import {
  digestTaskCreationToken,
  taskGenesisRequestDigest,
  taskLifecycleOperationCompletionDigest,
  taskPolicyDigest,
  validateTaskGenesisAttestationChallenge,
} from '@main/services/identity/TaskAttestation';
import type {
  PolicyChangeProof,
  SignedTaskPayload,
  TaskGenesisAttestationExpected,
  TaskIdentity,
  TaskPolicy,
  VerifiedTaskProof,
} from '@main/services/identity/TaskAttestation';
import type { RegistryTaskScope } from './RegistryTaskClientTypes';
import {
  type ListRegistryTasksInput,
  REGISTRY_TASK_STATUSES,
  type RegistryPatchPayload,
  type RegistryTask,
  type RegistryTaskCompletionReplayRecord,
  type RegistryTaskCompletionChallenge,
  type RegistryTaskCompletionChallengeInput,
  type RegistryTaskCompletionInput,
  type RegistryTaskCompletionResult,
  type RegistryTaskPolicyChangeChallenge,
  type RegistryTaskPolicyChangeChallengeInput,
  type RegistryTaskPolicyChangeInput,
  type RegistryTaskPolicyChangeResult,
  type RegistryTaskGenesisAttestation,
  type RegistryTaskGenesisChallenge,
  type RegistryTaskLifecycleReceipt,
  type RegistryTaskLifecycleBatchOperation,
  type RegistryTaskPolicyChangeReplayRecord,
  type RegistryTaskRefusal,
  type RegistryTasksPayload,
  type RegistryTaskStatus,
  type RegistryTaskStatusResult,
  type RegistryTaskTransition,
  type RegistryTaskSourceSnapshot,
  type RegistryTaskUpsertResult,
  type RegistryTaskGenesisReplayRecord,
  type RegistryTaskWriteResult,
  type RegistryToolEnvelope,
  type ReplaceRegistryTaskLinksInput,
  type ReplaceRegistryTaskOwnerInput,
  type ReplaceRegistryTaskStatusInput,
  type UpsertRegistryTaskInput,
} from './RegistryTaskClientTypes';

export type {
  RegistryTaskEntity,
  ListRegistryTasksInput,
  RegistryTask,
  RegistryTaskCompletionReplayRecord,
  RegistryTaskCompletionChallenge,
  RegistryTaskCompletionChallengeInput,
  RegistryTaskCompletionInput,
  RegistryTaskCompletionResult,
  RegistryTaskPolicyChangeChallenge,
  RegistryTaskPolicyChangeChallengeInput,
  RegistryTaskPolicyChangeInput,
  RegistryTaskPolicyChangeResult,
  RegistryTaskGenesisAttestation,
  RegistryTaskGenesisChallenge,
  RegistryTaskGenesisChallengeEntry,
  RegistryTaskLifecycleOperationReceipt,
  RegistryTaskLifecycleReceipt,
  RegistryTaskGenesisChallengeResult,
  RegistryTaskPolicyChangeReplayRecord,
  RegistryTaskStatus,
  RegistryTaskStatusResult,
  RegistryTaskTransition,
  RegistryTaskWriteOutcome,
  RegistryTaskWriteResult,
  RegistryTaskUpsertResult,
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

export interface RegistryTeamSpecBindings {
  teamId: string;
  bindings: TeamSpecBinding[];
}

/**
 * Registry-owned team tasks: read through `spec_tasks`, write through the
 * structured `spec_patch` operations. There is no local fallback — a failure
 * means the registry did not confirm the write, and the caller must decide.
 */
export class RegistryTaskClient {
  readonly #transport: RegistryMcpTransport;
  #capabilities: Record<string, unknown> | null = null;
  #patchArgumentCapabilities: Record<string, unknown> | null = null;
  #creationConfirmationSupported = false;

  async #requireTaskCapability(
    field: 'description' | 'creationToken' | 'deleted' | 'clearOwner' | 'policy' | 'force',
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.#capabilities) {
      const result = await this.#transport.listTools(signal);
      const patch = Array.isArray(result.tools)
        ? result.tools.find((tool) => isRecord(tool) && tool.name === 'spec_patch')
        : undefined;
      const schema = isRecord(patch) && isRecord(patch.inputSchema) ? patch.inputSchema : null;
      const variants = schema && Array.isArray(schema.oneOf) ? schema.oneOf : [];
      const patchVariant = variants.find((variant) => {
        if (!isRecord(variant) || !isRecord(variant.properties)) return false;
        const intent = variant.properties.intent;
        return isRecord(intent) && Array.isArray(intent.enum) && intent.enum.includes('patch');
      });
      this.#creationConfirmationSupported = variants.some((variant) => {
        if (!isRecord(variant) || !isRecord(variant.properties)) return false;
        const intent = variant.properties.intent;
        return (
          isRecord(intent) &&
          Array.isArray(intent.enum) &&
          intent.enum.includes('confirmTaskCreation')
        );
      });
      const sharedProperties = schema && isRecord(schema.properties) ? schema.properties : {};
      const patchProperties =
        isRecord(patchVariant) && isRecord(patchVariant.properties) ? patchVariant.properties : {};
      const properties = { ...sharedProperties, ...patchProperties };
      this.#patchArgumentCapabilities = properties;
      const operations = isRecord(properties.operations) ? properties.operations : null;
      const items = operations && isRecord(operations.items) ? operations.items : null;
      if (!items || !isRecord(items.properties)) {
        throw new RegistryTaskProtocolError(
          'listTools',
          'Registry does not advertise task operation capabilities'
        );
      }
      this.#capabilities = items.properties;
    }
    const properties = this.#capabilities;
    const schema =
      field === 'force'
        ? this.#patchArgumentCapabilities?.force
        : properties[field === 'deleted' ? 'status' : field === 'clearOwner' ? 'owner' : field];
    const supportsDeleted = (value: unknown): boolean =>
      isRecord(value) && Array.isArray(value.enum) && value.enum.includes('deleted');
    const supported =
      isRecord(schema) &&
      (field === 'force'
        ? schema.type === 'boolean'
        : field === 'policy'
          ? schema.type === 'object' && isRecord(schema.properties)
          : field === 'description' || field === 'creationToken'
            ? schema.type === 'string' &&
              (field !== 'creationToken' || this.#creationConfirmationSupported)
            : field === 'deleted'
              ? supportsDeleted(schema) && supportsDeleted(properties.expectedStatus)
              : schema.type === 'null' ||
                (Array.isArray(schema.type) && schema.type.includes('null')) ||
                (Array.isArray(schema.anyOf) &&
                  schema.anyOf.some((entry) => isRecord(entry) && entry.type === 'null')));
    if (!supported) {
      throw new RegistryTaskProtocolError(
        'listTools',
        `Registry does not support task capability: ${field}`
      );
    }
  }
  async #requireGenesisAttestationCapability(signal?: AbortSignal): Promise<void> {
    await this.#requireTaskCapability('policy', signal);
    const schema = this.#patchArgumentCapabilities?.genesisAttestations;
    if (!isRecord(schema) || schema.type !== 'array' || !isRecord(schema.items)) {
      throw new RegistryTaskProtocolError(
        'listTools',
        'Registry does not support signed initial task policy attestations'
      );
    }
  }

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
  /** Turns a registry envelope refusal into the typed error callers expect. */
  refusalFromEnvelope(
    envelope: { error?: unknown },
    operation: string
  ): RegistryTeamTaskWriteError {
    const error = (envelope.error ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof error.code === 'string' ? error.code : 'REGISTRY_REFUSED';
    const message =
      typeof error.message === 'string' ? error.message : 'the registry refused the write';
    return new RegistryTeamTaskWriteError('REGISTRY_REFUSED', `${operation}: ${message}`, {
      details: { registryCode: code },
    });
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
    return envelope as unknown as { ok?: unknown; error?: unknown };
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
    signal?: AbortSignal;
  }): Promise<{ ok?: unknown; error?: unknown }> {
    const scope = assertScope({ project: input.project, spec: input.spec }, 'updateTask');
    const entity = assertNonEmptyString(input.entity, 'updateTask', 'entity');
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
      },
      'updateTask',
      input.signal
    );
    return envelope as unknown as { ok?: unknown; error?: unknown };
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
    const entity = assertNonEmptyString(input.entity, 'addTaskComment', 'entity');
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
    return envelope as unknown as { ok?: unknown; error?: unknown };
  }

  async listTasks(input: ListRegistryTasksInput): Promise<RegistryTask[]> {
    const scope = assertScope(input, 'listTasks');
    const statuses = assertStatuses(input.statuses, 'listTasks');
    if (statuses?.includes('deleted')) await this.#requireTaskCapability('deleted', input.signal);
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
  async getTaskEntity(input: {
    project: string;
    spec: string;
    canonicalId: string;
    signal?: AbortSignal;
  }): Promise<RegistryTaskEntity> {
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
      const envelope = await this.#transport.callTool(
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
          throw new RegistryTaskProtocolError(
            'getTaskEntity',
            'registry repeated an entity cursor'
          );
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

  async getRegistrationIdentity(
    project: string,
    requestId: string,
    signal?: AbortSignal
  ): Promise<RegistryRegistrationIdentity> {
    const envelope = await this.#transport.callTool(
      'team_specs',
      {
        action: 'identity',
        project: assertNonEmptyString(project, 'identity', 'project'),
        requestId: assertNonEmptyString(requestId, 'identity', 'requestId'),
      },
      'identity',
      signal
    );
    return readRegistrationIdentity(envelope, 'identity');
  }

  /**
   * Requests a challenge for one bound task and verifies its caller identity
   * against the durable registration before exposing any signed-payload fields.
   */
  async requestTaskCompletionChallenge(
    input: RegistryTaskCompletionChallengeInput
  ): Promise<RegistryTaskCompletionChallenge> {
    const scope = assertScope(input, 'taskCompletionChallenge');
    const teamId = assertNonEmptyString(input.teamId, 'taskCompletionChallenge', 'teamId');
    const taskId = assertCanonicalTaskId(input.taskId, 'taskCompletionChallenge');
    const keyId = assertDigest(input.keyId, 'taskCompletionChallenge', 'keyId');
    const artifactDigest = assertDigest(
      input.artifactDigest,
      'taskCompletionChallenge',
      'artifactDigest'
    );
    const artifactSize = assertArtifactSize(input.artifactSize, 'taskCompletionChallenge');
    const expectedIdentity = assertRegistrationIdentity(
      input.expectedRegistrationIdentity,
      'taskCompletionChallenge'
    );

    const identity = await this.getRegistrationIdentity(scope.project, randomUUID(), input.signal);
    if (
      identity.securityStoreId !== expectedIdentity.securityStoreId ||
      identity.idp !== expectedIdentity.idp ||
      identity.userId !== expectedIdentity.userId
    ) {
      throw new RegistryTaskProtocolError(
        'taskCompletionChallenge',
        'registry registration identity mismatch'
      );
    }

    const requestId =
      input.requestId === undefined
        ? randomUUID()
        : assertNonEmptyString(input.requestId, 'taskCompletionChallenge', 'requestId');
    const envelope = await this.#transport.callTool(
      'team_specs',
      {
        action: 'task_challenge',
        project: scope.project,
        requestId,
        teamId,
        spec: scope.spec,
        taskId,
        operation: 'complete',
        keyId,
        artifactDigest,
        artifactSize,
      },
      'taskCompletionChallenge',
      input.signal
    );
    const data = readExactRecord(envelope.data, ['payload'], 'taskCompletionChallenge');
    const payload = readTaskAttestationPayload(data.payload, 'taskCompletionChallenge');
    if (
      payload[0] !== 'omp-spec-kit/task-attestation@1' ||
      payload[1] !== expectedIdentity.securityStoreId ||
      payload[2] !== expectedIdentity.idp ||
      payload[3] !== expectedIdentity.userId ||
      payload[4] !== teamId ||
      payload[5] !== scope.project ||
      payload[6] !== scope.spec ||
      payload[7] !== taskId ||
      payload[11] !== 'done' ||
      payload[14] !== artifactDigest ||
      payload[15] !== artifactSize ||
      payload[18] !== keyId ||
      payload[19] !== requestId
    ) {
      throw new RegistryTaskProtocolError(
        'taskCompletionChallenge',
        'registry returned a challenge outside the authenticated task scope'
      );
    }
    const callerIdentity = Object.freeze({
      registry: payload[1] as string,
      idp: payload[2] as string,
      userId: payload[3] as string,
      teamId: payload[4] as string,
      project: payload[5] as string,
      spec: payload[6] as string,
      taskId: payload[7] as string,
      generation: payload[8] as string,
      revision: payload[9] as string,
    });
    const proof = Object.freeze({
      ...callerIdentity,
      fromStatus: payload[10] as string,
      toStatus: payload[11] as string,
      policyVersion: payload[12] as number,
      policyDigest: payload[13] as string,
      artifactDigest: payload[14] as string,
      artifactSize: payload[15] as number,
    });
    return Object.freeze({
      project: scope.project,
      spec: scope.spec,
      requestId,
      teamId,
      taskId,
      expectedRegistrationIdentity: expectedIdentity,
      payload,
      callerIdentity,
      proof,
    });
  }

  async requestTaskPolicyChangeChallenge(
    input: RegistryTaskPolicyChangeChallengeInput
  ): Promise<RegistryTaskPolicyChangeChallenge> {
    const scope = assertScope(input, 'taskPolicyChangeChallenge');
    const teamId = assertNonEmptyString(input.teamId, 'taskPolicyChangeChallenge', 'teamId');
    const taskId = assertCanonicalTaskId(input.taskId, 'taskPolicyChangeChallenge');
    const keyId = assertDigest(input.keyId, 'taskPolicyChangeChallenge', 'keyId');
    const requestId =
      input.requestId === undefined
        ? randomUUID()
        : assertNonEmptyString(input.requestId, 'taskPolicyChangeChallenge', 'requestId');
    const expectedIdentity = assertRegistrationIdentity(
      input.expectedRegistrationIdentity,
      'taskPolicyChangeChallenge'
    );
    const policy = readTaskPolicy(input.policy, 'taskPolicyChangeChallenge');
    const identity = await this.getRegistrationIdentity(scope.project, randomUUID(), input.signal);
    if (
      identity.securityStoreId !== expectedIdentity.securityStoreId ||
      identity.idp !== expectedIdentity.idp ||
      identity.userId !== expectedIdentity.userId
    ) {
      throw new RegistryTaskProtocolError(
        'taskPolicyChangeChallenge',
        'registry registration identity mismatch'
      );
    }
    const envelope = await this.#transport.callTool(
      'team_specs',
      {
        action: 'task_challenge',
        project: scope.project,
        requestId,
        teamId,
        spec: scope.spec,
        taskId,
        operation: 'policy',
        keyId,
        policy,
      },
      'taskPolicyChangeChallenge',
      input.signal
    );
    const data = readExactRecord(envelope.data, ['payload'], 'taskPolicyChangeChallenge');
    const payload = readTaskPolicyChangePayload(data.payload, 'taskPolicyChangeChallenge');
    const { callerIdentity, proof } = readPolicyChangeProof(
      payload,
      expectedIdentity,
      { ...scope, teamId, taskId },
      requestId,
      policy,
      keyId,
      'taskPolicyChangeChallenge'
    );
    return Object.freeze({
      ...scope,
      requestId,
      teamId,
      taskId,
      expectedRegistrationIdentity: expectedIdentity,
      policy,
      payload,
      callerIdentity,
      proof,
    });
  }

  /** Journals the exact signed request before it can reach the registry. */
  async completeTask(input: RegistryTaskCompletionInput): Promise<RegistryTaskCompletionResult> {
    const replay = createRegistryTaskCompletionReplayRecord(
      input.challenge,
      input.signed,
      input.expectedRegistrationIdentity
    );
    await input.beforeSend(replay);
    return this.#submitTaskCompletionReplay(replay, input.signal);
  }

  /** Replays a persisted signed completion request without requesting a new challenge. */
  async replayTaskCompletionRequest(input: {
    replay: RegistryTaskCompletionReplayRecord;
    expectedRegistrationIdentity: RegistryRegistrationIdentity;
    signal?: AbortSignal;
  }): Promise<RegistryTaskCompletionResult> {
    const replay = readRegistryTaskCompletionReplayRecord(
      input.replay,
      input.expectedRegistrationIdentity
    );
    return this.#submitTaskCompletionReplay(replay, input.signal);
  }

  async #submitTaskCompletionReplay(
    replay: RegistryTaskCompletionReplayRecord,
    signal?: AbortSignal
  ): Promise<RegistryTaskCompletionResult> {
    const payload = replay.challengePayload;
    const envelope = await this.#transport.callTool(
      'team_specs',
      replay.requestArguments,
      'taskComplete',
      signal
    );
    const data = readExactRecord(
      envelope.data,
      ['outcome', 'status', 'commit', 'transitions'],
      'taskComplete'
    );
    if (
      data.outcome !== 'APPLIED' ||
      data.status !== 'done' ||
      typeof data.commit !== 'string' ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(data.commit) ||
      !Array.isArray(data.transitions) ||
      data.transitions.length !== 1
    ) {
      throw new RegistryTaskProtocolError(
        'taskComplete',
        'registry did not return a committed task completion'
      );
    }
    const rawTransition = readExactRecord(
      data.transitions[0],
      ['localId', 'from', 'to', 'requestId', 'actor', 'at'],
      'taskComplete'
    );
    const at = rawTransition.at;
    if (
      rawTransition.localId !== replay.taskId ||
      rawTransition.from !== payload[10] ||
      rawTransition.to !== 'done' ||
      rawTransition.requestId !== replay.requestId ||
      rawTransition.actor !== replay.callerIdentity.userId ||
      typeof at !== 'string' ||
      !Number.isFinite(Date.parse(at)) ||
      new Date(at).toISOString() !== at
    ) {
      throw new RegistryTaskProtocolError(
        'taskComplete',
        'registry returned a mismatched task completion receipt'
      );
    }
    const transition: RegistryTaskTransition = Object.freeze({
      localId: replay.taskId,
      from: payload[10] as string,
      to: 'done',
      requestId: replay.requestId,
      actor: replay.callerIdentity.userId,
      at,
    });
    return Object.freeze({
      outcome: 'APPLIED',
      status: 'done',
      requestId: replay.requestId,
      project: replay.project,
      spec: replay.spec,
      teamId: replay.teamId,
      taskId: replay.taskId,
      commit: data.commit,
      transitions: Object.freeze([transition]),
    });
  }

  /** Journals the exact signed policy request before it can reach the registry. */
  async changeTaskPolicy(
    input: RegistryTaskPolicyChangeInput
  ): Promise<RegistryTaskPolicyChangeResult> {
    const replay = createRegistryTaskPolicyChangeReplayRecord(
      input.challenge,
      input.signed,
      input.expectedRegistrationIdentity
    );
    await input.beforeSend(replay);
    return this.#submitTaskPolicyChangeReplay(replay, input.signal);
  }

  /** Replays a persisted signed policy request without requesting a new challenge. */
  async replayTaskPolicyChangeRequest(input: {
    replay: RegistryTaskPolicyChangeReplayRecord;
    expectedRegistrationIdentity: RegistryRegistrationIdentity;
    signal?: AbortSignal;
  }): Promise<RegistryTaskPolicyChangeResult> {
    const replay = readRegistryTaskPolicyChangeReplayRecord(
      input.replay,
      input.expectedRegistrationIdentity
    );
    return this.#submitTaskPolicyChangeReplay(replay, input.signal);
  }

  async #submitTaskPolicyChangeReplay(
    replay: RegistryTaskPolicyChangeReplayRecord,
    signal?: AbortSignal
  ): Promise<RegistryTaskPolicyChangeResult> {
    const envelope = await this.#transport.callTool(
      'team_specs',
      replay.requestArguments,
      'taskPolicyChange',
      signal
    );
    const data = readExactRecord(
      envelope.data,
      ['outcome', 'version', 'digest'],
      'taskPolicyChange'
    );
    const expectedVersion = replay.proof.nextVersion;
    const expectedDigest = taskPolicyDigest(replay.policy);
    if (
      (data.outcome !== 'APPLIED' && data.outcome !== 'UNCHANGED') ||
      !Number.isSafeInteger(data.version) ||
      data.version !== expectedVersion ||
      data.digest !== expectedDigest
    ) {
      throw new RegistryTaskProtocolError(
        'taskPolicyChange',
        'registry returned a mismatched task policy receipt'
      );
    }
    return Object.freeze({
      outcome: data.outcome,
      requestId: replay.requestId,
      project: replay.project,
      spec: replay.spec,
      teamId: replay.teamId,
      taskId: replay.taskId,
      version: data.version,
      digest: data.digest,
    });
  }

  async registerTeam(
    project: string,
    requestId: string,
    expected: RegistryRegistrationIdentity,
    signal?: AbortSignal
  ): Promise<RegistryTeamSpecBindings> {
    const scopeProject = assertNonEmptyString(project, 'registerTeam', 'project');
    const id = assertNonEmptyString(requestId, 'registerTeam', 'requestId');
    const envelope = await this.#transport.callTool(
      'team_specs',
      {
        action: 'register',
        project: scopeProject,
        requestId: id,
        expectedSecurityStoreId: expected.securityStoreId,
        expectedIdp: expected.idp,
        expectedUserId: expected.userId,
      },
      'registerTeam',
      signal
    );
    const actual = readRegistrationIdentity(envelope, 'registerTeam');
    if (
      actual.securityStoreId !== expected.securityStoreId ||
      actual.idp !== expected.idp ||
      actual.userId !== expected.userId
    ) {
      throw new RegistryTaskProtocolError(
        'registerTeam',
        'registry registration identity mismatch'
      );
    }
    return readTeamSpecBindings(envelope, 'registerTeam');
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
    await this.#requireTaskCapability('creationToken', input.signal);
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
    await this.#requireGenesisAttestationCapability(input.signal);
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
      await this.#requireTaskCapability('description', input.signal);
    const creationToken =
      input.creationToken === undefined
        ? undefined
        : assertOpaqueToken(input.creationToken, 'upsertTask', 'creationToken');
    const creationTokenDigest =
      creationToken === undefined
        ? undefined
        : digestCreationTokenSafely(creationToken, 'upsertTask');
    if (creationToken !== undefined)
      await this.#requireTaskCapability('creationToken', input.signal);
    const status =
      input.status === undefined ? undefined : assertTaskStatus(input.status, 'upsertTask');
    if (status === 'deleted') await this.#requireTaskCapability('deleted', input.signal);
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
      await this.#requireTaskCapability('policy', input.signal);
    }
    if (genesisAttestations !== undefined) {
      if (policy?.required !== true || !creationToken || !expectedRegistrationIdentity) {
        throw invalidArgument(
          'upsertTask',
          'initial-policy attestations require the exact required-policy request'
        );
      }
      await this.#requireGenesisAttestationCapability(input.signal);
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
      await this.#requireTaskCapability('force', input.signal);
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

    return this.#executeUpsertPatch({
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
      await this.#requireTaskCapability('deleted', input.signal);
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
      if (result && result.ok === false)
        throw this.refusalFromEnvelope(result, 'replaceTaskOwner');
      return { outcome: 'APPLIED', transitions: [], refusal: null };
    }
    const teamId = assertNonEmptyString(input.teamId, 'replaceTaskOwner', 'teamId');
    const entity = assertEntity(input.entity, scope, 'replaceTaskOwner');
    const owner =
      input.owner === null ? null : assertNonEmptyString(input.owner, 'replaceTaskOwner', 'owner');
    if (owner === null) await this.#requireTaskCapability('clearOwner', input.signal);

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

  async #executeUpsertPatch(input: {
    operation: Record<string, unknown>;
    scope: { project: string; spec: string };
    requestId: string;
    signal?: AbortSignal;
    force?: boolean;
    creationToken?: string;
    creationTokenDigest?: string;
    policy?: TaskPolicy;
    expectedRegistrationIdentity?: RegistryRegistrationIdentity;
    genesisAttestations?: readonly RegistryTaskGenesisAttestation[];
    genesisChallenge?: RegistryTaskGenesisChallenge;
    beforeGenesisAttestationSend?: (
      replay: RegistryTaskGenesisReplayRecord
    ) => void | Promise<void>;
  }): Promise<RegistryTaskUpsertResult> {
    const requestArguments: Record<string, unknown> = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      intent: 'patch',
      project: input.scope.project,
      spec: input.scope.spec,
      requestId: input.requestId,
      reason: `agent-teams task registry: ${String(input.operation.kind)}`,
      dryRun: false,
      operations: [input.operation],
      ...(input.force === undefined ? {} : { force: input.force }),
      ...(input.genesisAttestations === undefined
        ? {}
        : { genesisAttestations: input.genesisAttestations }),
    };
    const requiredPolicy = input.policy?.required === true ? input.policy : null;
    let expected: TaskGenesisAttestationExpected | null = null;
    if (requiredPolicy !== null) {
      const identity = input.expectedRegistrationIdentity;
      const creationToken = input.creationToken;
      const creationTokenDigest = input.creationTokenDigest;
      if (!identity || !creationToken || !creationTokenDigest) {
        throw invalidArgument(
          'upsertTask',
          'required initial policy needs a creation token and active registration identity'
        );
      }
      const payloadDigest = taskGenesisRequestDigest(
        input.requestId,
        input.scope.project,
        requestArguments
      );
      const taskLocalId = assertNonEmptyString(input.operation.localId, 'upsertTask', 'localId');
      const taskId = assertCanonicalTaskId(
        taskLocalId.startsWith('TASK-') ? taskLocalId : `TASK-${taskLocalId}`,
        'upsertTask'
      );
      expected = {
        registryStoreId: identity.securityStoreId,
        idp: identity.idp,
        userId: identity.userId,
        teamId: assertNonEmptyString(input.operation.teamId, 'upsertTask', 'teamId'),
        project: input.scope.project,
        spec: input.scope.spec,
        taskId,
        requestId: input.requestId,
        payloadDigest,
        creationTokenDigest,
        policy: requiredPolicy,
      };
    }

    let attestations: readonly RegistryTaskGenesisAttestation[] | undefined;
    if (input.genesisAttestations !== undefined) {
      if (expected === null || input.genesisAttestations.length !== 1) {
        throw invalidArgument(
          'upsertTask',
          'initial policy requires exactly one genesis attestation'
        );
      }
      const submitted = input.genesisAttestations[0];
      if (!submitted) {
        throw invalidArgument('upsertTask', 'genesis attestation is missing');
      }
      try {
        const validatedPayload = validateTaskGenesisAttestationChallenge(
          expected,
          submitted.payload
        );
        if (
          submitted.operationId !== validatedPayload[15] ||
          submitted.keyId !== validatedPayload[22] ||
          submitted.nonce !== validatedPayload[23]
        ) {
          throw new Error('challenge fields mismatch');
        }
        attestations = [
          Object.freeze({
            operationId: submitted.operationId,
            nonce: submitted.nonce,
            keyId: submitted.keyId,
            payload: validatedPayload,
            signature: submitted.signature,
          }),
        ];
      } catch {
        throw invalidArgument('upsertTask', 'genesis attestation does not match the exact request');
      }
      requestArguments.genesisAttestations = attestations;
    }

    let outboundArguments = requestArguments;
    if (attestations !== undefined) {
      const attestation = attestations[0];
      if (
        expected === null ||
        !attestation ||
        !input.genesisChallenge ||
        !input.beforeGenesisAttestationSend
      ) {
        throw invalidArgument(
          'upsertTask',
          'signed initial-policy writes require a challenge and durable pre-send journal'
        );
      }
      const challenge = readTaskGenesisChallengeForExpected(
        expected,
        input.genesisChallenge,
        attestation,
        'upsertTask'
      );
      outboundArguments = freezeJsonRecord(requestArguments, 'upsertTask');
      await input.beforeGenesisAttestationSend(
        Object.freeze({ challenge, attestation, requestArguments: outboundArguments })
      );
    }

    const envelope = await this.#transport.callTool(
      'spec_patch',
      outboundArguments,
      'upsertTask',
      input.signal,
      { allowTaskGenesisChallenge: expected !== null && attestations === undefined }
    );
    if (!envelope.ok) {
      if (expected === null) {
        throw new RegistryTaskProtocolError(
          'upsertTask',
          'Registry requested a genesis challenge without a required initial policy'
        );
      }
      return readTaskGenesisChallenge(envelope, expected);
    }

    const payload = readPatchPayload(envelope, 'upsertTask');
    const result = toWriteResult(payload);
    if (expected !== null && result.outcome !== 'REFUSED') {
      if (!payload.taskLifecycleReceipt) {
        throw new RegistryTaskProtocolError(
          'upsertTask',
          'Registry did not confirm the signed initial policy lifecycle'
        );
      }
      const genesisPayload = attestations?.[0]?.payload;
      if (!genesisPayload) {
        throw new RegistryTaskProtocolError(
          'upsertTask',
          'Registry completed initial policy creation without the submitted genesis proof'
        );
      }
      assertGenesisLifecycleReceipt(payload.taskLifecycleReceipt, genesisPayload);
      return { ...result, taskLifecycleReceipt: payload.taskLifecycleReceipt };
    }
    return result;
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

function readTaskGenesisChallenge(
  envelope: RegistryToolEnvelope<unknown>,
  expected: TaskGenesisAttestationExpected
): RegistryTaskUpsertResult {
  const fail = (): never => {
    throw new RegistryTaskProtocolError(
      'upsertTask',
      'Registry returned an invalid initial-policy challenge'
    );
  };
  if (
    envelope.ok ||
    envelope.operation !== 'spec_patch' ||
    envelope.requestId !== expected.requestId ||
    envelope.error?.code !== 'TASK_GENESIS_CHALLENGE_REQUIRED' ||
    envelope.error.retryable
  ) {
    return fail();
  }
  const data = readExactRecord(
    envelope.data,
    ['outcome', 'batchId', 'requestId', 'payloadDigest', 'challenges'],
    'upsertTask'
  );
  const batchId = data.batchId;
  const requestId = data.requestId;
  const payloadDigest = data.payloadDigest;
  const challenges = data.challenges;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const digest = /^[0-9a-f]{64}$/u;
  if (
    data.outcome !== 'CHALLENGE_REQUIRED' ||
    typeof batchId !== 'string' ||
    !uuid.test(batchId) ||
    requestId !== expected.requestId ||
    payloadDigest !== expected.payloadDigest ||
    !Array.isArray(challenges) ||
    challenges.length !== 1 ||
    Reflect.ownKeys(challenges).length !== 2 ||
    Object.getPrototypeOf(challenges) !== Array.prototype
  ) {
    return fail();
  }
  const rawChallenge = Object.getOwnPropertyDescriptor(challenges, '0');
  if (!rawChallenge || !('value' in rawChallenge) || !rawChallenge.enumerable) return fail();
  const record = readExactRecord(
    rawChallenge.value,
    ['operationId', 'nonce', 'keyId', 'payload'],
    'upsertTask'
  );
  const operationId = record.operationId;
  const nonce = record.nonce;
  const keyId = record.keyId;
  if (
    typeof operationId !== 'string' ||
    !uuid.test(operationId) ||
    typeof nonce !== 'string' ||
    !digest.test(nonce) ||
    typeof keyId !== 'string' ||
    !digest.test(keyId)
  ) {
    return fail();
  }
  let payload: readonly (string | number | null)[];
  try {
    payload = validateTaskGenesisAttestationChallenge(expected, record.payload);
  } catch {
    return fail();
  }
  if (
    payload[14] !== batchId ||
    payload[15] !== operationId ||
    payload[22] !== keyId ||
    payload[23] !== nonce
  ) {
    return fail();
  }
  const challenge: RegistryTaskGenesisChallenge = Object.freeze({
    batchId,
    requestId: expected.requestId,
    payloadDigest: expected.payloadDigest,
    challenges: Object.freeze([
      Object.freeze({
        operationId,
        nonce,
        keyId,
        payload,
      }),
    ]),
  });
  return Object.freeze({ outcome: 'CHALLENGE_REQUIRED', challenge, expected });
}

interface RegistryTaskGenesisReplayArguments extends Record<string, unknown> {
  readonly project: string;
  readonly spec: string;
  readonly requestId: string;
  readonly operations: readonly [Readonly<Record<string, unknown>>];
}

interface ValidatedRegistryTaskGenesisReplay {
  challenge: RegistryTaskGenesisChallenge;
  attestation: RegistryTaskGenesisAttestation;
  requestArguments: RegistryTaskGenesisReplayArguments;
  payload: readonly (string | number | null)[];
}

function readTaskGenesisChallengeForExpected(
  expected: TaskGenesisAttestationExpected,
  value: unknown,
  attestation: RegistryTaskGenesisAttestation,
  operation: string,
  allowExpired = false
): RegistryTaskGenesisChallenge {
  const fail = (): never => {
    throw new RegistryTaskProtocolError(
      operation,
      'GENESIS challenge does not match the signed request'
    );
  };
  const record = readExactRecord(
    value,
    ['batchId', 'requestId', 'payloadDigest', 'challenges'],
    operation
  );
  const batchId = record.batchId;
  const requestId = record.requestId;
  const payloadDigest = record.payloadDigest;
  const challenges = record.challenges;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const digest = /^[0-9a-f]{64}$/u;
  if (
    typeof batchId !== 'string' ||
    !uuid.test(batchId) ||
    requestId !== expected.requestId ||
    payloadDigest !== expected.payloadDigest ||
    !Array.isArray(challenges) ||
    Object.getPrototypeOf(challenges) !== Array.prototype ||
    challenges.length !== 1 ||
    Reflect.ownKeys(challenges).length !== 2
  ) {
    return fail();
  }
  const rawEntry = Object.getOwnPropertyDescriptor(challenges, '0');
  if (!rawEntry || !rawEntry.enumerable || !('value' in rawEntry)) return fail();
  const entry = readExactRecord(
    rawEntry.value,
    ['operationId', 'nonce', 'keyId', 'payload'],
    operation
  );
  const operationId = entry.operationId;
  const nonce = entry.nonce;
  const keyId = entry.keyId;
  if (
    typeof operationId !== 'string' ||
    !uuid.test(operationId) ||
    typeof nonce !== 'string' ||
    !digest.test(nonce) ||
    typeof keyId !== 'string' ||
    !digest.test(keyId)
  ) {
    return fail();
  }
  const rawPayload = readGenesisPayload(entry.payload, operation);
  const expiresAt = rawPayload[24];
  const validationNow = allowExpired && typeof expiresAt === 'number' ? expiresAt - 1 : Date.now();
  let payload: readonly (string | number | null)[];
  let attestedPayload: readonly (string | number | null)[];
  try {
    payload = validateTaskGenesisAttestationChallenge(expected, rawPayload, validationNow);
    attestedPayload = validateTaskGenesisAttestationChallenge(
      expected,
      attestation.payload,
      validationNow
    );
  } catch {
    return fail();
  }
  if (
    payload[14] !== batchId ||
    payload[15] !== operationId ||
    payload[22] !== keyId ||
    payload[23] !== nonce ||
    attestation.operationId !== operationId ||
    attestation.keyId !== keyId ||
    attestation.nonce !== nonce ||
    JSON.stringify(payload) !== JSON.stringify(attestedPayload)
  ) {
    return fail();
  }
  return Object.freeze({
    batchId,
    requestId: expected.requestId,
    payloadDigest: expected.payloadDigest,
    challenges: Object.freeze([
      Object.freeze({
        operationId,
        nonce,
        keyId,
        payload,
      }),
    ]),
  });
}

function readRegistryTaskGenesisReplay(
  value: unknown,
  registrationIdentity: RegistryRegistrationIdentity
): ValidatedRegistryTaskGenesisReplay {
  const record = readExactRecord(
    value,
    ['challenge', 'attestation', 'requestArguments'],
    'upsertTask'
  );
  const requestArguments = readTaskGenesisReplayArguments(record.requestArguments);
  const operation = requestArguments.operations[0];
  const identity = assertRegistrationIdentity(registrationIdentity, 'upsertTask');
  const scope = assertScope(
    { project: requestArguments.project, spec: requestArguments.spec },
    'upsertTask'
  );
  const requestId = assertUuid(requestArguments.requestId, 'upsertTask', 'requestId');
  const creationToken = assertOpaqueToken(operation.creationToken, 'upsertTask', 'creationToken');
  const policy = assertRequiredTaskPolicy(operation.policy);
  if (!policy.required) {
    throw invalidArgument('upsertTask', 'persisted GENESIS replay has no required policy');
  }
  const localId = assertNonEmptyString(operation.localId, 'upsertTask', 'localId');
  const taskId = assertCanonicalTaskId(
    localId.startsWith('TASK-') ? localId : `TASK-${localId}`,
    'upsertTask'
  );
  const expected: TaskGenesisAttestationExpected = {
    registryStoreId: identity.securityStoreId,
    idp: identity.idp,
    userId: identity.userId,
    teamId: assertNonEmptyString(operation.teamId, 'upsertTask', 'teamId'),
    project: scope.project,
    spec: scope.spec,
    taskId,
    requestId,
    payloadDigest: taskGenesisRequestDigest(requestId, scope.project, requestArguments),
    creationTokenDigest: digestTaskCreationToken(creationToken),
    policy,
  };
  const attestation = readGenesisAttestations([record.attestation], 'upsertTask')[0];
  const wireAttestation = readGenesisAttestations(
    requestArguments.genesisAttestations,
    'upsertTask'
  )[0];
  if (
    !attestation ||
    !wireAttestation ||
    !sameTaskGenesisAttestation(attestation, wireAttestation)
  ) {
    throw invalidArgument(
      'upsertTask',
      'persisted GENESIS signature differs from the exact request'
    );
  }
  const challenge = readTaskGenesisChallengeForExpected(
    expected,
    record.challenge,
    attestation,
    'upsertTask',
    true
  );
  const challengeEntry = challenge.challenges[0];
  if (
    !challengeEntry ||
    challengeEntry.payload[14] !== challenge.batchId ||
    challenge.requestId !== requestArguments.requestId ||
    challenge.payloadDigest !== expected.payloadDigest
  ) {
    throw invalidArgument('upsertTask', 'persisted GENESIS challenge is not request-bound');
  }
  return {
    challenge,
    attestation,
    requestArguments,
    payload: challengeEntry.payload,
  };
}

function readTaskGenesisReplayArguments(value: unknown): RegistryTaskGenesisReplayArguments {
  const parsed = parseTaskGenesisReplayArguments(value);
  return parseTaskGenesisReplayArguments(freezeJsonRecord(parsed, 'upsertTask'));
}

function parseTaskGenesisReplayArguments(value: unknown): RegistryTaskGenesisReplayArguments {
  const args = readAllowedRecord(
    value,
    [
      'schemaVersion',
      'intent',
      'project',
      'spec',
      'requestId',
      'reason',
      'dryRun',
      'operations',
      'genesisAttestations',
    ],
    ['force'],
    'upsertTask'
  );
  const project = args.project;
  const spec = args.spec;
  const requestId = args.requestId;
  const operations = args.operations;
  if (
    args.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
    args.intent !== 'patch' ||
    typeof project !== 'string' ||
    !project ||
    project.trim() !== project ||
    typeof spec !== 'string' ||
    !spec ||
    spec.trim() !== spec ||
    typeof requestId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(requestId) ||
    args.reason !== 'agent-teams task registry: upsert_task' ||
    args.dryRun !== false ||
    (Object.hasOwn(args, 'force') && typeof args.force !== 'boolean') ||
    !Array.isArray(operations) ||
    Object.getPrototypeOf(operations) !== Array.prototype ||
    operations.length !== 1 ||
    Reflect.ownKeys(operations).length !== 2
  ) {
    throw invalidArgument('upsertTask', 'persisted GENESIS request arguments are invalid');
  }
  const rawOperation = Object.getOwnPropertyDescriptor(operations, '0');
  if (!rawOperation || !rawOperation.enumerable || !('value' in rawOperation)) {
    throw invalidArgument('upsertTask', 'persisted GENESIS operation is invalid');
  }
  const task = readAllowedRecord(
    rawOperation.value,
    ['kind', 'document', 'teamId', 'localId', 'title', 'requirements', 'creationToken', 'policy'],
    ['body', 'description', 'status', 'owner', 'tracking', 'dependsOn', 'expectedSha', 'refs'],
    'upsertTask'
  );
  if (
    task.kind !== 'upsert_task' ||
    task.document !== TASK_DOCUMENT ||
    typeof task.teamId !== 'string' ||
    !task.teamId ||
    task.teamId.trim() !== task.teamId ||
    typeof task.localId !== 'string' ||
    !/^(?:[1-9][0-9]*|TASK-[1-9][0-9]*)$/u.test(task.localId) ||
    typeof task.title !== 'string' ||
    !task.title.trim() ||
    !Array.isArray(task.requirements) ||
    Object.getPrototypeOf(task.requirements) !== Array.prototype ||
    (Object.hasOwn(task, 'body') && typeof task.body !== 'string') ||
    (Object.hasOwn(task, 'description') && typeof task.description !== 'string') ||
    (Object.hasOwn(task, 'owner') && (typeof task.owner !== 'string' || !task.owner.trim())) ||
    (Object.hasOwn(task, 'tracking') &&
      (typeof task.tracking !== 'string' || !task.tracking.trim())) ||
    (Object.hasOwn(task, 'expectedSha') &&
      (typeof task.expectedSha !== 'string' || !/^[a-f0-9]{64}$/u.test(task.expectedSha)))
  ) {
    throw invalidArgument('upsertTask', 'persisted GENESIS task operation is invalid');
  }
  assertStringArray(task.requirements, 'upsertTask', 'requirements');
  if (Object.hasOwn(task, 'status')) assertTaskStatus(task.status, 'upsertTask');
  if (Object.hasOwn(task, 'dependsOn'))
    assertStringArray(task.dependsOn, 'upsertTask', 'dependsOn');
  if (Object.hasOwn(task, 'refs')) assertStringArray(task.refs, 'upsertTask', 'refs');
  const genesisAttestations = args.genesisAttestations;
  if (
    !Array.isArray(genesisAttestations) ||
    Object.getPrototypeOf(genesisAttestations) !== Array.prototype ||
    genesisAttestations.length !== 1 ||
    Reflect.ownKeys(genesisAttestations).length !== 2
  ) {
    throw invalidArgument('upsertTask', 'persisted GENESIS request must carry one signature');
  }
  readGenesisAttestations(genesisAttestations, 'upsertTask');
  const frozenOperation: Readonly<Record<string, unknown>> = Object.freeze(task);
  const frozenOperations: readonly [Readonly<Record<string, unknown>>] = [frozenOperation];
  Object.freeze(frozenOperations);
  return Object.freeze({
    ...args,
    project,
    spec,
    requestId,
    operations: frozenOperations,
  });
}

function readAllowedRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  operation: string
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidArgument(operation, 'persisted request object is invalid');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some(
      (key) =>
        typeof key !== 'string' || (!requiredKeys.includes(key) && !optionalKeys.includes(key))
    ) ||
    requiredKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalidArgument(operation, 'persisted request contains missing or unexpected fields');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalidArgument(operation, 'persisted request contains an unsafe field');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function sameTaskGenesisAttestation(
  left: RegistryTaskGenesisAttestation,
  right: RegistryTaskGenesisAttestation
): boolean {
  return (
    left.operationId === right.operationId &&
    left.nonce === right.nonce &&
    left.keyId === right.keyId &&
    left.signature === right.signature &&
    JSON.stringify(left.payload) === JSON.stringify(right.payload)
  );
}

function freezeJsonRecord(
  value: Record<string, unknown>,
  operation: string
): Record<string, unknown> {
  const clone = (current: unknown, depth: number): unknown => {
    if (depth > 64) throw invalidArgument(operation, 'request arguments are too deeply nested');
    if (
      current === null ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      (typeof current === 'number' && Number.isFinite(current))
    ) {
      return current;
    }
    if (Array.isArray(current)) {
      if (
        Object.getPrototypeOf(current) !== Array.prototype ||
        Reflect.ownKeys(current).length !== current.length + 1
      ) {
        throw invalidArgument(operation, 'request arguments contain an unsafe array');
      }
      return Object.freeze(current.map((entry) => clone(entry, depth + 1)));
    }
    if (
      typeof current !== 'object' ||
      (Object.getPrototypeOf(current) !== Object.prototype &&
        Object.getPrototypeOf(current) !== null)
    ) {
      throw invalidArgument(operation, 'request arguments contain an unsafe value');
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Reflect.ownKeys(current)) {
      if (typeof key !== 'string') {
        throw invalidArgument(operation, 'request arguments contain a symbol key');
      }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        throw invalidArgument(operation, 'request arguments contain an unsafe property');
      }
      Object.defineProperty(output, key, {
        value: clone(descriptor.value, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(output);
  };
  const cloned = clone(value, 0);
  if (!isRecord(cloned)) {
    throw invalidArgument(operation, 'request arguments must be an object');
  }
  return cloned;
}

function readGenesisAttestations(
  value: unknown,
  operation: string
): readonly RegistryTaskGenesisAttestation[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== value.length + 1
  ) {
    throw invalidArgument(operation, 'genesisAttestations must be a dense array');
  }
  return Object.freeze(
    value.map((entry) => {
      const record = readExactRecord(
        entry,
        ['operationId', 'nonce', 'keyId', 'payload', 'signature'],
        operation
      );
      if (
        typeof record.operationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
          record.operationId
        ) ||
        typeof record.nonce !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(record.nonce) ||
        typeof record.keyId !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(record.keyId) ||
        typeof record.signature !== 'string' ||
        !/^[A-Za-z0-9_-]+$/u.test(record.signature) ||
        Buffer.from(record.signature, 'base64url').length !== 64 ||
        Buffer.from(record.signature, 'base64url').toString('base64url') !== record.signature
      ) {
        throw invalidArgument(operation, 'genesisAttestation metadata or signature is invalid');
      }
      return Object.freeze({
        operationId: record.operationId,
        nonce: record.nonce,
        keyId: record.keyId,
        payload: readGenesisPayload(record.payload, operation),
        signature: record.signature,
      });
    })
  );
}

function readGenesisPayload(
  value: unknown,
  operation: string
): readonly (string | number | null)[] {
  if (
    !Array.isArray(value) ||
    value.length !== 25 ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Reflect.ownKeys(value).length !== 26
  ) {
    throw invalidArgument(operation, 'genesis attestation payload must have 25 dense slots');
  }
  const payload: (string | number | null)[] = [];
  for (let index = 0; index < 25; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const slot = descriptor?.value;
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      (slot !== null && typeof slot !== 'string' && typeof slot !== 'number')
    ) {
      throw invalidArgument(operation, 'genesis attestation payload has an invalid slot');
    }
    payload.push(slot as string | number | null);
  }
  return Object.freeze(payload);
}

function readLifecycleBatchOperation(
  value: unknown,
  operation: string
): RegistryTaskLifecycleBatchOperation {
  if (!isRecord(value)) {
    throw new RegistryTaskProtocolError(
      operation,
      'spec_patch returned an invalid batch operation'
    );
  }
  const kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind');
  if (
    !kindDescriptor ||
    !('value' in kindDescriptor) ||
    (kindDescriptor.value !== 'GENESIS' && kindDescriptor.value !== 'TOMBSTONE')
  ) {
    throw new RegistryTaskProtocolError(
      operation,
      'spec_patch returned an unknown batch operation'
    );
  }
  const commonKeys = [
    'createdAt',
    'generationId',
    'kind',
    'operationId',
    'ownerPrincipal',
    'project',
    'reservationId',
    'sequence',
    'spec',
    'taskId',
    'teamId',
  ];
  const genesisKeys = [
    ...commonKeys,
    'creationTokenDigest',
    'genesisExpiresAt',
    'genesisKeyId',
    'genesisNonce',
    'genesisOrigin',
    'policy',
    'policyDigest',
    'taskRevisionSha256',
  ];
  const record = readExactRecord(
    value,
    kindDescriptor.value === 'GENESIS' ? genesisKeys : commonKeys,
    operation
  );
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const digest = /^[0-9a-f]{64}$/u;
  const createdAt =
    typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt))
      ? new Date(record.createdAt).toISOString() === record.createdAt
      : false;
  if (
    !createdAt ||
    typeof record.generationId !== 'string' ||
    !uuid.test(record.generationId) ||
    typeof record.operationId !== 'string' ||
    !uuid.test(record.operationId) ||
    typeof record.ownerPrincipal !== 'string' ||
    !record.ownerPrincipal ||
    record.ownerPrincipal.trim() !== record.ownerPrincipal ||
    typeof record.project !== 'string' ||
    !record.project ||
    record.project.trim() !== record.project ||
    typeof record.reservationId !== 'string' ||
    !uuid.test(record.reservationId) ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 0 ||
    typeof record.spec !== 'string' ||
    !record.spec ||
    record.spec.trim() !== record.spec ||
    typeof record.taskId !== 'string' ||
    !/^TASK-[1-9][0-9]*$/u.test(record.taskId) ||
    typeof record.teamId !== 'string' ||
    !record.teamId ||
    record.teamId.trim() !== record.teamId
  ) {
    throw new RegistryTaskProtocolError(
      operation,
      'spec_patch returned an invalid batch operation'
    );
  }
  const base = {
    createdAt: record.createdAt as string,
    generationId: record.generationId,
    operationId: record.operationId,
    ownerPrincipal: record.ownerPrincipal,
    project: record.project,
    reservationId: record.reservationId,
    sequence: record.sequence as number,
    spec: record.spec,
    taskId: record.taskId,
    teamId: record.teamId,
  };
  if (record.kind === 'TOMBSTONE') {
    return Object.freeze({ ...base, kind: 'TOMBSTONE' as const });
  }
  if (record.kind !== 'GENESIS') {
    throw new RegistryTaskProtocolError(
      operation,
      'spec_patch returned an unknown batch operation'
    );
  }
  const policyRecord = readExactRecord(record.policy, ['expectedFilename', 'required'], operation);
  const policy = Object.freeze({
    expectedFilename: policyRecord.expectedFilename,
    required: policyRecord.required,
  });
  if (
    typeof record.creationTokenDigest !== 'string' ||
    !digest.test(record.creationTokenDigest) ||
    (record.genesisExpiresAt !== null &&
      (!Number.isSafeInteger(record.genesisExpiresAt) ||
        (record.genesisExpiresAt as number) <= 0)) ||
    (record.genesisKeyId !== null &&
      (typeof record.genesisKeyId !== 'string' || !digest.test(record.genesisKeyId))) ||
    (record.genesisNonce !== null &&
      (typeof record.genesisNonce !== 'string' || !digest.test(record.genesisNonce))) ||
    (record.genesisOrigin !== 'SERVER_GENESIS' && record.genesisOrigin !== 'SIGNED_GENESIS') ||
    typeof policy.required !== 'boolean' ||
    (policy.expectedFilename !== null &&
      (typeof policy.expectedFilename !== 'string' ||
        !policy.expectedFilename.trim() ||
        policy.expectedFilename.trim() !== policy.expectedFilename)) ||
    typeof record.policyDigest !== 'string' ||
    !digest.test(record.policyDigest) ||
    typeof record.taskRevisionSha256 !== 'string' ||
    !digest.test(record.taskRevisionSha256)
  ) {
    throw new RegistryTaskProtocolError(
      operation,
      'spec_patch returned an invalid GENESIS operation'
    );
  }
  const taskPolicy = policy as TaskPolicy;
  let computedPolicyDigest: string;
  try {
    computedPolicyDigest = taskPolicyDigest(taskPolicy);
  } catch {
    throw new RegistryTaskProtocolError(operation, 'spec_patch returned an invalid GENESIS policy');
  }
  if (computedPolicyDigest !== record.policyDigest) {
    throw new RegistryTaskProtocolError(
      operation,
      'spec_patch returned a mismatched GENESIS policy digest'
    );
  }
  return Object.freeze({
    ...base,
    kind: 'GENESIS' as const,
    creationTokenDigest: record.creationTokenDigest,
    genesisExpiresAt: record.genesisExpiresAt as number | null,
    genesisKeyId: record.genesisKeyId as string | null,
    genesisNonce: record.genesisNonce as string | null,
    genesisOrigin: record.genesisOrigin,
    policy: taskPolicy,
    policyDigest: record.policyDigest,
    taskRevisionSha256: record.taskRevisionSha256,
  });
}

function readRegistryTaskLifecycleReceipt(
  value: unknown,
  operation: string
): RegistryTaskLifecycleReceipt {
  const record = readExactRecord(
    value,
    [
      'schemaVersion',
      'kind',
      'batchId',
      'project',
      'repo',
      'ref',
      'expectedParent',
      'commit',
      'observedCommit',
      'requestId',
      'payloadDigest',
      'operations',
    ],
    operation
  );
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const digest = /^[0-9a-f]{64}$/u;
  const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
  if (
    record.schemaVersion !== 'omp-spec-kit/task-lifecycle-receipt@1' ||
    record.kind !== 'TASK_LIFECYCLE_FINALIZATION_RECEIPT' ||
    typeof record.batchId !== 'string' ||
    !uuid.test(record.batchId) ||
    typeof record.project !== 'string' ||
    !record.project ||
    record.project.trim() !== record.project ||
    typeof record.repo !== 'string' ||
    !record.repo ||
    record.repo.trim() !== record.repo ||
    typeof record.ref !== 'string' ||
    !record.ref ||
    record.ref.trim() !== record.ref ||
    typeof record.expectedParent !== 'string' ||
    !oid.test(record.expectedParent) ||
    typeof record.commit !== 'string' ||
    !oid.test(record.commit) ||
    record.expectedParent.length !== record.commit.length ||
    record.expectedParent === record.commit ||
    typeof record.observedCommit !== 'string' ||
    record.observedCommit !== record.commit ||
    typeof record.requestId !== 'string' ||
    !uuid.test(record.requestId) ||
    typeof record.payloadDigest !== 'string' ||
    !digest.test(record.payloadDigest) ||
    !Array.isArray(record.operations) ||
    Object.getPrototypeOf(record.operations) !== Array.prototype ||
    record.operations.length === 0 ||
    Reflect.ownKeys(record.operations).length !== record.operations.length + 1
  ) {
    throw new RegistryTaskProtocolError(
      operation,
      'spec_patch returned an invalid task lifecycle receipt'
    );
  }
  const operations = record.operations.map((entry, sequence) => {
    const operationRecord = readExactRecord(
      entry,
      [
        'sequence',
        'operationId',
        'kind',
        'commit',
        'digest',
        'outcome',
        'project',
        'spec',
        'taskId',
        'teamId',
        'generationId',
        'policyDigest',
        'creationTokenDigest',
        'operation',
      ],
      operation
    );
    if (
      operationRecord.sequence !== sequence ||
      typeof operationRecord.operationId !== 'string' ||
      !uuid.test(operationRecord.operationId) ||
      (operationRecord.kind !== 'GENESIS' && operationRecord.kind !== 'TOMBSTONE') ||
      operationRecord.commit !== record.commit ||
      typeof operationRecord.digest !== 'string' ||
      !digest.test(operationRecord.digest) ||
      operationRecord.outcome !== 'FINALIZED' ||
      operationRecord.project !== record.project ||
      typeof operationRecord.spec !== 'string' ||
      !operationRecord.spec ||
      operationRecord.spec.trim() !== operationRecord.spec ||
      typeof operationRecord.taskId !== 'string' ||
      !/^TASK-[1-9][0-9]*$/u.test(operationRecord.taskId) ||
      typeof operationRecord.teamId !== 'string' ||
      !operationRecord.teamId ||
      operationRecord.teamId.trim() !== operationRecord.teamId ||
      typeof operationRecord.generationId !== 'string' ||
      !uuid.test(operationRecord.generationId) ||
      (operationRecord.policyDigest !== null &&
        (typeof operationRecord.policyDigest !== 'string' ||
          !digest.test(operationRecord.policyDigest))) ||
      (operationRecord.creationTokenDigest !== null &&
        (typeof operationRecord.creationTokenDigest !== 'string' ||
          !digest.test(operationRecord.creationTokenDigest)))
    ) {
      throw new RegistryTaskProtocolError(
        operation,
        'spec_patch returned an invalid lifecycle operation'
      );
    }
    const batchOperation = readLifecycleBatchOperation(operationRecord.operation, operation);
    const computedDigest = taskLifecycleOperationCompletionDigest(
      record.batchId as string,
      record.commit as string,
      batchOperation
    );
    const expectedPolicyDigest =
      batchOperation.kind === 'GENESIS' ? batchOperation.policyDigest : null;
    const expectedCreationTokenDigest =
      batchOperation.kind === 'GENESIS' ? batchOperation.creationTokenDigest : null;
    if (
      batchOperation.sequence !== sequence ||
      batchOperation.operationId !== operationRecord.operationId ||
      batchOperation.kind !== operationRecord.kind ||
      batchOperation.project !== operationRecord.project ||
      batchOperation.spec !== operationRecord.spec ||
      batchOperation.taskId !== operationRecord.taskId ||
      batchOperation.teamId !== operationRecord.teamId ||
      batchOperation.generationId !== operationRecord.generationId ||
      operationRecord.policyDigest !== expectedPolicyDigest ||
      operationRecord.creationTokenDigest !== expectedCreationTokenDigest ||
      operationRecord.digest !== computedDigest
    ) {
      throw new RegistryTaskProtocolError(
        operation,
        'spec_patch returned a mismatched lifecycle operation digest or projection'
      );
    }
    return Object.freeze({
      sequence,
      operationId: operationRecord.operationId,
      kind: batchOperation.kind,
      commit: operationRecord.commit as string,
      digest: operationRecord.digest,
      outcome: 'FINALIZED' as const,
      project: operationRecord.project as string,
      spec: operationRecord.spec as string,
      taskId: operationRecord.taskId as string,
      teamId: operationRecord.teamId as string,
      generationId: operationRecord.generationId as string,
      policyDigest: expectedPolicyDigest,
      creationTokenDigest: expectedCreationTokenDigest,
      operation: batchOperation,
    });
  });
  return Object.freeze({
    schemaVersion: 'omp-spec-kit/task-lifecycle-receipt@1',
    kind: 'TASK_LIFECYCLE_FINALIZATION_RECEIPT',
    batchId: record.batchId,
    project: record.project,
    repo: record.repo,
    ref: record.ref,
    expectedParent: record.expectedParent,
    commit: record.commit,
    observedCommit: record.observedCommit,
    requestId: record.requestId,
    payloadDigest: record.payloadDigest,
    operations: Object.freeze(operations),
  });
}

function assertGenesisLifecycleReceipt(
  receipt: RegistryTaskLifecycleReceipt,
  payload: readonly (string | number | null)[]
): void {
  const genesis = receipt.operations[0];
  const canonicalOperation = genesis?.operation;
  if (
    receipt.batchId !== payload[14] ||
    receipt.project !== payload[6] ||
    receipt.repo !== payload[10] ||
    receipt.ref !== payload[11] ||
    receipt.expectedParent !== payload[12] ||
    receipt.commit !== payload[13] ||
    receipt.observedCommit !== payload[13] ||
    receipt.requestId !== payload[17] ||
    receipt.payloadDigest !== payload[18] ||
    receipt.operations.length !== 1 ||
    !genesis ||
    !canonicalOperation ||
    canonicalOperation.kind !== 'GENESIS' ||
    genesis.sequence !== 0 ||
    genesis.operationId !== payload[15] ||
    genesis.kind !== 'GENESIS' ||
    genesis.commit !== payload[13] ||
    genesis.outcome !== 'FINALIZED' ||
    genesis.project !== payload[6] ||
    genesis.spec !== payload[7] ||
    genesis.taskId !== payload[8] ||
    genesis.teamId !== payload[4] ||
    genesis.generationId !== payload[9] ||
    genesis.policyDigest !== payload[21] ||
    genesis.creationTokenDigest !== payload[19] ||
    canonicalOperation.sequence !== 0 ||
    canonicalOperation.operationId !== payload[15] ||
    canonicalOperation.ownerPrincipal !== payload[5] ||
    canonicalOperation.project !== payload[6] ||
    canonicalOperation.spec !== payload[7] ||
    canonicalOperation.taskId !== payload[8] ||
    canonicalOperation.teamId !== payload[4] ||
    canonicalOperation.generationId !== payload[9] ||
    canonicalOperation.reservationId !== payload[16] ||
    canonicalOperation.creationTokenDigest !== payload[19] ||
    canonicalOperation.taskRevisionSha256 !== payload[20] ||
    canonicalOperation.policyDigest !== payload[21] ||
    taskPolicyDigest(canonicalOperation.policy) !== payload[21] ||
    canonicalOperation.genesisOrigin !== 'SIGNED_GENESIS' ||
    canonicalOperation.genesisKeyId !== payload[22] ||
    canonicalOperation.genesisNonce !== payload[23] ||
    canonicalOperation.genesisExpiresAt !== payload[24]
  ) {
    throw new RegistryTaskProtocolError(
      'upsertTask',
      'Registry lifecycle receipt does not bind the signed initial task policy'
    );
  }
}

function assertRequiredTaskPolicy(value: unknown): TaskPolicy {
  if (
    !isRecord(value) ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw invalidArgument('upsertTask', 'initial task policy must be a plain object');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => key !== 'required' && key !== 'expectedFilename') ||
    !Object.hasOwn(value, 'required')
  ) {
    throw invalidArgument('upsertTask', 'initial task policy contains unsupported fields');
  }
  const required = Object.getOwnPropertyDescriptor(value, 'required');
  const expectedFilename = Object.getOwnPropertyDescriptor(value, 'expectedFilename');
  if (
    !required ||
    !required.enumerable ||
    !('value' in required) ||
    required.value !== true ||
    (expectedFilename !== undefined &&
      (!expectedFilename.enumerable ||
        !('value' in expectedFilename) ||
        (expectedFilename.value !== null && typeof expectedFilename.value !== 'string')))
  ) {
    throw invalidArgument('upsertTask', 'initial task policy is invalid');
  }
  const policy: TaskPolicy =
    expectedFilename === undefined
      ? { required: true }
      : { required: true, expectedFilename: expectedFilename.value as string | null };
  try {
    taskPolicyDigest(policy);
  } catch {
    throw invalidArgument('upsertTask', 'initial task policy is invalid');
  }
  return Object.freeze(policy);
}

function assertUuid(value: unknown, operation: string, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  ) {
    throw invalidArgument(operation, `${field} must be a lowercase UUID`);
  }
  return value;
}

function assertOpaqueToken(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw invalidArgument(operation, `${field} must be a non-empty opaque string`);
  }
  return value;
}

function digestCreationTokenSafely(value: string, operation: string): string {
  try {
    return digestTaskCreationToken(value);
  } catch {
    throw invalidArgument(operation, 'creationToken is not a valid UTF-8 scalar string');
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
    ...('body' in rawTask ? { body: rawTask.body as string } : {}),
  };
}

function readRegistryTaskEntity(rawEntity: Record<string, unknown>): RegistryTaskEntity {
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

function readTaskSource(
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

function nullableStringField(
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

function nullableNumberField(
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

function readExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  operation: string
): Record<string, unknown> {
  if (
    !isRecord(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new RegistryTaskProtocolError(operation, 'registry returned an invalid payload object');
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== requiredKeys.length ||
    keys.some((key) => typeof key !== 'string' || !requiredKeys.includes(key))
  ) {
    throw new RegistryTaskProtocolError(operation, 'registry returned unexpected payload fields');
  }
  const result: Record<string, unknown> = Object.create(null);
  for (const key of requiredKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) {
      throw new RegistryTaskProtocolError(operation, 'registry returned an invalid payload field');
    }
    result[key] = descriptor.value;
  }
  return result;
}

function assertRegistrationIdentity(
  value: RegistryRegistrationIdentity,
  operation: string
): RegistryRegistrationIdentity {
  const record = readExactRecord(value, ['securityStoreId', 'idp', 'userId'], operation);
  if (
    typeof record.securityStoreId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      record.securityStoreId
    ) ||
    typeof record.idp !== 'string' ||
    !record.idp.trim() ||
    record.idp !== record.idp.trim() ||
    typeof record.userId !== 'string' ||
    !record.userId.trim() ||
    record.userId !== record.userId.trim()
  ) {
    throw invalidArgument(operation, 'expected registration identity is invalid');
  }
  return Object.freeze({
    securityStoreId: record.securityStoreId,
    idp: record.idp,
    userId: record.userId,
  });
}

function assertCanonicalTaskId(value: unknown, operation: string): string {
  const taskId = assertNonEmptyString(value, operation, 'taskId');
  if (!/^TASK-[1-9][0-9]*$/u.test(taskId)) {
    throw invalidArgument(operation, 'taskId must be a canonical TASK-N identifier');
  }
  return taskId;
}

function assertDigest(value: unknown, operation: string, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw invalidArgument(operation, `${field} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function assertArtifactSize(value: unknown, operation: string): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) > 20 * 1024 * 1024
  ) {
    throw invalidArgument(operation, 'artifactSize is outside the 20 MiB limit');
  }
  return value as number;
}

function isScalarString(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  );
}

function readTaskAttestationPayload(
  value: unknown,
  operation: string
): readonly (string | number | null)[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== 20
  ) {
    throw new RegistryTaskProtocolError(
      operation,
      'registry returned an invalid challenge payload'
    );
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 21 || keys.some((key) => typeof key !== 'string')) {
    throw new RegistryTaskProtocolError(operation, 'registry returned unexpected challenge fields');
  }
  const payload: (string | number | null)[] = [];
  for (let index = 0; index < 20; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      throw new RegistryTaskProtocolError(
        operation,
        'registry returned an invalid challenge value'
      );
    }
    payload.push(descriptor.value as string | number | null);
  }
  if (
    payload[0] !== 'omp-spec-kit/task-attestation@1' ||
    !isScalarString(payload[1]) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(payload[1]) ||
    !payload.slice(2, 9).every(isScalarString) ||
    !/^TASK-[1-9][0-9]*$/u.test(payload[7] as string) ||
    !/^[a-f0-9]{64}$/u.test(payload[9] as string) ||
    typeof payload[10] !== 'string' ||
    !REGISTRY_TASK_STATUSES.includes(payload[10] as RegistryTaskStatus) ||
    payload[11] !== 'done' ||
    !Number.isSafeInteger(payload[12]) ||
    (payload[12] as number) < 1 ||
    !/^[a-f0-9]{64}$/u.test(payload[13] as string) ||
    !/^[a-f0-9]{64}$/u.test(payload[14] as string) ||
    !Number.isSafeInteger(payload[15]) ||
    (payload[15] as number) < 0 ||
    (payload[15] as number) > 20 * 1024 * 1024 ||
    !/^[a-f0-9]{64}$/u.test(payload[16] as string) ||
    !Number.isSafeInteger(payload[17]) ||
    (payload[17] as number) < 1 ||
    !/^[a-f0-9]{64}$/u.test(payload[18] as string) ||
    !isScalarString(payload[19])
  ) {
    throw new RegistryTaskProtocolError(operation, 'registry returned an invalid task attestation');
  }
  return Object.freeze(payload);
}

function readSignedTaskPayload(value: SignedTaskPayload, operation: string): SignedTaskPayload {
  const record = readExactRecord(value, ['payload', 'signature'], operation);
  const payload = readTaskAttestationPayload(record.payload, operation);
  const signature = record.signature;
  if (
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(signature) ||
    Buffer.from(signature, 'base64url').length !== 64 ||
    Buffer.from(signature, 'base64url').toString('base64url') !== signature
  ) {
    throw new RegistryTaskProtocolError(operation, 'signed task payload has an invalid signature');
  }
  return Object.freeze({ payload, signature });
}

function readTaskPolicy(value: unknown, operation: string): TaskPolicy {
  const record = readAllowedRecord(value, ['required'], ['expectedFilename'], operation);
  const required = record.required;
  const expectedFilename = Object.hasOwn(record, 'expectedFilename')
    ? record.expectedFilename
    : null;
  if (
    typeof required !== 'boolean' ||
    (expectedFilename !== null &&
      (typeof expectedFilename !== 'string' || expectedFilename.length === 0))
  ) {
    throw invalidArgument(operation, 'task policy is invalid');
  }
  const policy: TaskPolicy = Object.freeze({
    required,
    expectedFilename: expectedFilename as string | null,
  });
  try {
    taskPolicyDigest(policy);
  } catch {
    throw invalidArgument(operation, 'task policy is invalid');
  }
  return policy;
}

function readTaskPolicyChangePayload(
  value: unknown,
  operation: string
): readonly (string | number | null)[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== 18 ||
    Reflect.ownKeys(value).length !== 19
  ) {
    throw new RegistryTaskProtocolError(operation, 'registry returned an invalid policy challenge');
  }
  const payload: (string | number | null)[] = [];
  for (let index = 0; index < 18; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) {
      throw new RegistryTaskProtocolError(
        operation,
        'registry returned an unsafe policy challenge'
      );
    }
    payload.push(descriptor.value as string | number | null);
  }
  if (
    payload[0] !== 'omp-spec-kit/task-policy-change@1' ||
    !isScalarString(payload[1]) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(payload[1]) ||
    !payload.slice(2, 10).every(isScalarString) ||
    !/^TASK-[1-9][0-9]*$/u.test(payload[7] as string) ||
    !/^[a-f0-9]{64}$/u.test(payload[9] as string) ||
    !Number.isSafeInteger(payload[10]) ||
    (payload[10] as number) < 0 ||
    (payload[10] === 0
      ? payload[11] !== null
      : typeof payload[11] !== 'string' || !/^[a-f0-9]{64}$/u.test(payload[11])) ||
    !Number.isSafeInteger(payload[12]) ||
    payload[12] !== (payload[10] as number) + 1 ||
    !/^[a-f0-9]{64}$/u.test(payload[13] as string) ||
    !/^[a-f0-9]{64}$/u.test(payload[14] as string) ||
    !Number.isSafeInteger(payload[15]) ||
    (payload[15] as number) < 1 ||
    !/^[a-f0-9]{64}$/u.test(payload[16] as string) ||
    !isScalarString(payload[17])
  ) {
    throw new RegistryTaskProtocolError(
      operation,
      'registry returned an invalid policy change tuple'
    );
  }
  return Object.freeze(payload);
}

function readTaskIdentityFields(record: Record<string, unknown>, operation: string): TaskIdentity {
  const values = [
    record.registry,
    record.idp,
    record.userId,
    record.teamId,
    record.project,
    record.spec,
    record.taskId,
    record.generation,
    record.revision,
  ];
  if (
    !values.every(isScalarString) ||
    !/^TASK-[1-9][0-9]*$/u.test(record.taskId as string) ||
    !/^[a-f0-9]{64}$/u.test(record.revision as string)
  ) {
    throw new RegistryTaskProtocolError(operation, 'persisted task identity is invalid');
  }
  return Object.freeze({
    registry: record.registry as string,
    idp: record.idp as string,
    userId: record.userId as string,
    teamId: record.teamId as string,
    project: record.project as string,
    spec: record.spec as string,
    taskId: record.taskId as string,
    generation: record.generation as string,
    revision: record.revision as string,
  });
}

function readTaskIdentityRecord(value: unknown, operation: string): TaskIdentity {
  return readTaskIdentityFields(
    readExactRecord(
      value,
      [
        'registry',
        'idp',
        'userId',
        'teamId',
        'project',
        'spec',
        'taskId',
        'generation',
        'revision',
      ],
      operation
    ),
    operation
  );
}

function sameTaskIdentity(left: TaskIdentity, right: TaskIdentity): boolean {
  return (
    left.registry === right.registry &&
    left.idp === right.idp &&
    left.userId === right.userId &&
    left.teamId === right.teamId &&
    left.project === right.project &&
    left.spec === right.spec &&
    left.taskId === right.taskId &&
    left.generation === right.generation &&
    left.revision === right.revision
  );
}

function readVerifiedTaskProofRecord(value: unknown, operation: string): VerifiedTaskProof {
  const record = readExactRecord(
    value,
    [
      'registry',
      'idp',
      'userId',
      'teamId',
      'project',
      'spec',
      'taskId',
      'generation',
      'revision',
      'fromStatus',
      'toStatus',
      'policyVersion',
      'policyDigest',
      'artifactDigest',
      'artifactSize',
    ],
    operation
  );
  const identity = readTaskIdentityFields(record, operation);
  if (
    typeof record.fromStatus !== 'string' ||
    !REGISTRY_TASK_STATUSES.includes(record.fromStatus as RegistryTaskStatus) ||
    record.toStatus !== 'done' ||
    !Number.isSafeInteger(record.policyVersion) ||
    (record.policyVersion as number) < 1 ||
    typeof record.policyDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.policyDigest) ||
    typeof record.artifactDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.artifactDigest) ||
    !Number.isSafeInteger(record.artifactSize) ||
    (record.artifactSize as number) < 0 ||
    (record.artifactSize as number) > 20 * 1024 * 1024
  ) {
    throw new RegistryTaskProtocolError(operation, 'persisted completion proof is invalid');
  }
  return Object.freeze({
    ...identity,
    fromStatus: record.fromStatus,
    toStatus: 'done',
    policyVersion: record.policyVersion as number,
    policyDigest: record.policyDigest,
    artifactDigest: record.artifactDigest,
    artifactSize: record.artifactSize as number,
  });
}

function sameVerifiedTaskProof(left: VerifiedTaskProof, right: VerifiedTaskProof): boolean {
  return (
    sameTaskIdentity(left, right) &&
    left.fromStatus === right.fromStatus &&
    left.toStatus === right.toStatus &&
    left.policyVersion === right.policyVersion &&
    left.policyDigest === right.policyDigest &&
    left.artifactDigest === right.artifactDigest &&
    left.artifactSize === right.artifactSize
  );
}

function readPolicyChangeProofRecord(
  value: unknown,
  operation: string
): PolicyChangeProof & { requestId: string } {
  const record = readExactRecord(
    value,
    [
      'registry',
      'idp',
      'userId',
      'teamId',
      'project',
      'spec',
      'taskId',
      'generation',
      'revision',
      'previousVersion',
      'previousDigest',
      'nextVersion',
      'policy',
      'requestId',
    ],
    operation
  );
  const identity = readTaskIdentityFields(record, operation);
  const policy = readTaskPolicy(record.policy, operation);
  if (
    !Number.isSafeInteger(record.previousVersion) ||
    (record.previousVersion as number) < 0 ||
    (record.previousVersion === 0
      ? record.previousDigest !== null
      : typeof record.previousDigest !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(record.previousDigest)) ||
    !Number.isSafeInteger(record.nextVersion) ||
    record.nextVersion !== (record.previousVersion as number) + 1 ||
    !isScalarString(record.requestId)
  ) {
    throw new RegistryTaskProtocolError(operation, 'persisted policy change proof is invalid');
  }
  return Object.freeze({
    ...identity,
    previousVersion: record.previousVersion as number,
    previousDigest: record.previousDigest as string | null,
    nextVersion: record.nextVersion as number,
    policy,
    requestId: record.requestId,
  });
}

function samePolicyChangeProof(
  left: PolicyChangeProof & { requestId: string },
  right: PolicyChangeProof & { requestId: string }
): boolean {
  return (
    sameTaskIdentity(left, right) &&
    left.previousVersion === right.previousVersion &&
    left.previousDigest === right.previousDigest &&
    left.nextVersion === right.nextVersion &&
    JSON.stringify(left.policy) === JSON.stringify(right.policy) &&
    left.requestId === right.requestId
  );
}

function readPolicyChangeProof(
  payload: readonly (string | number | null)[],
  expectedIdentity: RegistryRegistrationIdentity,
  scope: RegistryTaskScope & { teamId: string; taskId: string },
  requestId: string,
  policy: TaskPolicy,
  keyId: string,
  operation: string
): {
  callerIdentity: TaskIdentity;
  proof: PolicyChangeProof & { requestId: string };
} {
  if (
    payload[1] !== expectedIdentity.securityStoreId ||
    payload[2] !== expectedIdentity.idp ||
    payload[3] !== expectedIdentity.userId ||
    payload[4] !== scope.teamId ||
    payload[5] !== scope.project ||
    payload[6] !== scope.spec ||
    payload[7] !== scope.taskId ||
    payload[13] !== taskPolicyDigest(policy) ||
    payload[16] !== keyId ||
    payload[17] !== requestId
  ) {
    throw new RegistryTaskProtocolError(
      operation,
      'registry returned a policy challenge outside the authenticated task scope'
    );
  }
  const callerIdentity = Object.freeze({
    registry: payload[1] as string,
    idp: payload[2] as string,
    userId: payload[3] as string,
    teamId: payload[4] as string,
    project: payload[5] as string,
    spec: payload[6] as string,
    taskId: payload[7] as string,
    generation: payload[8] as string,
    revision: payload[9] as string,
  });
  const proof: PolicyChangeProof & { requestId: string } = Object.freeze({
    ...callerIdentity,
    previousVersion: payload[10] as number,
    previousDigest: payload[11] as string | null,
    nextVersion: payload[12] as number,
    policy,
    requestId,
  });
  return { callerIdentity, proof };
}

function readPolicyChangeChallenge(
  value: unknown,
  expectedRegistrationIdentity: RegistryRegistrationIdentity,
  operation: string
): RegistryTaskPolicyChangeChallenge {
  const record = readExactRecord(
    value,
    [
      'project',
      'spec',
      'requestId',
      'teamId',
      'taskId',
      'expectedRegistrationIdentity',
      'policy',
      'payload',
      'callerIdentity',
      'proof',
    ],
    operation
  );
  const scope = {
    project: assertNonEmptyString(record.project, operation, 'project'),
    spec: assertNonEmptyString(record.spec, operation, 'spec'),
  };
  const requestId = assertNonEmptyString(record.requestId, operation, 'requestId');
  const teamId = assertNonEmptyString(record.teamId, operation, 'teamId');
  const taskId = assertCanonicalTaskId(record.taskId, operation);
  const expectedIdentity = assertRegistrationIdentity(
    record.expectedRegistrationIdentity as RegistryRegistrationIdentity,
    operation
  );
  const callerExpected = assertRegistrationIdentity(expectedRegistrationIdentity, operation);
  if (
    expectedIdentity.securityStoreId !== callerExpected.securityStoreId ||
    expectedIdentity.idp !== callerExpected.idp ||
    expectedIdentity.userId !== callerExpected.userId
  ) {
    throw invalidArgument(
      operation,
      'challenge registration identity differs from caller identity'
    );
  }
  const policy = readTaskPolicy(record.policy, operation);
  const payload = readTaskPolicyChangePayload(record.payload, operation);
  const { callerIdentity, proof } = readPolicyChangeProof(
    payload,
    expectedIdentity,
    { ...scope, teamId, taskId },
    requestId,
    policy,
    payload[16] as string,
    operation
  );
  const persistedIdentity = readTaskIdentityRecord(record.callerIdentity, operation);
  const persistedProof = readPolicyChangeProofRecord(record.proof, operation);
  if (
    !sameTaskIdentity(persistedIdentity, callerIdentity) ||
    !samePolicyChangeProof(persistedProof, proof)
  ) {
    throw invalidArgument(operation, 'challenge proof differs from its signed payload');
  }
  return Object.freeze({
    ...scope,
    requestId,
    teamId,
    taskId,
    expectedRegistrationIdentity: expectedIdentity,
    policy,
    payload,
    callerIdentity,
    proof,
  });
}

function readCompletionProof(
  payload: readonly (string | number | null)[],
  expectedIdentity: RegistryRegistrationIdentity,
  scope: RegistryTaskScope,
  teamId: string,
  taskId: string,
  requestId: string,
  operation: string
): { callerIdentity: TaskIdentity; proof: VerifiedTaskProof } {
  if (
    payload[1] !== expectedIdentity.securityStoreId ||
    payload[2] !== expectedIdentity.idp ||
    payload[3] !== expectedIdentity.userId ||
    payload[4] !== teamId ||
    payload[5] !== scope.project ||
    payload[6] !== scope.spec ||
    payload[7] !== taskId ||
    payload[11] !== 'done' ||
    payload[19] !== requestId
  ) {
    throw new RegistryTaskProtocolError(
      operation,
      'registry returned a completion challenge outside the authenticated task scope'
    );
  }
  const callerIdentity = Object.freeze({
    registry: payload[1] as string,
    idp: payload[2] as string,
    userId: payload[3] as string,
    teamId: payload[4] as string,
    project: payload[5] as string,
    spec: payload[6] as string,
    taskId: payload[7] as string,
    generation: payload[8] as string,
    revision: payload[9] as string,
  });
  const proof: VerifiedTaskProof = Object.freeze({
    ...callerIdentity,
    fromStatus: payload[10] as string,
    toStatus: 'done',
    policyVersion: payload[12] as number,
    policyDigest: payload[13] as string,
    artifactDigest: payload[14] as string,
    artifactSize: payload[15] as number,
  });
  return { callerIdentity, proof };
}

function readCompletionChallenge(
  value: unknown,
  expectedRegistrationIdentity: RegistryRegistrationIdentity,
  operation: string
): RegistryTaskCompletionChallenge {
  const record = readExactRecord(
    value,
    [
      'project',
      'spec',
      'requestId',
      'teamId',
      'taskId',
      'expectedRegistrationIdentity',
      'payload',
      'callerIdentity',
      'proof',
    ],
    operation
  );
  const scope = {
    project: assertNonEmptyString(record.project, operation, 'project'),
    spec: assertNonEmptyString(record.spec, operation, 'spec'),
  };
  const requestId = assertNonEmptyString(record.requestId, operation, 'requestId');
  const teamId = assertNonEmptyString(record.teamId, operation, 'teamId');
  const taskId = assertCanonicalTaskId(record.taskId, operation);
  const expectedIdentity = assertRegistrationIdentity(
    record.expectedRegistrationIdentity as RegistryRegistrationIdentity,
    operation
  );
  const callerExpected = assertRegistrationIdentity(expectedRegistrationIdentity, operation);
  if (
    expectedIdentity.securityStoreId !== callerExpected.securityStoreId ||
    expectedIdentity.idp !== callerExpected.idp ||
    expectedIdentity.userId !== callerExpected.userId
  ) {
    throw invalidArgument(
      operation,
      'challenge registration identity differs from caller identity'
    );
  }
  const payload = readTaskAttestationPayload(record.payload, operation);
  const { callerIdentity, proof } = readCompletionProof(
    payload,
    expectedIdentity,
    scope,
    teamId,
    taskId,
    requestId,
    operation
  );
  const persistedIdentity = readTaskIdentityRecord(record.callerIdentity, operation);
  const persistedProof = readVerifiedTaskProofRecord(record.proof, operation);
  if (
    !sameTaskIdentity(persistedIdentity, callerIdentity) ||
    !sameVerifiedTaskProof(persistedProof, proof)
  ) {
    throw invalidArgument(operation, 'challenge proof differs from its signed payload');
  }
  return Object.freeze({
    ...scope,
    requestId,
    teamId,
    taskId,
    expectedRegistrationIdentity: expectedIdentity,
    payload,
    callerIdentity,
    proof,
  });
}

function createRegistryTaskCompletionReplayRecord(
  rawChallenge: RegistryTaskCompletionChallenge,
  rawSigned: SignedTaskPayload,
  rawExpectedIdentity: RegistryRegistrationIdentity
): RegistryTaskCompletionReplayRecord {
  const operation = 'taskComplete';
  const expectedRegistrationIdentity = assertRegistrationIdentity(rawExpectedIdentity, operation);
  const challenge = readCompletionChallenge(rawChallenge, expectedRegistrationIdentity, operation);
  const signed = readSignedTaskPayload(rawSigned, operation);
  if (JSON.stringify(signed.payload) !== JSON.stringify(challenge.payload)) {
    throw invalidArgument(operation, 'signed completion payload differs from its challenge');
  }
  const requestArguments = freezeJsonRecord(
    {
      action: 'task_complete',
      project: challenge.project,
      requestId: challenge.requestId,
      teamId: challenge.teamId,
      spec: challenge.spec,
      taskId: challenge.taskId,
      payload: [...challenge.payload],
      signature: signed.signature,
    },
    operation
  );
  return Object.freeze({
    requestId: challenge.requestId,
    project: challenge.project,
    spec: challenge.spec,
    teamId: challenge.teamId,
    taskId: challenge.taskId,
    expectedRegistrationIdentity,
    challengePayload: challenge.payload,
    callerIdentity: challenge.callerIdentity,
    proof: challenge.proof,
    signed,
    requestArguments,
  });
}

function readRegistryTaskCompletionReplayRecord(
  value: unknown,
  rawExpectedIdentity: RegistryRegistrationIdentity
): RegistryTaskCompletionReplayRecord {
  const operation = 'taskComplete';
  const record = readExactRecord(
    value,
    [
      'requestId',
      'project',
      'spec',
      'teamId',
      'taskId',
      'expectedRegistrationIdentity',
      'challengePayload',
      'callerIdentity',
      'proof',
      'signed',
      'requestArguments',
    ],
    operation
  );
  const expectedRegistrationIdentity = assertRegistrationIdentity(rawExpectedIdentity, operation);
  const challenge = readCompletionChallenge(
    {
      project: record.project,
      spec: record.spec,
      requestId: record.requestId,
      teamId: record.teamId,
      taskId: record.taskId,
      expectedRegistrationIdentity: record.expectedRegistrationIdentity,
      payload: record.challengePayload,
      callerIdentity: record.callerIdentity,
      proof: record.proof,
    },
    expectedRegistrationIdentity,
    operation
  );
  const signed = readSignedTaskPayload(record.signed as SignedTaskPayload, operation);
  if (JSON.stringify(signed.payload) !== JSON.stringify(challenge.payload)) {
    throw invalidArgument(operation, 'persisted completion signature differs from its challenge');
  }
  const actualArgs = readExactRecord(
    record.requestArguments,
    ['action', 'project', 'requestId', 'teamId', 'spec', 'taskId', 'payload', 'signature'],
    operation
  );
  const argsPayload = readTaskAttestationPayload(actualArgs.payload, operation);
  if (
    actualArgs.action !== 'task_complete' ||
    actualArgs.project !== challenge.project ||
    actualArgs.requestId !== challenge.requestId ||
    actualArgs.teamId !== challenge.teamId ||
    actualArgs.spec !== challenge.spec ||
    actualArgs.taskId !== challenge.taskId ||
    actualArgs.signature !== signed.signature ||
    JSON.stringify(argsPayload) !== JSON.stringify(challenge.payload)
  ) {
    throw invalidArgument(
      operation,
      'persisted completion request arguments do not match the proof'
    );
  }
  const requestArguments = freezeJsonRecord(
    {
      action: 'task_complete',
      project: challenge.project,
      requestId: challenge.requestId,
      teamId: challenge.teamId,
      spec: challenge.spec,
      taskId: challenge.taskId,
      payload: [...challenge.payload],
      signature: signed.signature,
    },
    operation
  );
  return Object.freeze({
    requestId: challenge.requestId,
    project: challenge.project,
    spec: challenge.spec,
    teamId: challenge.teamId,
    taskId: challenge.taskId,
    expectedRegistrationIdentity: challenge.expectedRegistrationIdentity,
    challengePayload: challenge.payload,
    callerIdentity: challenge.callerIdentity,
    proof: challenge.proof,
    signed,
    requestArguments,
  });
}

function readSignedPolicyChangePayload(
  value: SignedTaskPayload,
  operation: string
): SignedTaskPayload {
  const record = readExactRecord(value, ['payload', 'signature'], operation);
  const payload = readTaskPolicyChangePayload(record.payload, operation);
  const signature = record.signature;
  if (
    typeof signature !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(signature) ||
    Buffer.from(signature, 'base64url').length !== 64 ||
    Buffer.from(signature, 'base64url').toString('base64url') !== signature
  ) {
    throw new RegistryTaskProtocolError(
      operation,
      'signed policy payload has an invalid signature'
    );
  }
  return Object.freeze({ payload, signature });
}

function createRegistryTaskPolicyChangeReplayRecord(
  rawChallenge: RegistryTaskPolicyChangeChallenge,
  rawSigned: SignedTaskPayload,
  rawExpectedIdentity: RegistryRegistrationIdentity
): RegistryTaskPolicyChangeReplayRecord {
  const operation = 'taskPolicyChange';
  const expectedRegistrationIdentity = assertRegistrationIdentity(rawExpectedIdentity, operation);
  const challenge = readPolicyChangeChallenge(
    rawChallenge,
    expectedRegistrationIdentity,
    operation
  );
  const signed = readSignedPolicyChangePayload(rawSigned, operation);
  if (JSON.stringify(signed.payload) !== JSON.stringify(challenge.payload)) {
    throw invalidArgument(operation, 'signed policy payload differs from its challenge');
  }
  const requestArguments = freezeJsonRecord(
    {
      action: 'task_policy',
      project: challenge.project,
      requestId: challenge.requestId,
      teamId: challenge.teamId,
      spec: challenge.spec,
      taskId: challenge.taskId,
      policy: challenge.policy,
      payload: [...challenge.payload],
      signature: signed.signature,
    },
    operation
  );
  return Object.freeze({
    requestId: challenge.requestId,
    project: challenge.project,
    spec: challenge.spec,
    teamId: challenge.teamId,
    taskId: challenge.taskId,
    expectedRegistrationIdentity,
    policy: challenge.policy,
    challengePayload: challenge.payload,
    callerIdentity: challenge.callerIdentity,
    proof: challenge.proof,
    signed,
    requestArguments,
  });
}

function readRegistryTaskPolicyChangeReplayRecord(
  value: unknown,
  rawExpectedIdentity: RegistryRegistrationIdentity
): RegistryTaskPolicyChangeReplayRecord {
  const operation = 'taskPolicyChange';
  const record = readExactRecord(
    value,
    [
      'requestId',
      'project',
      'spec',
      'teamId',
      'taskId',
      'expectedRegistrationIdentity',
      'policy',
      'challengePayload',
      'callerIdentity',
      'proof',
      'signed',
      'requestArguments',
    ],
    operation
  );
  const expectedRegistrationIdentity = assertRegistrationIdentity(rawExpectedIdentity, operation);
  const challenge = readPolicyChangeChallenge(
    {
      project: record.project,
      spec: record.spec,
      requestId: record.requestId,
      teamId: record.teamId,
      taskId: record.taskId,
      expectedRegistrationIdentity: record.expectedRegistrationIdentity,
      policy: record.policy,
      payload: record.challengePayload,
      callerIdentity: record.callerIdentity,
      proof: record.proof,
    },
    expectedRegistrationIdentity,
    operation
  );
  const signed = readSignedPolicyChangePayload(record.signed as SignedTaskPayload, operation);
  if (JSON.stringify(signed.payload) !== JSON.stringify(challenge.payload)) {
    throw invalidArgument(operation, 'persisted policy signature differs from its challenge');
  }
  const actualArgs = readExactRecord(
    record.requestArguments,
    [
      'action',
      'project',
      'requestId',
      'teamId',
      'spec',
      'taskId',
      'policy',
      'payload',
      'signature',
    ],
    operation
  );
  const argsPolicy = readTaskPolicy(actualArgs.policy, operation);
  const argsPayload = readTaskPolicyChangePayload(actualArgs.payload, operation);
  if (
    actualArgs.action !== 'task_policy' ||
    actualArgs.project !== challenge.project ||
    actualArgs.requestId !== challenge.requestId ||
    actualArgs.teamId !== challenge.teamId ||
    actualArgs.spec !== challenge.spec ||
    actualArgs.taskId !== challenge.taskId ||
    JSON.stringify(argsPolicy) !== JSON.stringify(challenge.policy) ||
    actualArgs.signature !== signed.signature ||
    JSON.stringify(argsPayload) !== JSON.stringify(challenge.payload)
  ) {
    throw invalidArgument(operation, 'persisted policy request arguments do not match the proof');
  }
  const requestArguments = freezeJsonRecord(
    {
      action: 'task_policy',
      project: challenge.project,
      requestId: challenge.requestId,
      teamId: challenge.teamId,
      spec: challenge.spec,
      taskId: challenge.taskId,
      policy: challenge.policy,
      payload: [...challenge.payload],
      signature: signed.signature,
    },
    operation
  );
  return Object.freeze({
    requestId: challenge.requestId,
    project: challenge.project,
    spec: challenge.spec,
    teamId: challenge.teamId,
    taskId: challenge.taskId,
    expectedRegistrationIdentity: challenge.expectedRegistrationIdentity,
    policy: challenge.policy,
    challengePayload: challenge.payload,
    callerIdentity: challenge.callerIdentity,
    proof: challenge.proof,
    signed,
    requestArguments,
  });
}

function readRegistrationIdentity(
  envelope: RegistryToolEnvelope<unknown>,
  operation: string
): RegistryRegistrationIdentity {
  const data = envelope.data;
  if (
    !isRecord(data) ||
    typeof data.securityStoreId !== 'string' ||
    !data.securityStoreId.trim() ||
    data.securityStoreId !== data.securityStoreId.trim() ||
    typeof data.idp !== 'string' ||
    !data.idp.trim() ||
    data.idp !== data.idp.trim() ||
    typeof data.userId !== 'string' ||
    !data.userId.trim() ||
    data.userId !== data.userId.trim()
  ) {
    throw new RegistryTaskProtocolError(
      operation,
      'registry returned invalid registration identity'
    );
  }
  return { securityStoreId: data.securityStoreId, idp: data.idp, userId: data.userId };
}

function readTeamSpecBindings(
  envelope: RegistryToolEnvelope<unknown>,
  operation: string
): RegistryTeamSpecBindings {
  if (!isRecord(envelope.data)) {
    throw new RegistryTaskProtocolError(operation, 'team_specs returned no bindings payload');
  }
  const teamId = stringOrNull(envelope.data.teamId)?.trim() ?? '';
  const rawBindings = envelope.data.bindings;
  if (!teamId || !Array.isArray(rawBindings)) {
    throw new RegistryTaskProtocolError(
      operation,
      'team_specs returned invalid team identity or bindings'
    );
  }
  const bindings: TeamSpecBinding[] = [];
  const seen = new Set<string>();
  for (const [index, rawBinding] of rawBindings.entries()) {
    if (!isRecord(rawBinding)) {
      throw new RegistryTaskProtocolError(operation, `binding #${index} is not an object`);
    }
    const project = stringOrNull(rawBinding.project)?.trim() ?? '';
    const spec = stringOrNull(rawBinding.spec)?.trim() ?? '';
    if (!project || !spec) {
      throw new RegistryTaskProtocolError(operation, `binding #${index} has no project/spec`);
    }
    const key = JSON.stringify([project, spec]);
    if (seen.has(key)) {
      throw new RegistryTaskProtocolError(operation, 'team_specs returned a duplicate binding');
    }
    seen.add(key);
    bindings.push({ project, spec });
  }
  return { teamId, bindings };
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
  const taskLifecycleReceipt =
    data.taskLifecycleReceipt === undefined
      ? undefined
      : readRegistryTaskLifecycleReceipt(data.taskLifecycleReceipt, operation);
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
    ...(taskLifecycleReceipt === undefined ? {} : { taskLifecycleReceipt }),
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
    ...(payload.taskLifecycleReceipt === undefined
      ? {}
      : { taskLifecycleReceipt: payload.taskLifecycleReceipt }),
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
