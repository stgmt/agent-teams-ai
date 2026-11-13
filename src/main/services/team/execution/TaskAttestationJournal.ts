import * as fs from 'node:fs';
import * as path from 'node:path';

import { type TaskPolicy, taskPolicyDigest } from '@main/services/identity/TaskAttestation';

import { atomicWriteSync } from '../../../utils/atomicWrite';
import { withFileLock } from '../fileLock';
import { isRecord } from '../registry/RegistryJson';

import type {
  RegistryTaskCompletionReplayRecord,
  RegistryTaskPolicyChangeReplayRecord,
} from '../registry/RegistryTaskClientTypes';

const POLICY_CHALLENGE = 'omp-spec-kit/task-policy-change@1';
const COMPLETION_CHALLENGE = 'omp-spec-kit/task-attestation@1';
const TASK_ID = /^TASK-[1-9][0-9]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_SEGMENT = /^[^\\/:\u0000-\u001f\u007f]+$/u;
const TASK_STATUSES = new Set([
  'planned',
  'todo',
  'ready',
  'in-progress',
  'blocked',
  'done',
  'deferred',
  'deleted',
  'unknown',
]);

export type TaskAttestationJournalEntry =
  | {
      readonly teamName: string;
      readonly taskId: string;
      readonly operation: 'policy';
      readonly replay: RegistryTaskPolicyChangeReplayRecord;
    }
  | {
      readonly teamName: string;
      readonly taskId: string;
      readonly operation: 'completion';
      readonly replay: RegistryTaskCompletionReplayRecord;
    };

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = []
): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  return (
    keys.length >= required.length &&
    keys.every((key) => typeof key === 'string' && allowed.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function isSafeSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value &&
    value !== '.' &&
    value !== '..' &&
    SAFE_SEGMENT.test(value)
  );
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}

function isInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && SHA256.test(value);
}

function isPayload(
  value: unknown,
  expectedLength: number
): value is readonly (string | number | null)[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== expectedLength ||
    Reflect.ownKeys(value).length !== expectedLength + 1
  ) {
    return false;
  }
  for (let index = 0; index < expectedLength; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) return false;
    const entry: unknown = descriptor.value;
    if (
      entry !== null &&
      !(typeof entry === 'string' && entry.length <= 4096) &&
      !(typeof entry === 'number' && Number.isSafeInteger(entry))
    ) {
      return false;
    }
  }
  return true;
}

function samePayload(
  first: readonly (string | number | null)[],
  second: readonly (string | number | null)[]
): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function isRegistrationIdentity(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['securityStoreId', 'idp', 'userId']) &&
    isText(value.securityStoreId) &&
    isText(value.idp) &&
    isText(value.userId)
  );
}

function hasTaskIdentityFields(value: Record<string, unknown>): boolean {
  return (
    [
      value.registry,
      value.idp,
      value.userId,
      value.teamId,
      value.project,
      value.spec,
      value.generation,
    ].every(isText) &&
    typeof value.taskId === 'string' &&
    TASK_ID.test(value.taskId) &&
    isDigest(value.revision)
  );
}

function isTaskIdentity(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'registry',
      'idp',
      'userId',
      'teamId',
      'project',
      'spec',
      'taskId',
      'generation',
      'revision',
    ]) &&
    hasTaskIdentityFields(value)
  );
}

function taskIdentityMatchesPayload(
  identity: Record<string, unknown>,
  payload: readonly (string | number | null)[]
): boolean {
  return (
    payload[1] === identity.registry &&
    payload[2] === identity.idp &&
    payload[3] === identity.userId &&
    payload[4] === identity.teamId &&
    payload[5] === identity.project &&
    payload[6] === identity.spec &&
    payload[7] === identity.taskId &&
    payload[8] === identity.generation &&
    payload[9] === identity.revision
  );
}

function registrationMatchesIdentity(
  registration: Record<string, unknown>,
  identity: Record<string, unknown>
): boolean {
  return (
    registration.securityStoreId === identity.registry &&
    registration.idp === identity.idp &&
    registration.userId === identity.userId
  );
}

function isTaskPolicy(value: unknown): value is TaskPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['required'], ['expectedFilename']) ||
    typeof value.required !== 'boolean'
  ) {
    return false;
  }
  const expectedFilename = value.expectedFilename;
  if (
    Object.hasOwn(value, 'expectedFilename') &&
    (expectedFilename === undefined || (expectedFilename !== null && !isText(expectedFilename)))
  ) {
    return false;
  }
  const policy: TaskPolicy = {
    required: value.required,
    ...(typeof expectedFilename === 'string' || expectedFilename === null
      ? { expectedFilename }
      : {}),
  };
  try {
    taskPolicyDigest(policy);
    return true;
  } catch {
    return false;
  }
}

