import {
  type PolicyChangeProof,
  type SignedTaskPayload,
  type TaskIdentity,
  type TaskPolicy,
  taskPolicyDigest,
} from '@main/services/identity/TaskAttestation';
import { type RegistryRegistrationIdentity } from '@shared/types';

import { isRecord } from './RegistryJson';
import { RegistryTaskProtocolError } from './RegistryTaskClientErrors';
import {
  type RegistryTaskPolicyChangeChallenge,
  type RegistryTaskPolicyChangeReplayRecord,
  type RegistryTaskScope,
} from './RegistryTaskClientTypes';
import {
  assertCanonicalTaskId,
  assertNonEmptyString,
  assertRegistrationIdentity,
  freezeJsonRecord,
  invalidArgument,
  isScalarString,
  readAllowedRecord,
  readExactRecord,
  readTaskIdentityFields,
  readTaskIdentityRecord,
  sameTaskIdentity,
} from './RegistryTaskClientValidation';

export function assertRequiredTaskPolicy(value: unknown): TaskPolicy {
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

export function readTaskPolicy(value: unknown, operation: string): TaskPolicy {
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
    expectedFilename,
  });
  try {
    taskPolicyDigest(policy);
  } catch {
    throw invalidArgument(operation, 'task policy is invalid');
  }
  return policy;
}

export function readTaskPolicyChangePayload(
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

export function readPolicyChangeProofRecord(
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
    nextVersion: record.nextVersion,
    policy,
    requestId: record.requestId,
  });
}

export function samePolicyChangeProof(
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

export function readPolicyChangeProof(
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

export function readPolicyChangeChallenge(
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

export function readSignedPolicyChangePayload(
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

export function createRegistryTaskPolicyChangeReplayRecord(
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

export function readRegistryTaskPolicyChangeReplayRecord(
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
