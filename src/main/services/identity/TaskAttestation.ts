import { createHash, createPublicKey, verify } from 'crypto';
import type { DesktopSigningKeyStore } from './DesktopSigningKeyStore';

// Internal protocol primitive. Callers must independently verify the local
// artifact and authenticate the challenge; neither claim is established here.
export interface TaskIdentity {
  registry: string;
  idp: string;
  userId: string;
  teamId: string;
  project: string;
  spec: string;
  taskId: string;
  generation: string;
  revision: string;
}
export interface VerifiedTaskProof extends TaskIdentity {
  fromStatus: string;
  toStatus: string;
  policyVersion: number;
  policyDigest: string;
  artifactDigest: string;
  artifactSize: number;
}
export interface TaskPolicy {
  required: boolean;
  expectedFilename?: string | null;
}
export interface PolicyChangeProof extends TaskIdentity {
  previousVersion: number;
  previousDigest: string | null;
  nextVersion: number;
  policy: TaskPolicy;
}
export interface TaskGenesisAttestationExpected {
  registryStoreId: string;
  idp: string;
  userId: string;
  teamId: string;
  project: string;
  spec: string;
  taskId: string;
  requestId: string;
  payloadDigest: string;
  creationTokenDigest: string;
  policy: TaskPolicy;
}
export interface SignedTaskPayload {
  readonly payload: readonly (string | number | null)[];
  readonly signature: string;
}
const statuses: Record<string, true> = Object.assign(Object.create(null), {
  planned: true,
  todo: true,
  ready: true,
  'in-progress': true,
  blocked: true,
  done: true,
  deferred: true,
  deleted: true,
  unknown: true,
});
const hex = /^[0-9a-f]{64}$/u;
const taskId = /^TASK-[1-9][0-9]*$/u;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const scalar = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.length > 0 &&
  v.length <= 4096 &&
  !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
function validGenesisRef(value: unknown): boolean {
  if (!scalar(value) || !value.startsWith('refs/') || value.length <= 5) return false;
  return (
    !/[\x00-\x20\x7f~^:?*\[\\]/u.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.includes('@{') &&
    !value.endsWith('/') &&
    !value.endsWith('.') &&
    value.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock'))
  );
}
const integer = (v: unknown, minimum: number): v is number =>
  Number.isSafeInteger(v) && (v as number) >= minimum;
function invalid(): never {
  throw new Error('Invalid task attestation input');
}

// Copy data properties only: holes, accessors, extra properties and custom toJSON
// must never change what is signed relative to what was validated.
function exactArray(value: unknown, length: number): (string | number | null)[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== length
  )
    invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length + 1) invalid();
  const result: (string | number | null)[] = [];
  for (let i = 0; i < length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor || !('value' in descriptor)) invalid();
    result.push(descriptor.value);
  }
  return result;
}
function digest(value: unknown): boolean {
  return typeof value === 'string' && hex.test(value);
}
function identityValues(value: TaskIdentity): unknown[] {
  return [
    value.registry,
    value.idp,
    value.userId,
    value.teamId,
    value.project,
    value.spec,
    value.taskId,
    value.generation,
    value.revision,
  ];
}
function validateIdentity(a: (string | number | null)[]): void {
  if (
    ![1, 2, 3, 4, 5, 6, 7, 8].every((i) => scalar(a[i])) ||
    !taskId.test(a[7] as string) ||
    !digest(a[9])
  )
    invalid();
}
function compare(a: (string | number | null)[], start: number, expected: unknown[]): void {
  if (expected.some((value, i) => a[start + i] !== value)) invalid();
}
function policyDigest(policy: TaskPolicy): string {
  if (
    !policy ||
    typeof policy !== 'object' ||
    Array.isArray(policy) ||
    Object.keys(policy).some((k) => k !== 'required' && k !== 'expectedFilename') ||
    !Object.prototype.hasOwnProperty.call(policy, 'required') ||
    typeof policy.required !== 'boolean'
  )
    invalid();
  const name = policy.expectedFilename ?? null;
  if (
    (!policy.required && name !== null) ||
    (name !== null &&
      (!scalar(name) ||
        name.length > 255 ||
        name.trim() !== name ||
        name === '.' ||
        name === '..' ||
        /[\\/:\x00-\x1f\x7f]/u.test(name)))
  )
    invalid();
  return createHash('sha256')
    .update(JSON.stringify(['omp-spec-kit/task-policy@1', policy.required, name]), 'utf8')
    .digest('hex');
}
export function taskPolicyDigest(policy: TaskPolicy): string {
  return policyDigest(policy);
}

