import {
  digestTaskCreationToken,
  type TaskGenesisAttestationExpected,
  taskGenesisRequestDigest,
  validateTaskGenesisAttestationChallenge,
} from '@main/services/identity/TaskAttestation';
import { type RegistryRegistrationIdentity } from '@shared/types';

import { RegistryTaskProtocolError } from './RegistryTaskClientErrors';
import { assertRequiredTaskPolicy } from './RegistryTaskClientPolicy';
import {
  type RegistryTaskGenesisAttestation,
  type RegistryTaskGenesisChallenge,
  type RegistryTaskUpsertResult,
  type RegistryToolEnvelope,
} from './RegistryTaskClientTypes';
import {
  assertCanonicalTaskId,
  assertNonEmptyString,
  assertOpaqueToken,
  assertRegistrationIdentity,
  assertScope,
  assertStringArray,
  assertTaskStatus,
  assertUuid,
  freezeJsonRecord,
  invalidArgument,
  readAllowedRecord,
  readExactRecord,
  REGISTRY_SCHEMA_VERSION,
  TASK_DOCUMENT,
} from './RegistryTaskClientValidation';

export function readTaskGenesisChallenge(
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

export interface RegistryTaskGenesisReplayArguments extends Record<string, unknown> {
  readonly project: string;
  readonly spec: string;
  readonly requestId: string;
  readonly operations: readonly [Readonly<Record<string, unknown>>];
}

export interface ValidatedRegistryTaskGenesisReplay {
  challenge: RegistryTaskGenesisChallenge;
  attestation: RegistryTaskGenesisAttestation;
  requestArguments: RegistryTaskGenesisReplayArguments;
  payload: readonly (string | number | null)[];
}

export function readTaskGenesisChallengeForExpected(
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

export function readRegistryTaskGenesisReplay(
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

export function readTaskGenesisReplayArguments(value: unknown): RegistryTaskGenesisReplayArguments {
  const parsed = parseTaskGenesisReplayArguments(value);
  return parseTaskGenesisReplayArguments(freezeJsonRecord(parsed, 'upsertTask'));
}

export function parseTaskGenesisReplayArguments(
  value: unknown
): RegistryTaskGenesisReplayArguments {
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

export function sameTaskGenesisAttestation(
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

export function readGenesisAttestations(
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

export function readGenesisPayload(
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