function isSignedRequest(
  signed: unknown,
  challengePayload: readonly (string | number | null)[]
): signed is { readonly payload: readonly (string | number | null)[]; readonly signature: string } {
  if (
    !isRecord(signed) ||
    !hasExactKeys(signed, ['payload', 'signature']) ||
    !isPayload(signed.payload, challengePayload.length) ||
    !samePayload(signed.payload, challengePayload) ||
    typeof signed.signature !== 'string' ||
    !/^[A-Za-z0-9_-]+$/u.test(signed.signature)
  ) {
    return false;
  }
  const signatureBytes = Buffer.from(signed.signature, 'base64url');
  return signatureBytes.length === 64 && signatureBytes.toString('base64url') === signed.signature;
}

function isPolicyReplay(value: unknown): value is RegistryTaskPolicyChangeReplayRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
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
    ]) ||
    !isText(value.requestId) ||
    !isText(value.project) ||
    !isText(value.spec) ||
    !isText(value.teamId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    !isRegistrationIdentity(value.expectedRegistrationIdentity) ||
    !isTaskPolicy(value.policy) ||
    !isPayload(value.challengePayload, 18) ||
    !isTaskIdentity(value.callerIdentity) ||
    !isRecord(value.proof) ||
    !hasExactKeys(value.proof, [
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
    ]) ||
    !hasTaskIdentityFields(value.proof) ||
    !isInteger(value.proof.previousVersion, 0) ||
    (value.proof.previousVersion === 0
      ? value.proof.previousDigest !== null
      : !isDigest(value.proof.previousDigest)) ||
    !isInteger(value.proof.nextVersion, 1) ||
    value.proof.nextVersion !== value.proof.previousVersion + 1 ||
    !isTaskPolicy(value.proof.policy) ||
    value.proof.requestId !== value.requestId ||
    !isSignedRequest(value.signed, value.challengePayload) ||
    !isRecord(value.requestArguments) ||
    !hasExactKeys(value.requestArguments, [
      'action',
      'project',
      'requestId',
      'teamId',
      'spec',
      'taskId',
      'policy',
      'payload',
      'signature',
    ])
  ) {
    return false;
  }
  const payload = value.challengePayload;
  const proof = value.proof;
  const identity = value.callerIdentity;
  const registration = value.expectedRegistrationIdentity;
  const args = value.requestArguments;
  return (
    payload[0] === POLICY_CHALLENGE &&
    taskIdentityMatchesPayload(identity, payload) &&
    taskIdentityMatchesPayload(proof, payload) &&
    registrationMatchesIdentity(registration, identity) &&
    identity.teamId === value.teamId &&
    identity.project === value.project &&
    identity.spec === value.spec &&
    identity.taskId === value.taskId &&
    proof.previousVersion === payload[10] &&
    proof.previousDigest === payload[11] &&
    proof.nextVersion === payload[12] &&
    payload[13] === taskPolicyDigest(value.policy) &&
    payload[15] !== null &&
    isInteger(payload[15], 1) &&
    isDigest(payload[14]) &&
    isDigest(payload[16]) &&
    payload[17] === value.requestId &&
    JSON.stringify(proof.policy) === JSON.stringify(value.policy) &&
    args.action === 'task_policy' &&
    args.project === value.project &&
    args.requestId === value.requestId &&
    args.teamId === value.teamId &&
    args.spec === value.spec &&
    args.taskId === value.taskId &&
    JSON.stringify(args.policy) === JSON.stringify(value.policy) &&
    isPayload(args.payload, 18) &&
    samePayload(args.payload, payload) &&
    args.signature === value.signed.signature
  );
}

