import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { signTaskAttestation } from './TaskAttestation';

import type { DesktopSigningKeyStore } from './DesktopSigningKeyStore';
import type {
  SignedTaskPayload,
  TaskIdentity,
  TaskPolicy,
  VerifiedTaskProof,
} from './TaskAttestation';
import type { TaskArtifactProof, TaskAttachmentMeta } from '@shared/types';
import type { FileHandle } from 'node:fs/promises';

const MAX_ARTIFACT_SIZE = 20 * 1024 * 1024;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const ATTACHMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TASK_ID_PATTERN = /^TASK-[1-9][0-9]*$/u;
const STATUS_SET: Readonly<Record<string, true>> = Object.freeze(
  Object.assign(Object.create(null), {
    planned: true,
    todo: true,
    ready: true,
    'in-progress': true,
    blocked: true,
    done: true,
    deferred: true,
    deleted: true,
    unknown: true,
  })
);
const IDENTITY_KEYS = [
  'registry',
  'idp',
  'userId',
  'teamId',
  'project',
  'spec',
  'taskId',
  'generation',
  'revision',
] as const;
const PROOF_KEYS = [
  ...IDENTITY_KEYS,
  'fromStatus',
  'toStatus',
  'policyVersion',
  'policyDigest',
  'artifactDigest',
  'artifactSize',
] as const;
const CONTEXT_KEYS = ['callerIdentity', 'proof', 'policy'] as const;
const READ_BUFFER_BYTES = 64 * 1024;

/**
 * Current task state and caller identity must come from the authenticated registry
 * read performed by the caller. This module verifies their consistency with the
 * local file and the challenge; it cannot authenticate an arbitrary injected client.
 */
export interface TaskAttestationCallerContext {
  readonly callerIdentity: TaskIdentity;
  readonly proof: VerifiedTaskProof;
  /** The verified artifact requires a resolved expected filename matching controller metadata. */
  readonly policy: TaskPolicy;
}

/**
 * Injected boundary for the future authenticated registry-client adapter. It
 * receives only identity/status/policy digest/hash/size, never local path, filename,
 * policy contents, or file bytes. The local filename and current policy are bound
 * through the policy digest. This structural port does not itself prove
 * authentication; absent a trusted adapter/context, callers must fail closed.
 */
export interface TaskAttestationChallengeClient {
  requestChallenge(proof: VerifiedTaskProof): Promise<unknown>;
}

export interface VerifyAndSignTaskArtifactInput {
  /** Metadata and proof must come from the same current task snapshot read by the trusted main process. */
  readonly attachment: TaskAttachmentMeta;
  /** Controller proof that binds this attachment ID to its stored bytes. */
  readonly attachmentProof: TaskArtifactProof;
  /**
   * Root derived only from the main-created controller's context.paths and task ID,
   * using its task-attachment path convention. Never accept it from renderer/HTTP.
   * This structural verifier checks containment but cannot authenticate provenance;
   * trusted main-process wiring is still required.
   */
  readonly allowedRoot: string;
  /** Required context from an authenticated registry read; origin is not authenticated here. */
  readonly callerContext: TaskAttestationCallerContext | null | undefined;
  /** Required injected adapter; its authentication must be established by trusted wiring. */
  readonly challengeClient: TaskAttestationChallengeClient | null | undefined;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface PathIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface OpenArtifact {
  readonly handle: FileHandle;
  readonly canonicalRoot: string;
  readonly canonicalFile: string;
  readonly filename: string;
  readonly identity: FileIdentity;
  readonly rootIdentity: PathIdentity;
}

function refuse(): never {
  // Intentionally omit filesystem paths, filenames, bytes, and server response text.
  throw new Error('Local task artifact attestation was refused');
}

function hasScalarUnicode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)
  );
}

function dataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) refuse();
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key))) refuse();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) refuse();
    result[key] = descriptor.value;
  }
  for (const key of optional) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor) {
      if (!('value' in descriptor)) refuse();
      result[key] = descriptor.value;
    }
  }
  return result;
}

function copyIdentity(value: unknown): TaskIdentity {
  const record = dataRecord(value, IDENTITY_KEYS);
  const identity: TaskIdentity = {
    registry: record.registry as string,
    idp: record.idp as string,
    userId: record.userId as string,
    teamId: record.teamId as string,
    project: record.project as string,
    spec: record.spec as string,
    taskId: record.taskId as string,
    generation: record.generation as string,
    revision: record.revision as string,
  };
  if (
    !IDENTITY_KEYS.slice(0, 8).every((key) => hasScalarUnicode(identity[key])) ||
    !TASK_ID_PATTERN.test(identity.taskId) ||
    !HASH_PATTERN.test(identity.revision)
  )
    refuse();
  return Object.freeze(identity);
}

