/**
 * Canonical task writes for a registry-backed team.
 *
 * The spec registry owns the canonical half of a team task (`title`, `body`,
 * `status`, `owner`, links). This writer is the only place main is allowed to
 * change those fields once a team has `specProject` + `specSlug`: it never
 * touches `~/.claude/tasks`, so a second canonical source cannot appear.
 *
 * Execution half (work/review intervals, comments, attachments, history) stays
 * local and is written through {@link ExecutionTaskStore}.
 */

import { randomUUID } from 'node:crypto';

import {
  RegistryStatusConflictError,
  RegistryTaskClientError,
  RegistryTaskWriteRefusedError,
} from './RegistryTaskClientErrors';

import type { ExecutionTaskPatch, ExecutionTaskStore } from '../execution/ExecutionTaskStore';
import type {
  ListRegistryTasksInput,
  RegistryTask,
  RegistryTaskStatus,
  RegistryTaskStatusResult,
  RegistryTaskWriteResult,
  ReplaceRegistryTaskLinksInput,
  ReplaceRegistryTaskOwnerInput,
  ReplaceRegistryTaskStatusInput,
  RegistryTaskTransition,
  UpsertRegistryTaskInput,
} from './RegistryTaskClientTypes';
import { REGISTRY_TASK_STATUSES } from './RegistryTaskClientTypes';
import type { TeamSpecBinding } from './TeamSpecBinding';
import type {
  TaskAttachmentMeta,
  TaskComment,
  TaskHistoryEvent,
  TaskRef,
  TaskWorkInterval,
  TeamTask,
  TeamTaskStatus,
} from '@shared/types';

/** The slice of the registry task client the writer needs. */
export interface RegistryTeamTaskClientPort {
  listTasks(input: ListRegistryTasksInput): Promise<RegistryTask[]>;
  upsertTask(input: UpsertRegistryTaskInput): Promise<RegistryTaskWriteResult>;
  replaceTaskStatus(input: ReplaceRegistryTaskStatusInput): Promise<RegistryTaskStatusResult>;
  replaceTaskOwner(input: ReplaceRegistryTaskOwnerInput): Promise<RegistryTaskWriteResult>;
  replaceTaskLinks(input: ReplaceRegistryTaskLinksInput): Promise<RegistryTaskWriteResult>;
}

export type RegistryTeamTaskWriteErrorCode =
  | 'REQUIREMENTS_REQUIRED'
  | 'LOCAL_ID_TAKEN'
  | 'TASK_NOT_FOUND'
  | 'STATUS_CONFLICT'
  | 'STATUS_UNSUPPORTED'
  | 'OWNER_CLEAR_UNSUPPORTED'
  | 'LINK_CYCLE'
  | 'REGISTRY_REFUSED'
  | 'OPERATION_UNSUPPORTED';

/**
 * Typed failure of a canonical write. `code` is stable; the message is safe to
 * show in the renderer and never contains registry tokens.
 */