function isCompletionReplay(value: unknown): value is RegistryTaskCompletionReplayRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
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
    ]) ||
    !isText(value.requestId) ||
    !isText(value.project) ||
    !isText(value.spec) ||
    !isText(value.teamId) ||
    typeof value.taskId !== 'string' ||
    !TASK_ID.test(value.taskId) ||
    !isRegistrationIdentity(value.expectedRegistrationIdentity) ||
    !isPayload(value.challengePayload, 20) ||
    !isTaskIdentity(value.callerIdentity) ||
    !isRecord(value.proof) ||
    !hasExactKeys(value.proof, [
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
    ]) ||
    !hasTaskIdentityFields(value.proof) ||
    typeof value.proof.fromStatus !== 'string' ||
    !TASK_STATUSES.has(value.proof.fromStatus) ||
    value.proof.toStatus !== 'done' ||
    !isInteger(value.proof.policyVersion, 1) ||
    !isDigest(value.proof.policyDigest) ||
    !isDigest(value.proof.artifactDigest) ||
    !isInteger(value.proof.artifactSize, 0) ||
    value.proof.artifactSize > 20 * 1024 * 1024 ||
    !isSignedRequest(value.signed, value.challengePayload) ||
    !isRecord(value.requestArguments) ||
    !hasExactKeys(value.requestArguments, [
      'action',
      'project',
      'requestId',
      'teamId',
      'spec',
      'taskId',
      'payload',
      'signature',
    ])
  ) {
    return false;
  }
  const payload = value.challengePayload;
  const proof = value.proof;
  const identity = value.callerIdentity;
  const registration = value.expectedRegistrationIdentity;
  const args = value.requestArguments;
  return (
    payload[0] === COMPLETION_CHALLENGE &&
    taskIdentityMatchesPayload(identity, payload) &&
    taskIdentityMatchesPayload(proof, payload) &&
    registrationMatchesIdentity(registration, identity) &&
    identity.teamId === value.teamId &&
    identity.project === value.project &&
    identity.spec === value.spec &&
    identity.taskId === value.taskId &&
    payload[10] === proof.fromStatus &&
    payload[11] === proof.toStatus &&
    payload[12] === proof.policyVersion &&
    payload[13] === proof.policyDigest &&
    payload[14] === proof.artifactDigest &&
    payload[15] === proof.artifactSize &&
    isDigest(payload[16]) &&
    isInteger(payload[17], 1) &&
    isDigest(payload[18]) &&
    payload[19] === value.requestId &&
    args.action === 'task_complete' &&
    args.project === value.project &&
    args.requestId === value.requestId &&
    args.teamId === value.teamId &&
    args.spec === value.spec &&
    args.taskId === value.taskId &&
    isPayload(args.payload, 20) &&
    samePayload(args.payload, payload) &&
    args.signature === value.signed.signature
  );
}

function isJournalEntry(value: unknown, teamName: string): value is TaskAttestationJournalEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['teamName', 'taskId', 'operation', 'replay']) ||
    value.teamName !== teamName ||
    !isSafeSegment(value.taskId)
  ) {
    return false;
  }
  if (value.operation === 'policy') return isPolicyReplay(value.replay);
  if (value.operation === 'completion') return isCompletionReplay(value.replay);
  return false;
}

function validateEntries(value: unknown, teamName: string): value is TaskAttestationJournalEntry[] {
  if (!Array.isArray(value)) return false;
  const keys = new Set<string>();
  for (const entry of value) {
    if (!isJournalEntry(entry, teamName)) return false;
    const key = `${entry.taskId}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return true;
}

/** Persists the exact signed task mutation before transport and retains unknown outcomes. */
export class TaskAttestationJournal {
  constructor(private readonly teamsDirectory: string) {}

  async run<T>(
    teamName: string,
    operation: (entries: TaskAttestationJournalEntry[], save: () => void) => Promise<T>
  ): Promise<T> {
    if (!isSafeSegment(teamName)) throw new Error('Invalid task attestation journal team');
    const directory = path.join(this.teamsDirectory, teamName, '.task-attestations');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'journal.json');
    return withFileLock(
      file,
      async () => {
        let entries: TaskAttestationJournalEntry[] = [];
        try {
          const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (
            !isRecord(parsed) ||
            !hasExactKeys(parsed, ['version', 'entries']) ||
            parsed.version !== 1 ||
            !validateEntries(parsed.entries, teamName)
          ) {
            throw new Error('Invalid task attestation journal');
          }
          entries = parsed.entries;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw new Error('Invalid task attestation journal');
          }
        }
        const save = (): void => {
          if (!validateEntries(entries, teamName)) {
            throw new Error('Invalid task attestation journal entry');
          }
          atomicWriteSync(file, JSON.stringify({ version: 1, entries }));
        };
        return operation(entries, save);
      },
      { preventLiveOwnerTakeover: true }
    );
  }
}