function copyProof(value: unknown): VerifiedTaskProof {
  const record = dataRecord(value, PROOF_KEYS);
  const identity = copyIdentity({
    registry: record.registry,
    idp: record.idp,
    userId: record.userId,
    teamId: record.teamId,
    project: record.project,
    spec: record.spec,
    taskId: record.taskId,
    generation: record.generation,
    revision: record.revision,
  });
  const proof: VerifiedTaskProof = {
    ...identity,
    fromStatus: record.fromStatus as string,
    toStatus: record.toStatus as string,
    policyVersion: record.policyVersion as number,
    policyDigest: record.policyDigest as string,
    artifactDigest: record.artifactDigest as string,
    artifactSize: record.artifactSize as number,
  };
  if (
    !hasScalarUnicode(proof.fromStatus) ||
    !STATUS_SET[proof.fromStatus] ||
    !hasScalarUnicode(proof.toStatus) ||
    !STATUS_SET[proof.toStatus] ||
    !Number.isSafeInteger(proof.policyVersion) ||
    proof.policyVersion < 1 ||
    !HASH_PATTERN.test(proof.policyDigest) ||
    !HASH_PATTERN.test(proof.artifactDigest) ||
    !Number.isSafeInteger(proof.artifactSize) ||
    proof.artifactSize < 0 ||
    proof.artifactSize > MAX_ARTIFACT_SIZE
  )
    refuse();
  return Object.freeze(proof);
}

function isSafeFilename(value: unknown): value is string {
  return (
    hasScalarUnicode(value) &&
    value.length <= 255 &&
    value.trim() === value &&
    value !== '.' &&
    value !== '..' &&
    !/[\\/:\x00-\x1f\x7f]/u.test(value)
  );
}

function copyPolicy(value: unknown): TaskPolicy {
  const record = dataRecord(value, ['required'], ['expectedFilename']);
  const candidate = record.expectedFilename;
  let expectedFilename: string | null;
  if (candidate === undefined || candidate === null) expectedFilename = null;
  else if (isSafeFilename(candidate)) expectedFilename = candidate;
  else return refuse();
  if (typeof record.required !== 'boolean' || !record.required) refuse();
  return Object.freeze({ required: true, expectedFilename });
}

function copyCallerContext(value: unknown): {
  callerIdentity: TaskIdentity;
  proof: VerifiedTaskProof;
  policy: TaskPolicy;
} {
  const record = dataRecord(value, CONTEXT_KEYS);
  const callerIdentity = copyIdentity(record.callerIdentity);
  const proof = copyProof(record.proof);
  const policy = copyPolicy(record.policy);
  if (IDENTITY_KEYS.some((key) => callerIdentity[key] !== proof[key])) refuse();
  const policyDigest = createHash('sha256')
    .update(
      JSON.stringify(['omp-spec-kit/task-policy@1', policy.required, policy.expectedFilename]),
      'utf8'
    )
    .digest('hex');
  if (proof.policyDigest !== policyDigest) refuse();
  return { callerIdentity, proof, policy };
}

interface LocalTaskAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly filePath: string;
}

function copyTaskAttachment(value: unknown): LocalTaskAttachment {
  const record = dataRecord(value, ['id', 'filename', 'mimeType', 'size', 'addedAt'], ['filePath']);
  if (
    typeof record.id !== 'string' ||
    !ATTACHMENT_ID_PATTERN.test(record.id) ||
    !isSafeFilename(record.filename) ||
    typeof record.mimeType !== 'string' ||
    !record.mimeType ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) < 0 ||
    (record.size as number) > MAX_ARTIFACT_SIZE ||
    typeof record.filePath !== 'string'
  )
    refuse();
  return {
    id: record.id,
    filename: record.filename,
    size: record.size as number,
    filePath: record.filePath,
  };
}