export class RegistryTeamTaskWriteError extends Error {
  readonly code: RegistryTeamTaskWriteErrorCode;
  readonly taskId: string | null;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: RegistryTeamTaskWriteErrorCode,
    message: string,
    options: {
      taskId?: string | null;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RegistryTeamTaskWriteError';
    this.code = code;
    this.taskId = options.taskId ?? null;
    this.details = options.details ?? {};
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const TEAM_TO_REGISTRY_STATUS: Record<Exclude<TeamTaskStatus, 'deleted'>, RegistryTaskStatus> = {
  pending: 'todo',
  in_progress: 'in-progress',
  completed: 'done',
};

const REGISTRY_TO_TEAM_STATUS: Record<RegistryTaskStatus, TeamTaskStatus> = {
  planned: 'pending',
  todo: 'pending',
  ready: 'pending',
  'in-progress': 'in_progress',
  blocked: 'pending',
  done: 'completed',
  deferred: 'pending',
  unknown: 'pending',
};

const LOCAL_TASK_ID_PATTERN = /^(?:TASK-)?(\d+)$/i;

/** `TASK-7` / `7` / `<spec>:TASK-7` → `7`; anything else → `null`. */
function normalizeLocalId(value: string): string | null {
  const trimmed = value.trim();
  const match = LOCAL_TASK_ID_PATTERN.exec(trimmed);
  if (match) return match[1];
  const namespaced = /^[^:]+:TASK-(\d+)$/i.exec(trimmed);
  return namespaced ? namespaced[1] : null;
}

function canonicalTaskRef(spec: string, localId: string): string {
  return `${spec}:TASK-${localId}`;
}

/** `refs` may hold non-task nodes; only `<this spec>:TASK-n` links map to a team task id. */
function localIdFromRef(spec: string, ref: string): string | null {
  const match = /^([^:]+):TASK-(\d+)$/i.exec(ref.trim());
  if (match?.[1] !== spec) return null;
  return match[2];
}

function toRegistryStatusOrThrow(
  status: TeamTaskStatus,
  taskId: string | null
): RegistryTaskStatus {
  if (status === 'deleted') {
    throw new RegistryTeamTaskWriteError(
      'STATUS_UNSUPPORTED',
      'The spec registry has no "deleted" status; trashed tasks stay a local concept. Reopen or defer the task in the registry instead.',
      { taskId }
    );
  }
  return TEAM_TO_REGISTRY_STATUS[status];
}

function refusalToWriteError(
  error: RegistryTaskWriteRefusedError,
  operation: string,
  taskId: string | null
): RegistryTeamTaskWriteError {
  return new RegistryTeamTaskWriteError(
    'REGISTRY_REFUSED',
    `The spec registry refused ${operation}: ${error.message}`,
    {
      taskId,
      details: {
        registryCode: error.refusal.code,
        retryable: error.refusal.retryable,
        currentStatus: error.refusal.currentStatus,
      },
      cause: error,
    }
  );
}

/** Client failures stay typed; unknown values must not look like a successful write. */
function toTypedWriteError(
  error: unknown,
  operation: string,
  taskId: string | null
): RegistryTeamTaskWriteError {
  if (error instanceof RegistryTeamTaskWriteError) return error;
  if (error instanceof RegistryTaskWriteRefusedError) {
    return refusalToWriteError(error, operation, taskId);
  }
  if (error instanceof RegistryTaskClientError) {
    return new RegistryTeamTaskWriteError(
      'REGISTRY_REFUSED',
      `The spec registry did not confirm ${operation}: ${error.message}`,
      {
        taskId,
        details: { clientCode: error.code, retryable: error.retryable },
        cause: error,
      }
    );
  }
  return new RegistryTeamTaskWriteError(
    'REGISTRY_REFUSED',
    `The spec registry did not confirm ${operation}: ${error instanceof Error ? error.message : String(error)}`,
    { taskId, cause: error }
  );
}

export interface RegistryTeamTaskCreateInput {
  subject: string;
  description?: string;
  /** FR/NFR/AC ids; mandatory — the registry refuses tasks without them. */
  requirements: readonly string[];
  tracking?: string;
  owner?: string;
  blockedBy?: readonly string[];
  related?: readonly string[];
  startImmediately?: boolean;
  groupChatId?: string;
  descriptionTaskRefs?: TaskRef[];
  prompt?: string;
  promptTaskRefs?: TaskRef[];
  projectPath?: string;
  /** Stable for one user intent so a retried creation cannot create a second task. */
  commandIdempotencyKey?: string;
}

export interface RegistryTeamTaskWriterOptions {
  teamName: string;
  binding: TeamSpecBinding;
  client: RegistryTeamTaskClientPort;
  executionStore: ExecutionTaskStore;
  clock?: () => Date;
  /** How long a read stays usable as `expectedStatus`. */
  statusCacheTtlMs?: number;
}

const DEFAULT_STATUS_CACHE_TTL_MS = 5_000;

export class RegistryTeamTaskWriter {
  readonly #teamName: string;
  readonly #binding: TeamSpecBinding;
  readonly #client: RegistryTeamTaskClientPort;
  readonly #executionStore: ExecutionTaskStore;
  readonly #clock: () => Date;
  readonly #statusCacheTtlMs: number;

  #listingCache: { at: number; tasks: RegistryTask[] } | null = null;
  #writeChain: Promise<unknown> = Promise.resolve();
  readonly #createdByCommandKey = new Map<string, string>();

  constructor(options: RegistryTeamTaskWriterOptions) {
    this.#teamName = options.teamName;
    this.#binding = options.binding;
    this.#client = options.client;
    this.#executionStore = options.executionStore;
    this.#clock = options.clock ?? (() => new Date());
    this.#statusCacheTtlMs = options.statusCacheTtlMs ?? DEFAULT_STATUS_CACHE_TTL_MS;
  }

  get binding(): TeamSpecBinding {
    return this.#binding;
  }

  /** Serialises canonical writes: id allocation and read-modify-write links race otherwise. */
  #withWriteLock<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#writeChain.then(run, run);
    this.#writeChain = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  async #list(force = false): Promise<RegistryTask[]> {
    const now = this.#clock().getTime();
    if (!force && this.#listingCache && now - this.#listingCache.at <= this.#statusCacheTtlMs) {
      return this.#listingCache.tasks;
    }
    // Allocation and lookups must see finished tasks too: an active-only list
    // would hand out the id of a `done` task and the registry would refuse it.
    const tasks = await this.#client.listTasks({
      project: this.#binding.project,
      spec: this.#binding.spec,
      statuses: [...REGISTRY_TASK_STATUSES],
    });
    this.#listingCache = { at: now, tasks };
    return tasks;
  }

  /**
   * One task as the registry currently has it.
   *
   * `force` bypasses the short read cache for read-modify-write operations
   * (links, canonical fields, owner), where a stale base would silently drop a
   * concurrent edit. Status transitions deliberately use the cached last read:
   * a lost race must surface as a typed conflict, not be papered over.
   */
  async readCanonicalTask(
    taskId: string,
    options: { force?: boolean } = {}
  ): Promise<RegistryTask> {
    const localId = normalizeLocalId(taskId);
    if (localId === null) {
      throw new RegistryTeamTaskWriteError(
        'TASK_NOT_FOUND',
        `"${taskId}" is not a task id of spec ${this.#binding.spec}`,
        { taskId }
      );
    }
    const tasks = await this.#list(options.force === true);
    const found = tasks.find((candidate) => normalizeLocalId(candidate.localId) === localId);
    if (!found) {
      throw new RegistryTeamTaskWriteError(
        'TASK_NOT_FOUND',
        `Task #${localId} does not exist in ${this.#binding.project}/${this.#binding.spec}`,
        { taskId: localId }
      );
    }
    return found;
  }

  async createTask(
    input: RegistryTeamTaskCreateInput
  ): Promise<{ task: TeamTask; createdInAttempt: boolean }> {
    const requirements = [...new Set((input.requirements ?? []).map((id) => id.trim()))].filter(
      Boolean
    );
    if (requirements.length === 0) {
      throw new RegistryTeamTaskWriteError(
        'REQUIREMENTS_REQUIRED',
        'Tasks of a spec-registry team must name the requirements they implement (FR/NFR/AC ids).',
        { details: { spec: this.#binding.spec } }
      );
    }
    return this.#withWriteLock(async () => {
      const commandKey = input.commandIdempotencyKey?.trim();
      if (commandKey) {
        const existingId = this.#createdByCommandKey.get(commandKey);
        if (existingId) {
          const existing = await this.readCanonicalTask(existingId);
          return { task: this.#toTeamTask(existing, input), createdInAttempt: false };
        }
      }

      const tasks = await this.#list(true);
      const localId = this.#allocateLocalId(tasks);
      const started = Boolean(input.startImmediately && input.owner);
      const status: RegistryTaskStatus = started ? 'in-progress' : 'todo';
      const createdAt = this.#clock().toISOString();

      try {
        const result = await this.#client.upsertTask({
          project: this.#binding.project,
          spec: this.#binding.spec,
          localId,
          title: input.subject.trim(),
          requirements,
          ...(input.description?.trim() ? { body: input.description.trim() } : {}),
          status,
          ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
          ...(input.tracking?.trim() ? { tracking: input.tracking.trim() } : {}),
          dependsOn: this.#taskRefs(input.blockedBy),
          refs: this.#taskRefs(input.related),
        });
        if (result.outcome === 'REFUSED') {
          throw new RegistryTeamTaskWriteError(
            'REGISTRY_REFUSED',
            `The spec registry refused to create task #${localId}: ${result.refusal?.message ?? 'no reason given'}`,
            {
              taskId: localId,
              details: { registryCode: result.refusal?.code ?? null },
            }
          );
        }
      } catch (error) {
        throw toTypedWriteError(error, 'upsertTask', localId);
      }

      this.#listingCache = null;
      if (commandKey) this.#createdByCommandKey.set(commandKey, localId);

      const task: TeamTask = {
        id: localId,
        displayId: `#${localId}`,
        subject: input.subject.trim(),
        ...(input.description?.trim() ? { description: input.description.trim() } : {}),
        ...(input.groupChatId ? { groupChatId: input.groupChatId } : {}),
        ...(input.descriptionTaskRefs?.length
          ? { descriptionTaskRefs: input.descriptionTaskRefs }
          : {}),
        ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
        ...(input.promptTaskRefs?.length ? { promptTaskRefs: input.promptTaskRefs } : {}),
        ...(input.owner?.trim() ? { owner: input.owner.trim() } : {}),
        createdBy: 'user',
        status: REGISTRY_TO_TEAM_STATUS[status],
        ...(input.blockedBy?.length ? { blockedBy: this.#localIds(input.blockedBy) } : {}),
        ...(input.related?.length ? { related: this.#localIds(input.related) } : {}),
        ...(input.projectPath ? { projectPath: input.projectPath } : {}),
        createdAt,
        updatedAt: createdAt,
      };

      const createdEvent: TaskHistoryEvent = {
        id: randomUUID(),
        timestamp: createdAt,
        type: 'task_created',
        status: task.status,
        actor: 'user',
      };
      this.#recordExecution(localId, {
        workIntervals: started ? [{ startedAt: createdAt }] : [],
        historyEvents: [createdEvent],
      });

      return { task: { ...task, ...this.#executionFields(localId) }, createdInAttempt: true };
    });
  }

  /** Status transition through `replace_task_status` with the last read as `expectedStatus`. */
  async replaceStatus(input: { taskId: string; to: TeamTaskStatus; actor?: string }): Promise<{
    outcome: 'APPLIED' | 'UNCHANGED';
    transitions: readonly RegistryTaskTransition[];
  }> {
    const target = toRegistryStatusOrThrow(input.to, input.taskId);
    return this.#withWriteLock(async () => {
      const current = await this.readCanonicalTask(input.taskId);
      const localId = normalizeLocalId(current.localId) ?? current.localId;
      if (REGISTRY_TO_TEAM_STATUS[current.status] === input.to)
        return { outcome: 'UNCHANGED', transitions: [] };
      let transitions: readonly RegistryTaskTransition[] = [];
      try {
        const result = await this.#client.replaceTaskStatus({
          project: this.#binding.project,
          spec: this.#binding.spec,
          entity: localId,
          status: target,
          expectedStatus: current.status,
        });
        transitions = result.transitions;
      } catch (error) {
        if (error instanceof RegistryStatusConflictError) {
          this.#listingCache = null;
          throw new RegistryTeamTaskWriteError(
            'STATUS_CONFLICT',
            `Task #${localId} changed in the spec registry (now "${error.currentStatus ?? 'unknown'}", this app read "${current.status}"). Re-read the task and retry.`,
            {
              taskId: localId,
              details: {
                currentStatus: error.currentStatus,
                expectedStatus: current.status,
              },
              cause: error,
            }
          );
        }
        throw toTypedWriteError(error, 'replaceTaskStatus', localId);
      }
      this.#listingCache = null;
      this.#applyStatusToExecution(localId, current.status, input.to, input.actor);
      return { outcome: 'APPLIED', transitions };
    });
  }

  /** Owner change through `replace_task_owner`. Clearing an owner is not a registry operation. */
  async replaceOwner(input: {
    taskId: string;
    owner: string | null;
  }): Promise<'APPLIED' | 'UNCHANGED'> {
    const owner = input.owner?.trim() ?? '';
    if (!owner) {
      throw new RegistryTeamTaskWriteError(
        'OWNER_CLEAR_UNSUPPORTED',
        'The spec registry cannot clear a task owner; assign it to another member instead.',
        { taskId: input.taskId }
      );
    }
    return this.#withWriteLock(async () => {
      const current = await this.readCanonicalTask(input.taskId, { force: true });
      const localId = normalizeLocalId(current.localId) ?? current.localId;
      const previous = current.owner?.trim() || undefined;
      if (previous === owner) return 'UNCHANGED';
      try {
        const result = await this.#client.replaceTaskOwner({
          project: this.#binding.project,
          spec: this.#binding.spec,
          entity: localId,
          owner,
        });
        if (result.outcome === 'REFUSED') {
          throw new RegistryTeamTaskWriteError(
            'REGISTRY_REFUSED',
            `The spec registry refused to change the owner of task #${localId}: ${result.refusal?.message ?? 'no reason given'}`,
            { taskId: localId, details: { registryCode: result.refusal?.code ?? null } }
          );
        }
      } catch (error) {
        throw toTypedWriteError(error, 'replaceTaskOwner', localId);
      }
      this.#listingCache = null;
      const ownerEvent: TaskHistoryEvent = {
        id: randomUUID(),
        timestamp: this.#clock().toISOString(),
        type: 'owner_changed',
        ...(previous ? { from: previous } : {}),
        to: owner,
        actor: 'user',
      };
      this.#recordExecution(localId, {
        historyEvents: [
          ...(this.#executionStore.read(this.#teamName, localId)?.historyEvents ?? []),
          ownerEvent,
        ],
      });
      return 'APPLIED';
    });
  }

  /** Adds a link; `blocks` is the inverse of `blockedBy`, exactly like the file writer. */
  async addLink(input: {
    taskId: string;
    targetId: string;
    type: 'blockedBy' | 'blocks' | 'related';
  }): Promise<void> {
    if (input.taskId === input.targetId) {
      throw new RegistryTeamTaskWriteError('LINK_CYCLE', 'Cannot link a task to itself', {
        taskId: input.taskId,
      });
    }
    if (input.type === 'blocks') {
      await this.addLink({
        taskId: input.targetId,
        targetId: input.taskId,
        type: 'blockedBy',
      });
      return;
    }
    await this.#withWriteLock(async () => {
      const current = await this.readCanonicalTask(input.taskId, { force: true });
      const localId = normalizeLocalId(current.localId) ?? current.localId;
      const targetLocalId = normalizeLocalId(input.targetId);
      if (targetLocalId === null) {
        throw new RegistryTeamTaskWriteError(
          'LINK_CYCLE',
          `"${input.targetId}" is not a task id of spec ${this.#binding.spec}`,
          { taskId: localId }
        );
      }
      const targetRef = canonicalTaskRef(this.#binding.spec, targetLocalId);
      if (input.type === 'blockedBy') {
        const tasks = await this.#list();
        this.#assertNoDependencyCycle(tasks, localId, targetRef);
        const dependsOn = [...new Set([...current.dependsOn, targetRef])];
        await this.#replaceLinks(localId, { dependsOn });
        return;
      }
      const refs = [...new Set([...current.refs, targetRef])];
      await this.#replaceLinks(localId, { refs });
    });
  }

  async removeLink(input: {
    taskId: string;
    targetId: string;
    type: 'blockedBy' | 'blocks' | 'related';
  }): Promise<void> {
    if (input.type === 'blocks') {
      await this.removeLink({
        taskId: input.targetId,
        targetId: input.taskId,
        type: 'blockedBy',
      });
      return;
    }
    await this.#withWriteLock(async () => {
      const current = await this.readCanonicalTask(input.taskId, { force: true });
      const localId = normalizeLocalId(current.localId) ?? current.localId;
      const targetLocalId = normalizeLocalId(input.targetId);
      if (targetLocalId === null) return;
      if (input.type === 'blockedBy') {
        await this.#replaceLinks(localId, {
          dependsOn: current.dependsOn.filter(
            (ref) => localIdFromRef(this.#binding.spec, ref) !== targetLocalId
          ),
        });
        return;
      }
      await this.#replaceLinks(localId, {
        refs: current.refs.filter(
          (ref) => localIdFromRef(this.#binding.spec, ref) !== targetLocalId
        ),
      });
    });
  }

  /** `subject`/`description` are canonical (`title`/`body`): idempotent upsert, never a file write. */
  async updateCanonicalFields(input: {
    taskId: string;
    subject?: string;
    description?: string;
  }): Promise<void> {
    if (input.subject === undefined && input.description === undefined) return;
    await this.#withWriteLock(async () => {
      const current = await this.readCanonicalTask(input.taskId, { force: true });
      const localId = normalizeLocalId(current.localId) ?? current.localId;
      const title = input.subject?.trim() || current.title;
      try {
        const result = await this.#client.upsertTask({
          project: this.#binding.project,
          spec: this.#binding.spec,
          localId,
          title,
          requirements: current.requirements,
          ...(input.description === undefined ? {} : { body: input.description.trim() }),
        });
        if (result.outcome === 'REFUSED') {
          throw new RegistryTeamTaskWriteError(
            'REGISTRY_REFUSED',
            `The spec registry refused to update task #${localId}: ${result.refusal?.message ?? 'no reason given'}`,
            { taskId: localId, details: { registryCode: result.refusal?.code ?? null } }
          );
        }
      } catch (error) {
        throw toTypedWriteError(error, 'upsertTask', localId);
      }
      this.#listingCache = null;
    });
  }

  async appendUserComment(
    taskId: string,
    text: string,
    attachments?: TaskAttachmentMeta[],
    taskRefs?: TaskRef[]
  ): Promise<TaskComment> {
    const localId = normalizeLocalId(taskId);
    if (localId === null) {
      throw new RegistryTeamTaskWriteError('TASK_NOT_FOUND', `"${taskId}" is not a task id`, {
        taskId,
      });
    }
    const comment: TaskComment = {
      id: randomUUID(),
      author: 'user',
      text,
      createdAt: this.#clock().toISOString(),
      type: 'regular',
      ...(taskRefs && taskRefs.length > 0 ? { taskRefs } : {}),
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    this.#executionStore.addComment(this.#teamName, localId, comment);
    return comment;
  }

  addAttachment(taskId: string, meta: TaskAttachmentMeta): void {
    const localId = this.#requireLocalId(taskId);
    this.#executionStore.addAttachmentMeta(this.#teamName, localId, meta);
  }

  removeAttachment(taskId: string, attachmentId: string): void {
    const localId = this.#requireLocalId(taskId);
    const record = this.#executionStore.read(this.#teamName, localId);
    if (!record) return;
    const attachments = record.attachments.filter((entry) => entry.id !== attachmentId);
    this.#executionStore.write(this.#teamName, localId, { attachments });
  }

  setNeedsClarification(taskId: string, value: 'lead' | 'user' | null): void {
    const localId = this.#requireLocalId(taskId);
    this.#executionStore.write(this.#teamName, localId, { needsClarification: value });
  }

  #requireLocalId(taskId: string): string {
    const localId = normalizeLocalId(taskId);
    if (localId === null) {
      throw new RegistryTeamTaskWriteError('TASK_NOT_FOUND', `"${taskId}" is not a task id`, {
        taskId,
      });
    }
    return localId;
  }

  #allocateLocalId(tasks: readonly RegistryTask[]): string {
    let max = 0;
    for (const task of tasks) {
      const parsed = normalizeLocalId(task.localId);
      if (parsed !== null) max = Math.max(max, Number.parseInt(parsed, 10));
    }
    const next = String(max + 1);
    if (tasks.some((task) => normalizeLocalId(task.localId) === next)) {
      throw new RegistryTeamTaskWriteError(
        'LOCAL_ID_TAKEN',
        `Task #${next} already exists in ${this.#binding.project}/${this.#binding.spec}`,
        { taskId: next }
      );
    }
    return next;
  }

  #taskRefs(taskIds: readonly string[] | undefined): string[] {
    return this.#localIds(taskIds).map((value) => canonicalTaskRef(this.#binding.spec, value));
  }

  #localIds(taskIds: readonly string[] | undefined): string[] {
    return [
      ...new Set(
        (taskIds ?? [])
          .map((value) => normalizeLocalId(value))
          .filter((value): value is string => value !== null)
      ),
    ];
  }

  /** Walks the target's dependency chain; a reachable source means the write would close a cycle. */
  #assertNoDependencyCycle(
    tasks: readonly RegistryTask[],
    sourceLocalId: string,
    targetRef: string
  ): void {
    const byLocalId = new Map<string, RegistryTask>();
    for (const task of tasks) {
      const parsed = normalizeLocalId(task.localId);
      if (parsed !== null) byLocalId.set(parsed, task);
    }
    const visited = new Set<string>();
    const stack = [localIdFromRef(this.#binding.spec, targetRef)].filter(
      (value): value is string => value !== null
    );
    while (stack.length > 0) {
      const currentId = stack.pop()!;
      if (currentId === sourceLocalId) {
        throw new RegistryTeamTaskWriteError(
          'LINK_CYCLE',
          `Circular dependency: #${targetRef} already depends on #${sourceLocalId}`,
          { taskId: sourceLocalId }
        );
      }
      if (visited.has(currentId)) continue;
      visited.add(currentId);
      const task = byLocalId.get(currentId);
      if (!task) continue;
      for (const ref of task.dependsOn) {
        const dependency = localIdFromRef(this.#binding.spec, ref);
        if (dependency !== null) stack.push(dependency);
      }
    }
  }

  async #replaceLinks(
    localId: string,
    links: { dependsOn?: string[]; refs?: string[] }
  ): Promise<void> {
    try {
      const result = await this.#client.replaceTaskLinks({
        project: this.#binding.project,
        spec: this.#binding.spec,
        entity: localId,
        ...links,
      });
      if (result.outcome === 'REFUSED') {
        throw new RegistryTeamTaskWriteError(
          'REGISTRY_REFUSED',
          `The spec registry refused to update the links of task #${localId}: ${result.refusal?.message ?? 'no reason given'}`,
          { taskId: localId, details: { registryCode: result.refusal?.code ?? null } }
        );
      }
    } catch (error) {
      throw toTypedWriteError(error, 'replaceTaskLinks', localId);
    }
    this.#listingCache = null;
  }

  #applyStatusToExecution(
    localId: string,
    fromRegistryStatus: RegistryTaskStatus,
    to: TeamTaskStatus,
    actor: string | undefined
  ): void {
    const from = REGISTRY_TO_TEAM_STATUS[fromRegistryStatus];
    const nowIso = this.#clock().toISOString();
    const record = this.#executionStore.read(this.#teamName, localId);
    const intervals: TaskWorkInterval[] = [...(record?.workIntervals ?? [])];
    const last = intervals.length > 0 ? intervals[intervals.length - 1] : undefined;
    if (from !== 'in_progress' && to === 'in_progress') {
      if (!last || last.completedAt !== undefined) intervals.push({ startedAt: nowIso });
    } else if (from === 'in_progress' && to !== 'in_progress') {
      if (last && last.completedAt === undefined) last.completedAt = nowIso;
    }
    const statusEvent: TaskHistoryEvent = {
      id: randomUUID(),
      timestamp: nowIso,
      type: 'status_changed',
      from,
      to,
      ...(actor ? { actor } : {}),
    };
    this.#recordExecution(localId, {
      workIntervals: intervals,
      historyEvents: [...(record?.historyEvents ?? []), statusEvent],
    });
  }

  #recordExecution(localId: string, patch: ExecutionTaskPatch): void {
    this.#executionStore.write(this.#teamName, localId, patch);
  }

  #executionFields(localId: string): Partial<TeamTask> {
    const record = this.#executionStore.read(this.#teamName, localId);
    if (!record) return {};
    return {
      ...(record.workIntervals.length > 0 ? { workIntervals: record.workIntervals } : {}),
      ...(record.reviewIntervals.length > 0 ? { reviewIntervals: record.reviewIntervals } : {}),
      ...(record.comments.length > 0 ? { comments: record.comments } : {}),
      ...(record.attachments.length > 0 ? { attachments: record.attachments } : {}),
      ...(record.historyEvents.length > 0 ? { historyEvents: record.historyEvents } : {}),
      ...(record.needsClarification ? { needsClarification: record.needsClarification } : {}),
      updatedAt: record.updatedAt,
    };
  }

  /** Projection used right after creation and for idempotent replays. */
  #toTeamTask(current: RegistryTask, input: RegistryTeamTaskCreateInput): TeamTask {
    const localId = normalizeLocalId(current.localId) ?? current.localId;
    return {
      id: localId,
      displayId: `#${localId}`,
      subject: current.title,
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
      ...(input.groupChatId ? { groupChatId: input.groupChatId } : {}),
      ...(input.descriptionTaskRefs?.length
        ? { descriptionTaskRefs: input.descriptionTaskRefs }
        : {}),
      ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
      ...(input.promptTaskRefs?.length ? { promptTaskRefs: input.promptTaskRefs } : {}),
      ...(current.owner ? { owner: current.owner } : {}),
      createdBy: 'user',
      status: REGISTRY_TO_TEAM_STATUS[current.status],
      ...(current.blockedBy.length > 0 ? { blockedBy: this.#linkLocalIds(current.blockedBy) } : {}),
      ...(current.blocks.length > 0 ? { blocks: this.#linkLocalIds(current.blocks) } : {}),
      ...(current.refs.length > 0 ? { related: this.#linkLocalIds(current.refs) } : {}),
      ...(input.projectPath ? { projectPath: input.projectPath } : {}),
      ...this.#executionFields(localId),
    };
  }

  #linkLocalIds(refs: readonly string[]): string[] {
    return [
      ...new Set(
        refs
          .map((ref) => localIdFromRef(this.#binding.spec, ref))
          .filter((value): value is string => value !== null)
      ),
    ];
  }
}
