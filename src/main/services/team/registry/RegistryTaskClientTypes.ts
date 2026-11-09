/**
 * Task vocabulary and wire shapes of the spec registry (`omp-spec-kit`).
 *
 * The registry is the only author of TASK structure: statuses, owners, links
 * and bodies are written through structured operations (`upsert_task`,
 * `replace_task_status`, `replace_task_owner`, `replace_task_links`), never by
 * composing TASKS.md Markdown locally. These types mirror what `spec_tasks`
 * returns and what `spec_patch` accepts, so the client can stay a thin,
 * fail-closed transport.
 */
import type {
  RegistryRegistrationIdentity,
  RegistryTaskEntity as SharedRegistryTaskEntity,
  RegistryTaskSnapshot,
  RegistryTaskSource,
  RegistryTaskStatus as SharedRegistryTaskStatus,
} from '@shared/types';
import type {
  PolicyChangeProof,
  SignedTaskPayload,
  TaskGenesisAttestationExpected,
  TaskIdentity,
  TaskPolicy,
  VerifiedTaskProof,
} from '@main/services/identity/TaskAttestation';

/** Statuses the kernel accepts, in the registry's own spelling. */
export const REGISTRY_TASK_STATUSES = [
  'planned',
  'todo',
  'ready',
  'in-progress',
  'blocked',
  'done',
  'deleted',
  'deferred',
  'unknown',
] as const satisfies readonly SharedRegistryTaskStatus[];

export type RegistryTaskStatus = SharedRegistryTaskStatus;

export type RegistryTaskEntity = SharedRegistryTaskEntity;
export type RegistryTaskSourceSnapshot = RegistryTaskSource;

/**
 * One task as the registry reports it. Canonical ids are namespaced
 * (`<spec>:TASK-7`); links (`dependsOn`, `blocks`, `blockedBy`,
 * `requirements`) are canonical ids of their own node kinds.
 */
export interface RegistryTask extends RegistryTaskSnapshot {
  refs: string[];
}

/** How a structured task write landed, as the registry reports it. */
export type RegistryTaskWriteOutcome = 'APPLIED' | 'UNCHANGED' | 'REFUSED';

/** One recorded status transition; `at` is null for previews only. */
export interface RegistryTaskTransition {
  localId: string;
  from: string | null;
  to: string | null;
  requestId: string | null;
  actor: string | null;
  at: string | null;
}

/** A structured refusal returned inside an otherwise successful envelope. */
export interface RegistryTaskRefusal {
  code: string;
  message: string;
  retryable: boolean;
  localId: string | null;
  currentStatus: string | null;
  expectedStatus: string | null;
  causeCode: string | null;
}

/**
 * Result of an idempotent task write. `REFUSED` is a value, not an exception:
 * callers that own the payload need to inspect the registry's reason. Only a
 * lost `expectedStatus` race is raised as `RegistryStatusConflictError`.
 */
export interface RegistryTaskWriteResult {
  outcome: RegistryTaskWriteOutcome;
  transitions: RegistryTaskTransition[];
  refusal: RegistryTaskRefusal | null;
  taskLifecycleReceipt?: RegistryTaskLifecycleReceipt;
}

export interface RegistryTaskLifecycleOperationBase {
  createdAt: string;
  generationId: string;
  kind: 'GENESIS' | 'TOMBSTONE';
  operationId: string;
  ownerPrincipal: string;
  project: string;
  reservationId: string;
  sequence: number;
  spec: string;
  taskId: string;
  teamId: string;
}

export interface RegistryTaskLifecycleGenesisOperation extends RegistryTaskLifecycleOperationBase {
  kind: 'GENESIS';
  creationTokenDigest: string;
  genesisExpiresAt: number | null;
  genesisKeyId: string | null;
  genesisNonce: string | null;
  genesisOrigin: 'SERVER_GENESIS' | 'SIGNED_GENESIS';
  policy: TaskPolicy;
  policyDigest: string;
  taskRevisionSha256: string;
}

export interface RegistryTaskLifecycleTombstoneOperation extends RegistryTaskLifecycleOperationBase {
  kind: 'TOMBSTONE';
}

export type RegistryTaskLifecycleBatchOperation =
  | RegistryTaskLifecycleGenesisOperation
  | RegistryTaskLifecycleTombstoneOperation;

export interface RegistryTaskLifecycleOperationReceipt {
  sequence: number;
  operationId: string;
  kind: 'GENESIS' | 'TOMBSTONE';
  commit: string;
  digest: string;
  outcome: 'FINALIZED';
  project: string;
  spec: string;
  taskId: string;
  teamId: string;
  generationId: string;
  policyDigest: string | null;
  creationTokenDigest: string | null;
  operation: RegistryTaskLifecycleBatchOperation;
}

export interface RegistryTaskLifecycleReceipt {
  schemaVersion: 'omp-spec-kit/task-lifecycle-receipt@1';
  kind: 'TASK_LIFECYCLE_FINALIZATION_RECEIPT';
  batchId: string;
  project: string;
  repo: string;
  ref: string;
  expectedParent: string;
  commit: string;
  observedCommit: string;
  requestId: string;
  payloadDigest: string;
  operations: readonly RegistryTaskLifecycleOperationReceipt[];
}