function copyControllerArtifactProof(value: unknown): TaskArtifactProof {
  const record = dataRecord(value, ['attachmentId', 'sha256', 'size']);
  if (
    typeof record.attachmentId !== 'string' ||
    !ATTACHMENT_ID_PATTERN.test(record.attachmentId) ||
    typeof record.sha256 !== 'string' ||
    !HASH_PATTERN.test(record.sha256) ||
    !Number.isSafeInteger(record.size) ||
    (record.size as number) < 0 ||
    (record.size as number) > MAX_ARTIFACT_SIZE
  )
    refuse();
  return {
    attachmentId: record.attachmentId,
    sha256: record.sha256,
    size: record.size as number,
  };
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

interface FileIdentityStats {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

function fileIdentity(stats: FileIdentityStats): FileIdentity {
  if (stats.ino === 0n) refuse();
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function samePathIdentity(a: PathIdentity, b: PathIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

async function rootIdentity(root: string): Promise<{ canonical: string; identity: PathIdentity }> {
  const pathStat = await fs.lstat(root, { bigint: true });
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory() || pathStat.ino === 0n) refuse();
  const canonical = await fs.realpath(root);
  if (path.relative(path.resolve(root), canonical) !== '') refuse();
  return { canonical, identity: { dev: pathStat.dev, ino: pathStat.ino } };
}

async function openArtifact(filePath: string, allowedRoot: string): Promise<OpenArtifact> {
  if (
    typeof filePath !== 'string' ||
    typeof allowedRoot !== 'string' ||
    !path.isAbsolute(filePath) ||
    !path.isAbsolute(allowedRoot) ||
    filePath.startsWith('\\\\') ||
    filePath.startsWith('//') ||
    allowedRoot.startsWith('\\\\') ||
    allowedRoot.startsWith('//')
  )
    refuse();
  const lexicalRoot = path.resolve(allowedRoot);
  const lexicalFile = path.resolve(filePath);
  const filename = path.basename(lexicalFile);
  if (!isWithin(lexicalRoot, lexicalFile) || !isSafeFilename(filename)) refuse();
  const relative = path.relative(lexicalRoot, lexicalFile);
  const segments = relative.split(path.sep);
  if (
    segments.length === 0 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  )
    refuse();

  const root = await rootIdentity(lexicalRoot);
  let parent = lexicalRoot;
  for (const segment of segments.slice(0, -1)) {
    parent = path.join(parent, segment);
    const directoryStat = await fs.lstat(parent, { bigint: true });
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) refuse();
  }
  const pathStat = await fs.lstat(lexicalFile, { bigint: true });
  if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size > BigInt(MAX_ARTIFACT_SIZE))
    refuse();
  const canonicalFile = await fs.realpath(lexicalFile);
  const canonicalFilename = path.basename(canonicalFile);
  if (
    !isWithin(root.canonical, canonicalFile) ||
    canonicalFilename !== filename ||
    !isSafeFilename(canonicalFilename)
  )
    refuse();

  const handle = await fs.open(canonicalFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const identity = fileIdentity(opened);
    if (
      !opened.isFile() ||
      !sameIdentity(identity, fileIdentity(pathStat)) ||
      identity.size > BigInt(MAX_ARTIFACT_SIZE)
    )
      refuse();
    return {
      handle,
      canonicalRoot: root.canonical,
      canonicalFile,
      filename,
      identity,
      rootIdentity: root.identity,
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function revalidateOpenArtifact(
  opened: OpenArtifact,
  filePath: string,
  allowedRoot: string
): Promise<void> {
  const [descriptorStat, pathStat, fileRealPath, root] = await Promise.all([
    opened.handle.stat({ bigint: true }),
    fs.lstat(filePath, { bigint: true }),
    fs.realpath(filePath),
    rootIdentity(path.resolve(allowedRoot)),
  ]);
  const relative = path.relative(path.resolve(allowedRoot), path.resolve(filePath));
  if (!isWithin(path.resolve(allowedRoot), path.resolve(filePath))) refuse();
  let parent = path.resolve(allowedRoot);
  for (const segment of relative.split(path.sep).slice(0, -1)) {
    parent = path.join(parent, segment);
    const parentStat = await fs.lstat(parent, { bigint: true });
    if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) refuse();
  }
  const filename = path.basename(fileRealPath);
  if (
    !descriptorStat.isFile() ||
    pathStat.isSymbolicLink() ||
    !pathStat.isFile() ||
    !sameIdentity(opened.identity, fileIdentity(descriptorStat)) ||
    !sameIdentity(opened.identity, fileIdentity(pathStat)) ||
    fileRealPath !== opened.canonicalFile ||
    root.canonical !== opened.canonicalRoot ||
    !samePathIdentity(opened.rootIdentity, root.identity) ||
    !isWithin(root.canonical, fileRealPath) ||
    filename !== opened.filename ||
    !isSafeFilename(filename)
  )
    refuse();
}

async function hashOpenArtifact(handle: FileHandle): Promise<{ digest: string; size: number }> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
    if (offset > MAX_ARTIFACT_SIZE) refuse();
    hash.update(buffer.subarray(0, bytesRead));
  }
  return { digest: hash.digest('hex'), size: offset };
}

async function openVerifiedLocalArtifact(
  attachment: LocalTaskAttachment,
  proof: TaskArtifactProof,
  allowedRoot: string,
  expectedFilename?: string
): Promise<OpenArtifact> {
  if (
    !path.isAbsolute(allowedRoot) ||
    attachment.id !== proof.attachmentId ||
    attachment.size !== proof.size ||
    (expectedFilename !== undefined &&
      (!isSafeFilename(expectedFilename) || attachment.filename !== expectedFilename))
  )
    refuse();
  const filePath = path.join(allowedRoot, `${attachment.id}--artifact.bin`);
  if (attachment.filePath !== filePath) refuse();
  const opened = await openArtifact(filePath, allowedRoot);
  try {
    if (opened.identity.size !== BigInt(proof.size)) refuse();
    const artifact = await hashOpenArtifact(opened.handle);
    if (artifact.digest !== proof.sha256 || artifact.size !== proof.size) refuse();
    await revalidateOpenArtifact(opened, filePath, allowedRoot);
    return opened;
  } catch (error) {
    await opened.handle.close().catch(() => undefined);
    throw error;
  }
}

/** Verify locally retained task bytes without requiring a server attestation. */
export async function verifyLocalTaskArtifact(input: {
  readonly attachment: TaskAttachmentMeta;
  readonly attachmentProof: TaskArtifactProof;
  readonly allowedRoot: string;
  readonly expectedFilename?: string;
}): Promise<void> {
  let opened: OpenArtifact | null = null;
  try {
    const request = dataRecord(
      input,
      ['attachment', 'attachmentProof', 'allowedRoot'],
      ['expectedFilename']
    );
    if (
      typeof request.allowedRoot !== 'string' ||
      (request.expectedFilename !== undefined && typeof request.expectedFilename !== 'string')
    )
      refuse();
    opened = await openVerifiedLocalArtifact(
      copyTaskAttachment(request.attachment),
      copyControllerArtifactProof(request.attachmentProof),
      request.allowedRoot,
      request.expectedFilename
    );
  } catch {
    return refuse();
  } finally {
    if (opened) await opened.handle.close().catch(() => undefined);
  }
}

function copyChallenge(value: unknown): (string | number | null)[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== 20
  )
    refuse();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 21 || keys.some((key) => typeof key !== 'string')) refuse();
  const result: (string | number | null)[] = [];
  for (let index = 0; index < 20; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) refuse();
    result.push(descriptor.value as string | number | null);
  }
  return result;
}