export function digestTaskCreationToken(token: string): string {
  if (!scalar(token)) invalid();
  return createHash('sha256').update(Buffer.from(token, 'utf8')).digest('hex');
}
function stableStringify(value: unknown, ancestors = new WeakSet<object>(), depth = 0): string {
  if (depth > 64) invalid();
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid();
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') invalid();
  if (ancestors.has(value)) invalid();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
      ) {
        invalid();
      }
      const members: string[] = [];
      for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
        members.push(stableStringify(descriptor.value, ancestors, depth + 1));
      }
      return `[${members.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const keys = Object.keys(value).sort();
    if (Reflect.ownKeys(value).length !== keys.length) invalid();
    const members: string[] = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
      members.push(
        `${JSON.stringify(key)}:${stableStringify(descriptor.value, ancestors, depth + 1)}`
      );
    }
    return `{${members.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Hashes one immutable batch operation using the server lifecycle receipt tuple. */
export function taskLifecycleOperationCompletionDigest(
  batchId: string,
  commit: string,
  operation: unknown
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(batchId) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(commit) ||
    !operation ||
    typeof operation !== 'object' ||
    Array.isArray(operation)
  ) {
    invalid();
  }
  const sequenceDescriptor = Object.getOwnPropertyDescriptor(operation, 'sequence');
  const operationIdDescriptor = Object.getOwnPropertyDescriptor(operation, 'operationId');
  if (
    !sequenceDescriptor ||
    !('value' in sequenceDescriptor) ||
    !operationIdDescriptor ||
    !('value' in operationIdDescriptor)
  ) {
    invalid();
  }
  const sequence: unknown = sequenceDescriptor.value;
  const operationId: unknown = operationIdDescriptor.value;
  if (
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 0 ||
    typeof operationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(operationId)
  ) {
    invalid();
  }
  return createHash('sha256')
    .update(
      stableStringify([
        'omp-spec-kit/task-lifecycle-operation-completion@1',
        batchId,
        commit,
        sequence,
        operationId,
        operation,
      ]),
      'utf8'
    )
    .digest('hex');
}

/** Hashes canonical spec_patch args while keeping transport project/requestId in their signed tuple slots. */
export function taskGenesisRequestDigest(
  requestId: string,
  resolvedProject: string,
  specPatchArgs: unknown
): string {
  if (
    !scalar(requestId) ||
    !scalar(resolvedProject) ||
    !specPatchArgs ||
    typeof specPatchArgs !== 'object' ||
    Array.isArray(specPatchArgs)
  ) {
    invalid();
  }
  const args = specPatchArgs as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const keys = Reflect.ownKeys(args);
  if (keys.some((key) => typeof key !== 'string')) invalid();
  const normalized: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) invalid();
    if (descriptor.value === undefined) invalid();
    if (key === 'project') {
      if (descriptor.value !== resolvedProject) invalid();
      continue;
    }
    if (key === 'requestId') {
      if (descriptor.value !== requestId) invalid();
      continue;
    }
    if (key === 'genesisAttestations') continue;
    Object.defineProperty(normalized, key, {
      value: descriptor.value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  const bytes = stableStringify([
    'omp-spec-kit/task-genesis-request@1',
    requestId,
    resolvedProject,
    normalized,
  ]);
  return createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex');
}

async function signPayload(
  store: DesktopSigningKeyStore,
  payload: (string | number | null)[],
  keyIndex: number
): Promise<SignedTaskPayload> {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const { publicKey, keyId } = await store.publicIdentity();
  const der = Buffer.from(publicKey, 'base64url');
  if (
    der.toString('base64url') !== publicKey ||
    !digest(keyId) ||
    createHash('sha256').update(der).digest('hex') !== keyId ||
    payload[keyIndex] !== keyId
  )
    invalid();
  const signature = await store.signBytes(bytes);
  if (
    !/^[A-Za-z0-9_-]+$/u.test(signature) ||
    Buffer.from(signature, 'base64url').length !== 64 ||
    Buffer.from(signature, 'base64url').toString('base64url') !== signature
  )
    invalid();
  const publicKeyObject = createPublicKey({ key: der, type: 'spki', format: 'der' });
  if (
    publicKeyObject.asymmetricKeyType !== 'ed25519' ||
    !publicKeyObject.export({ type: 'spki', format: 'der' }).equals(der) ||
    !verify(null, bytes, publicKeyObject, Buffer.from(signature, 'base64url'))
  )
    invalid();
  return Object.freeze({ payload: Object.freeze(payload), signature });
}

/** The locally verified proof is bound to the challenge; no paths or file bytes are accepted or returned. */
export function signTaskAttestation(
  store: DesktopSigningKeyStore,
  proof: VerifiedTaskProof,
  challenge: unknown
): Promise<SignedTaskPayload> {
  const a = exactArray(challenge, 20);
  if (a[0] !== 'omp-spec-kit/task-attestation@1') invalid();
  validateIdentity(a);
  if (
    !scalar(a[10]) ||
    !statuses[a[10]] ||
    !scalar(a[11]) ||
    !statuses[a[11]] ||
    !integer(a[12], 1) ||
    !digest(a[13]) ||
    !digest(a[14]) ||
    !integer(a[15], 0) ||
    (a[15] as number) > 20 * 1024 * 1024 ||
    !digest(a[16]) ||
    !integer(a[17], 1) ||
    !digest(a[18]) ||
    !scalar(a[19])
  )
    invalid();
  compare(a, 1, [
    ...identityValues(proof),
    proof.fromStatus,
    proof.toStatus,
    proof.policyVersion,
    proof.policyDigest,
    proof.artifactDigest,
    proof.artifactSize,
  ]);
  return signPayload(store, a, 18);
}

/** The signature covers the policy digest; file contents and paths remain local. */
export function signTaskPolicyChange(
  store: DesktopSigningKeyStore,
  proof: PolicyChangeProof,
  challenge: unknown
): Promise<SignedTaskPayload> {
  const a = exactArray(challenge, 18);
  if (a[0] !== 'omp-spec-kit/task-policy-change@1') invalid();
  validateIdentity(a);
  if (
    !integer(a[10], 0) ||
    (a[10] === 0 ? a[11] !== null : !digest(a[11])) ||
    !integer(a[12], 1) ||
    a[12] !== (a[10] as number) + 1 ||
    !digest(a[13]) ||
    !digest(a[14]) ||
    !integer(a[15], 1) ||
    !digest(a[16]) ||
    !scalar(a[17])
  )
    invalid();
  compare(a, 1, [
    ...identityValues(proof),
    proof.previousVersion,
    proof.previousDigest,
    proof.nextVersion,
    policyDigest(proof.policy),
  ]);
  return signPayload(store, a, 16);
}

/** Validates the exact challenge against request fields the desktop can independently know. */
export function validateTaskGenesisAttestationChallenge(
  expected: TaskGenesisAttestationExpected,
  challenge: unknown,
  now = Date.now()
): readonly (string | number | null)[] {
  const a = exactArray(challenge, 25);
  if (a[0] !== 'omp-spec-kit/task-genesis-attestation@1' || !expected.policy?.required) invalid();
  if (
    !uuid.test(expected.registryStoreId) ||
    !scalar(expected.idp) ||
    !scalar(expected.userId) ||
    !scalar(expected.teamId) ||
    !scalar(expected.project) ||
    !scalar(expected.spec) ||
    !taskId.test(expected.taskId) ||
    !uuid.test(expected.requestId) ||
    !digest(expected.payloadDigest) ||
    !digest(expected.creationTokenDigest)
  ) {
    invalid();
  }
  const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
  if (
    ![1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].every((index) => scalar(a[index])) ||
    !validGenesisRef(a[11]) ||
    !taskId.test(a[8] as string) ||
    !uuid.test(a[9] as string) ||
    !oid.test(a[12] as string) ||
    !oid.test(a[13] as string) ||
    (a[12] as string).length !== (a[13] as string).length ||
    a[12] === a[13] ||
    !uuid.test(a[14] as string) ||
    !uuid.test(a[15] as string) ||
    !uuid.test(a[16] as string) ||
    !uuid.test(a[17] as string) ||
    !digest(a[18]) ||
    !digest(a[19]) ||
    !digest(a[20]) ||
    !digest(a[21]) ||
    !digest(a[22]) ||
    !digest(a[23]) ||
    !integer(a[24], 1) ||
    (a[24] as number) <= now ||
    !Number.isSafeInteger(now) ||
    now < 0
  ) {
    invalid();
  }
  compare(a, 1, [expected.registryStoreId, expected.idp, expected.userId, expected.teamId]);
  if (
    a[6] !== expected.project ||
    a[7] !== expected.spec ||
    a[8] !== expected.taskId ||
    a[17] !== expected.requestId ||
    a[18] !== expected.payloadDigest ||
    a[19] !== expected.creationTokenDigest ||
    a[21] !== policyDigest(expected.policy)
  ) {
    invalid();
  }
  const bytes = JSON.stringify(a);
  if (typeof bytes !== 'string' || Buffer.byteLength(bytes, 'utf8') > 16_384) invalid();
  return Object.freeze(a);
}

/**
 * Signs a server-reserved initial policy challenge. The caller must authenticate the registry
 * response and compare all locally-known request identity, scope, token, and policy fields first.
 */
export function signTaskGenesisAttestation(
  store: DesktopSigningKeyStore,
  expected: TaskGenesisAttestationExpected,
  challenge: unknown,
  now = Date.now()
): Promise<SignedTaskPayload> {
  const payload = [...validateTaskGenesisAttestationChallenge(expected, challenge, now)];
  return signPayload(store, payload, 22);
}
