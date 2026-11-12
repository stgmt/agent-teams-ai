import {
  taskLifecycleOperationCompletionDigest,
  type TaskPolicy,
  taskPolicyDigest,
} from '@main/services/identity/TaskAttestation';

import { isRecord } from './RegistryJson';
import { RegistryTaskProtocolError } from './RegistryTaskClientErrors';
import {
  type RegistryTaskLifecycleBatchOperation,
  type RegistryTaskLifecycleReceipt,
} from './RegistryTaskClientTypes';
import { readExactRecord } from './RegistryTaskClientValidation';

export function readLifecycleBatchOperation(
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
    genesisKeyId: record.genesisKeyId,
    genesisNonce: record.genesisNonce,
    genesisOrigin: record.genesisOrigin,
    policy: taskPolicy,
    policyDigest: record.policyDigest,
    taskRevisionSha256: record.taskRevisionSha256,
  });
}

export function readRegistryTaskLifecycleReceipt(
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
      project: operationRecord.project,
      spec: operationRecord.spec,
      taskId: operationRecord.taskId,
      teamId: operationRecord.teamId,
      generationId: operationRecord.generationId,
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

export function assertGenesisLifecycleReceipt(
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