export interface RegistryTaskGenesisChallengeEntry {
  operationId: string;
  nonce: string;
  keyId: string;
  payload: readonly (string | number | null)[];
}

export interface RegistryTaskGenesisChallenge {
  batchId: string;
  requestId: string;
  payloadDigest: string;
  challenges: readonly RegistryTaskGenesisChallengeEntry[];
}

export interface RegistryTaskGenesisAttestation extends SignedTaskPayload {
  operationId: string;
  nonce: string;
  keyId: string;
}

export interface RegistryTaskGenesisChallengeResult {
  outcome: 'CHALLENGE_REQUIRED';
  challenge: RegistryTaskGenesisChallenge;
  /** Local request context already checked against the server's challenge. */
  expected: TaskGenesisAttestationExpected;
}

/** Exact signed request persisted before its final registry transport call. */
export interface RegistryTaskGenesisReplayRecord {
  readonly challenge: RegistryTaskGenesisChallenge;
  readonly attestation: RegistryTaskGenesisAttestation;
  readonly requestArguments: Readonly<Record<string, unknown>>;
}

/** Exact, durable request for retrying a policy change after an unknown outcome. */
export interface RegistryTaskPolicyChangeReplayRecord {
  readonly requestId: string;
  readonly project: string;
  readonly spec: string;
  readonly teamId: string;
  readonly taskId: string;
  readonly expectedRegistrationIdentity: RegistryRegistrationIdentity;
  readonly policy: TaskPolicy;
  readonly challengePayload: readonly (string | number | null)[];
  readonly callerIdentity: TaskIdentity;
  readonly proof: PolicyChangeProof & { requestId: string };
  readonly signed: SignedTaskPayload;
  readonly requestArguments: Readonly<Record<string, unknown>>;
}

/** Exact, durable request for retrying completion after an unknown outcome. */
export interface RegistryTaskCompletionReplayRecord {
  readonly requestId: string;
  readonly project: string;
  readonly spec: string;
  readonly teamId: string;
  readonly taskId: string;
  readonly expectedRegistrationIdentity: RegistryRegistrationIdentity;
  readonly challengePayload: readonly (string | number | null)[];
  readonly callerIdentity: TaskIdentity;
  readonly proof: VerifiedTaskProof;
  readonly signed: SignedTaskPayload;
  readonly requestArguments: Readonly<Record<string, unknown>>;
}

export interface RegistryTaskCompletionChallengeInput extends RegistryTaskScope {
  teamId: string;
  taskId: string;
  keyId: string;
  artifactDigest: string;
  artifactSize: number;
  requestId?: string;
  expectedRegistrationIdentity: RegistryRegistrationIdentity;
  signal?: AbortSignal;
}

export interface RegistryTaskCompletionChallenge extends RegistryTaskScope {
  readonly requestId: string;
  readonly teamId: string;
  readonly taskId: string;
  readonly expectedRegistrationIdentity: RegistryRegistrationIdentity;
  readonly payload: readonly (string | number | null)[];
  readonly callerIdentity: TaskIdentity;
  readonly proof: VerifiedTaskProof;
}