function getChallengeRequester(
  client: TaskAttestationChallengeClient
): (proof: VerifiedTaskProof) => Promise<unknown> {
  if (client === null || typeof client !== 'object') refuse();
  let current: object | null = client;
  while (current) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'requestChallenge');
    if (descriptor) {
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') refuse();
      return (proof) =>
        Reflect.apply(descriptor.value as (...args: unknown[]) => Promise<unknown>, client, [
          proof,
        ]);
    }
    current = Object.getPrototypeOf(current);
  }
  return refuse();
}

/**
 * Verifies and signs a task artifact without accepting a caller-supplied path/name,
 * or returning/transmitting the local path, filename, or bytes. The trusted task
 * snapshot links metadata ID, logical filename, controller proof, and the fixed
 * `<attachmentId>--artifact.bin` file under the task-specific root. The caller supplies
 * an authenticated challenge client; this verifier does not authenticate the transport.
 * The file handle remains open through challenge retrieval, signing, and final
 * identity/size/timestamp checks. This detects ordinary replacement/modification;
 * it does not claim to defeat a malicious same-user process that can race and restore
 * metadata on the same filesystem.
 */
export async function verifyAndSignTaskArtifact(
  store: DesktopSigningKeyStore,
  input: VerifyAndSignTaskArtifactInput
): Promise<SignedTaskPayload> {
  if (!store || !input) refuse();
  let opened: OpenArtifact | null = null;
  try {
    const request = dataRecord(input, [
      'attachment',
      'attachmentProof',
      'allowedRoot',
      'callerContext',
      'challengeClient',
    ]);
    if (!request.callerContext || !request.challengeClient) refuse();
    const context = copyCallerContext(request.callerContext);
    const attachment = copyTaskAttachment(request.attachment);
    const attachmentProof = copyControllerArtifactProof(request.attachmentProof);
    const allowedRoot = request.allowedRoot;
    if (
      typeof allowedRoot !== 'string' ||
      attachmentProof.sha256 !== context.proof.artifactDigest ||
      attachmentProof.size !== context.proof.artifactSize ||
      !context.policy.expectedFilename
    )
      refuse();
    opened = await openVerifiedLocalArtifact(
      attachment,
      attachmentProof,
      allowedRoot,
      context.policy.expectedFilename
    );
    const filePath = path.join(allowedRoot, `${attachment.id}--artifact.bin`);

    const requestChallenge = getChallengeRequester(
      request.challengeClient as TaskAttestationChallengeClient
    );
    const rawChallenge = await requestChallenge(context.proof);
    const challenge = copyChallenge(rawChallenge);
    const expiresAt = challenge[17];
    if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= Date.now()) refuse();

    const signed = await signTaskAttestation(store, context.proof, challenge);
    if ((expiresAt as number) <= Date.now()) refuse();
    await revalidateOpenArtifact(opened, filePath, allowedRoot);
    return signed;
  } catch {
    return refuse();
  } finally {
    if (opened) await opened.handle.close().catch(() => undefined);
  }
}
