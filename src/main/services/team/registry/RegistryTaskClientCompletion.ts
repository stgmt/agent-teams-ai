import {
  type SignedTaskPayload,
  type TaskIdentity,
  type VerifiedTaskProof,
} from '@main/services/identity/TaskAttestation';
import { type RegistryRegistrationIdentity } from '@shared/types';

import { RegistryTaskProtocolError } from './RegistryTaskClientErrors';
import {
  REGISTRY_TASK_STATUSES,
  type RegistryTaskCompletionChallenge,
  type RegistryTaskCompletionReplayRecord,
  type RegistryTaskScope,
  type RegistryTaskStatus,
} from './RegistryTaskClientTypes';
import {
  assertCanonicalTaskId,
  assertNonEmptyString,
  assertRegistrationIdentity,
  freezeJsonRecord,
  invalidArgument,
  isScalarString,
  readExactRecord,
  readTaskIdentityFields,
  readTaskIdentityRecord,
  sameTaskIdentity,
} from './RegistryTaskClientValidation';

export function readTaskAttestationPayload(
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

export function readSignedTaskPayload(
  value: SignedTaskPayload,
  operation: string
): SignedTaskPayload {
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

export function readVerifiedTaskProofRecord(value: unknown, operation: string): VerifiedTaskProof {
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

export function sameVerifiedTaskProof(left: VerifiedTaskProof, right: VerifiedTaskProof): boolean {
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

export function readCompletionProof(
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
    registry: payload[1],
    idp: payload[2],
    userId: payload[3],
    teamId: payload[4],
    project: payload[5],
    spec: payload[6],
    taskId: payload[7],
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

export function readCompletionChallenge(
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

export function createRegistryTaskCompletionReplayRecord(
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

export function readRegistryTaskCompletionReplayRecord(
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