export interface RegistryTaskCompletionInput {
  challenge: RegistryTaskCompletionChallenge;
  signed: SignedTaskPayload;
  expectedRegistrationIdentity: RegistryRegistrationIdentity;
  beforeSend: (replay: RegistryTaskCompletionReplayRecord) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface RegistryTaskCompletionResult extends RegistryTaskScope {
  readonly outcome: 'APPLIED';
  readonly status: 'done';
  readonly requestId: string;
  readonly teamId: string;
  readonly taskId: string;
  readonly commit: string;
  readonly transitions: readonly RegistryTaskTransition[];
}

export interface RegistryTaskPolicyChangeChallengeInput extends RegistryTaskScope {
  teamId: string;
  taskId: string;
  keyId: string;
  policy: TaskPolicy;
  requestId?: string;
  expectedRegistrationIdentity: RegistryRegistrationIdentity;
  signal?: AbortSignal;
}

export interface RegistryTaskPolicyChangeChallenge extends RegistryTaskScope {
  readonly requestId: string;
  readonly teamId: string;
  readonly taskId: string;
  readonly expectedRegistrationIdentity: RegistryRegistrationIdentity;
  readonly policy: TaskPolicy;
  readonly payload: readonly (string | number | null)[];
  readonly callerIdentity: TaskIdentity;
  readonly proof: PolicyChangeProof & { requestId: string };
}

export interface RegistryTaskPolicyChangeInput {
  challenge: RegistryTaskPolicyChangeChallenge;
  signed: SignedTaskPayload;
  expectedRegistrationIdentity: RegistryRegistrationIdentity;
  beforeSend: (replay: RegistryTaskPolicyChangeReplayRecord) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface RegistryTaskPolicyChangeResult extends RegistryTaskScope {
  readonly outcome: 'APPLIED' | 'UNCHANGED';
  readonly requestId: string;
  readonly teamId: string;
  readonly taskId: string;
  readonly version: number;
  readonly digest: string;
}

export type RegistryTaskUpsertResult = RegistryTaskWriteResult | RegistryTaskGenesisChallengeResult;

/** Result of a status transition: a conflict throws instead of returning. */
export interface RegistryTaskStatusResult {
  outcome: 'APPLIED' | 'UNCHANGED';
  transitions: RegistryTaskTransition[];
}

export interface RegistryTaskScope {
  /** Registry project id, e.g. `stgmt/tokenplan`. */
  project: string;
  /** Spec slug, e.g. `balancer-consistency-hardening`. */
  spec: string;
}

export interface ListRegistryTasksInput extends RegistryTaskScope {
  /** Opaque server-issued identity for an isolated team task view. */
  teamId?: string;
  statuses?: readonly RegistryTaskStatus[];
  signal?: AbortSignal;
  includeBodies?: boolean;
}
export interface UpsertRegistryTaskInput extends RegistryTaskScope {
  teamId: string;
  /** `TASK-7` or a bare `7`; the registry owns the canonical spelling. */
  localId: string;
  title: string;
  /** FR/NFR/AC ids that must exist in the same spec. */
  requirements: readonly string[];
  body?: string;
  description?: string;
  creationToken?: string;
  /** Stable outer request ID used for both challenge and signed commit. */
  requestId?: string;
  /** Claim override is signed when supplied, and omission is preserved distinctly. */
  force?: boolean;
  /** Whitelisted initial selection sent as the upsert operation's `policy` field. */
  policy?: TaskPolicy;
  /** Durable caller identity; local validation only, never sent as a tool argument. */
  expectedRegistrationIdentity?: RegistryRegistrationIdentity;
  /** Server challenge paired with `genesisAttestations` for a durable exact replay. */
  genesisChallenge?: RegistryTaskGenesisChallenge;
  /** Persists the canonical signed request before it can reach the registry. */
  beforeGenesisAttestationSend?: (replay: RegistryTaskGenesisReplayRecord) => void | Promise<void>;
  /** Signed challenge proofs added only to the second exact-request call. */
  genesisAttestations?: readonly RegistryTaskGenesisAttestation[];
  status?: RegistryTaskStatus;
  owner?: string;
  tracking?: string;
  dependsOn?: readonly string[];
  refs?: readonly string[];
  /** Preimage of TASKS.md, required by callers creating a new numeric id. */
  expectedSha?: string;
  signal?: AbortSignal;
}

export interface ReplaceRegistryTaskStatusInput extends RegistryTaskScope {
  teamId: string;
  /** Task local id (`TASK-7`) or canonical id (`<spec>:TASK-7`). */
  entity: string;
  status: RegistryTaskStatus;
  /** Required: a blind status write would silently clobber a concurrent move. */
  expectedStatus: RegistryTaskStatus;
  signal?: AbortSignal;
}

export interface ReplaceRegistryTaskOwnerInput extends RegistryTaskScope {
  teamId: string;
  entity: string;
  owner: string | null;
  signal?: AbortSignal;
}

export interface ReplaceRegistryTaskLinksInput extends RegistryTaskScope {
  teamId: string;
  entity: string;
  requirements?: readonly string[];
  dependsOn?: readonly string[];
  refs?: readonly string[];
  expectedSha?: string;
  signal?: AbortSignal;
}

/** Envelope every registry tool returns; only the fields the client trusts. */
export interface RegistryToolEnvelope<TData> {
  schemaVersion: string | null;
  requestId: string | null;
  operation: string | null;
  ok: boolean;
  page: {
    limit: number | null;
    returned: number | null;
    totalMatched: number | null;
    cursor: string | null;
    nextCursor: string | null;
    truncated: boolean;
  } | null;
  data: TData | null;
  error: RegistryEnvelopeError | null;
  diagnostics: unknown[];
  provenance: unknown;
}

export interface RegistryEnvelopeError {
  code: string | null;
  message: string | null;
  retryable: boolean;
  parameter: string | null;
  expected: string | null;
  currentStatus: string | null;
  expectedStatus: string | null;
  localId: string | null;
  canonicalId: string | null;
  causeCode: string | null;
}

/** `spec_tasks` payload. */
export interface RegistryTasksPayload {
  kind: 'tasks';
  spec: string;
  tasks: RegistryTask[];
  count: number;
}

/** Parsed `spec_patch` result for the `patch` intent (one structured operation). */
export interface RegistryPatchPayload {
  schemaVersion: string;
  requestId: string | null;
  dryRun: boolean;
  proposalHash: string | null;
  outcome: RegistryTaskWriteOutcome;
  spec?: string;
  unchanged?: boolean;
  transitions: RegistryTaskTransition[];
  refusal: RegistryTaskRefusal | null;
  taskLifecycleReceipt?: RegistryTaskLifecycleReceipt;
}
