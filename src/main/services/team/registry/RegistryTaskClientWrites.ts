import {
  type TaskGenesisAttestationExpected,
  taskGenesisRequestDigest,
  type TaskPolicy,
  validateTaskGenesisAttestationChallenge,
} from '@main/services/identity/TaskAttestation';
import { type RegistryRegistrationIdentity } from '@shared/types';

import { isRecord, stringOrNull } from './RegistryJson';
import { RegistryMcpTransport } from './RegistryMcpTransport';
import { RegistryTaskProtocolError } from './RegistryTaskClientErrors';
import {
  readTaskGenesisChallenge,
  readTaskGenesisChallengeForExpected,
} from './RegistryTaskClientGenesis';
import {
  assertGenesisLifecycleReceipt,
  readRegistryTaskLifecycleReceipt,
} from './RegistryTaskClientLifecycle';
import {
  type RegistryPatchPayload,
  type RegistryTaskGenesisAttestation,
  type RegistryTaskGenesisChallenge,
  type RegistryTaskGenesisReplayRecord,
  type RegistryTaskRefusal,
  type RegistryTaskTransition,
  type RegistryTaskUpsertResult,
  type RegistryTaskWriteResult,
  type RegistryToolEnvelope,
} from './RegistryTaskClientTypes';
import {
  assertCanonicalTaskId,
  assertNonEmptyString,
  freezeJsonRecord,
  invalidArgument,
  REGISTRY_SCHEMA_VERSION,
} from './RegistryTaskClientValidation';

export function readPatchPayload(
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

export function readTransitions(
  rawTransitions: unknown,
  operation: string
): RegistryTaskTransition[] {
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

export function readRefusal(rawError: unknown, operation: string): RegistryTaskRefusal | null {
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

export function toWriteResult(payload: RegistryPatchPayload): RegistryTaskWriteResult {
  return {
    outcome: payload.outcome,
    transitions: payload.transitions,
    refusal: payload.refusal,
    ...(payload.taskLifecycleReceipt === undefined
      ? {}
      : { taskLifecycleReceipt: payload.taskLifecycleReceipt }),
  };
}

/** Negotiates the registry-advertised write schema; unsupported writes fail closed. */
export class RegistryTaskCapabilities {
  constructor(private readonly transport: RegistryMcpTransport) {}

  #capabilities: Record<string, unknown> | null = null;

  #patchArgumentCapabilities: Record<string, unknown> | null = null;

  #creationConfirmationSupported = false;

  async requireTaskCapability(
    field: 'description' | 'creationToken' | 'deleted' | 'clearOwner' | 'policy' | 'force',
    signal?: AbortSignal
  ): Promise<void> {
    if (!this.#capabilities) {
      const result = await this.transport.listTools(signal);
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

  async requireGenesisAttestationCapability(signal?: AbortSignal): Promise<void> {
    await this.requireTaskCapability('policy', signal);
    const schema = this.#patchArgumentCapabilities?.genesisAttestations;
    if (!isRecord(schema) || schema.type !== 'array' || !isRecord(schema.items)) {
      throw new RegistryTaskProtocolError(
        'listTools',
        'Registry does not support signed initial task policy attestations'
      );
    }
  }
}

export async function executeRegistryTaskUpsertPatch(
  transport: RegistryMcpTransport,
  input: {
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
  }
): Promise<RegistryTaskUpsertResult> {
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
      const validatedPayload = validateTaskGenesisAttestationChallenge(expected, submitted.payload);
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

  const envelope = await transport.callTool(
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
