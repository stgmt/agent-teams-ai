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

/** Statuses the kernel accepts, in the registry's own spelling. */
export const REGISTRY_TASK_STATUSES = [
  'planned',
  'todo',
  'ready',
  'in-progress',
  'blocked',
  'done',
  'deferred',
  'unknown',
] as const;

export type RegistryTaskStatus = (typeof REGISTRY_TASK_STATUSES)[number];

/**
 * One task as the registry reports it. Canonical ids are namespaced
 * (`<spec>:TASK-7`); links (`dependsOn`, `blocks`, `blockedBy`,
 * `requirements`) are canonical ids of their own node kinds.
 */
export interface RegistryTask {
  canonicalId: string;
  localId: string;
  title: string;
  status: RegistryTaskStatus;
  owner: string | null;
  tracking: string | null;
  requirements: string[];
  dependsOn: string[];
  blocks: string[];
  blockedBy: string[];
  contentHash: string | null;
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
}

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
  statuses?: readonly RegistryTaskStatus[];
  signal?: AbortSignal;
}

export interface UpsertRegistryTaskInput extends RegistryTaskScope {
  /** `TASK-7` or a bare `7`; the registry owns the canonical spelling. */
  localId: string;
  title: string;
  /** FR/NFR/AC ids that must exist in the same spec. */
  requirements: readonly string[];
  body?: string;
  status?: RegistryTaskStatus;
  owner?: string;
  tracking?: string;
  dependsOn?: readonly string[];
  refs?: readonly string[];
  signal?: AbortSignal;
}

export interface ReplaceRegistryTaskStatusInput extends RegistryTaskScope {
  /** Task local id (`TASK-7`) or canonical id (`<spec>:TASK-7`). */
  entity: string;
  status: RegistryTaskStatus;
  /** Required: a blind status write would silently clobber a concurrent move. */
  expectedStatus: RegistryTaskStatus;
  signal?: AbortSignal;
}

export interface ReplaceRegistryTaskOwnerInput extends RegistryTaskScope {
  entity: string;
  owner: string;
  signal?: AbortSignal;
}

export interface ReplaceRegistryTaskLinksInput extends RegistryTaskScope {
  entity: string;
  requirements?: readonly string[];
  dependsOn?: readonly string[];
  refs?: readonly string[];
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
}
