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

import { getReviewStateFromTask } from '@shared/utils/reviewState';

import { TaskCreationJournal } from '../execution/TaskCreationJournal';

import { RegistryStatusConflictError } from './RegistryTaskClientErrors';
import { REGISTRY_TASK_STATUSES } from './RegistryTaskClientTypes';
import {
  canonicalTaskRef,
  localIdFromRef,
  normalizeLocalId,
  REGISTRY_TO_TEAM_STATUS,
  TEAM_TO_REGISTRY_STATUS,
} from './RegistryTaskIdentity';
import { RegistryTeamTaskCreator } from './RegistryTeamTaskCreator';
import { RegistryTeamTaskWriteError, toTypedWriteError } from './RegistryTeamTaskWriteErrors';

import type { ExecutionTaskPatch, ExecutionTaskStore } from '../execution/ExecutionTaskStore';
import type {
  ListRegistryTasksInput,
  RegistryTask,
  RegistryTaskStatus,
  RegistryTaskStatusResult,
  RegistryTaskTransition,
  RegistryTaskWriteResult,
  ReplaceRegistryTaskLinksInput,
  ReplaceRegistryTaskOwnerInput,
  ReplaceRegistryTaskStatusInput,
  UpsertRegistryTaskInput,
} from './RegistryTaskClientTypes';
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

export { RegistryTeamTaskWriteError };
export type { RegistryTeamTaskWriteErrorCode } from './RegistryTeamTaskWriteErrors';

/** The slice of the registry task client the writer needs. */
export interface RegistryTeamTaskClientPort {
  readTasksDocumentSha(input: { project: string; spec: string }): Promise<string>;
  listTasks(input: ListRegistryTasksInput): Promise<RegistryTask[]>;
  confirmTaskCreation(input: {
    project: string;
    spec: string;
    entity: string;
    creationToken: string;
  }): Promise<boolean>;
  upsertTask(input: UpsertRegistryTaskInput): Promise<RegistryTaskWriteResult>;
  replaceTaskStatus(input: ReplaceRegistryTaskStatusInput): Promise<RegistryTaskStatusResult>;
  replaceTaskOwner(input: ReplaceRegistryTaskOwnerInput): Promise<RegistryTaskWriteResult>;
  replaceTaskLinks(input: ReplaceRegistryTaskLinksInput): Promise<RegistryTaskWriteResult>;
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
  status?: TeamTaskStatus;
  actor?: string;
  executionPatch?: ExecutionTaskPatch;
  commandId?: string;
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
  readonly #creationJournal: TaskCreationJournal;
  readonly #taskCreator: RegistryTeamTaskCreator;

  constructor(options: RegistryTeamTaskWriterOptions) {
    this.#teamName = options.teamName;
    this.#binding = options.binding;
    this.#client = options.client;
    this.#executionStore = options.executionStore;
    this.#creationJournal = new TaskCreationJournal(
      options.executionStore.getTeamPath(options.teamName)
    );
    this.#clock = options.clock ?? (() => new Date());
    this.#statusCacheTtlMs = options.statusCacheTtlMs ?? DEFAULT_STATUS_CACHE_TTL_MS;
    this.#taskCreator = new RegistryTeamTaskCreator({
      teamName: this.#teamName,
      binding: this.#binding,
      client: this.#client,
      executionStore: this.#executionStore,
      clock: this.#clock,
      journal: this.#creationJournal,
      listTasks: (force) => this.#list(force),
      readCanonicalTask: (taskId, readOptions) => this.readCanonicalTask(taskId, readOptions),
      invalidateListingCache: () => {
        this.#listingCache = null;
      },
    });
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
      includeBodies: true,
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

  async applyExecutionPatch(taskId: string, patch: ExecutionTaskPatch): Promise<void> {
    const task = await this.readCanonicalTask(taskId);
    const localId = normalizeLocalId(task.localId) ?? task.localId;
    this.#executionStore.write(this.#teamName, localId, patch);
  }

  async createTask(
    input: RegistryTeamTaskCreateInput,
    beforeCreate?: () => Promise<void>
  ): Promise<{ task: TeamTask; createdInAttempt: boolean }> {
    return this.#withWriteLock(this.#taskCreator.prepareTask(input, beforeCreate));
  }

  /** Status transition through `replace_task_status` with the last read as `expectedStatus`. */
  async replaceStatus(input: {
    taskId: string;
    to: TeamTaskStatus;
    actor?: string;
    expectedStatus?: TeamTaskStatus;
  }): Promise<{
    outcome: 'APPLIED' | 'UNCHANGED';
    transitions: readonly RegistryTaskTransition[];
  }> {
    const target = TEAM_TO_REGISTRY_STATUS[input.to];
    return this.#withWriteLock(async () => {
      const current = await this.readCanonicalTask(input.taskId, {
        force: input.expectedStatus !== undefined,
      });
      const localId = normalizeLocalId(current.localId) ?? current.localId;
      if (
        input.expectedStatus !== undefined &&
        REGISTRY_TO_TEAM_STATUS[current.status] !== input.expectedStatus
      ) {
        throw new RegistryTeamTaskWriteError(
          'STATUS_CONFLICT',
          `Task #${localId} has changed status. Re-read the task and retry.`,
          {
            taskId: localId,
            details: {
              currentStatus: REGISTRY_TO_TEAM_STATUS[current.status],
              expectedStatus: input.expectedStatus,
            },
          }
        );
      }
      if (
        current.status === 'deleted' &&
        input.to !== 'deleted' &&
        input.expectedStatus !== 'deleted'
      ) {
        throw new RegistryTeamTaskWriteError(
          'STATUS_CONFLICT',
          `Task #${localId} is deleted; restore it before changing status.`,
          {
            taskId: localId,
            details: { currentStatus: 'deleted', expectedStatus: input.expectedStatus },
          }
        );
      }
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
        if (result.outcome === 'UNCHANGED') {
          this.#listingCache = null;
          return { outcome: 'UNCHANGED', transitions: result.transitions };
        }
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

  /** Owner change through `replace_task_owner`, including explicit unassignment. */
  async replaceOwner(input: {
    taskId: string;
    owner: string | null;
    actor?: string;
  }): Promise<'APPLIED' | 'UNCHANGED'> {
    const owner = input.owner?.trim() || null;
    return this.#withWriteLock(async () => {
      const current = await this.readCanonicalTask(input.taskId, { force: true });
      const localId = normalizeLocalId(current.localId) ?? current.localId;
      const previous = current.owner?.trim() || null;
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
        if (result.outcome === 'UNCHANGED') {
          this.#listingCache = null;
          return 'UNCHANGED';
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
        ...(owner ? { to: owner } : {}),
        actor: input.actor ?? 'user',
      };
      this.#executionStore.appendHistoryEvent(this.#teamName, localId, ownerEvent);
      return 'APPLIED';
    });
  }

  /** Adds a link; `blocks` is the inverse of `blockedBy`, exactly like the file writer. */
  async addLink(input: {
    taskId: string;
    targetId: string;
    type: 'blockedBy' | 'blocks' | 'related';
  }): Promise<void> {
    if (this.#requireLocalId(input.taskId) === this.#requireLocalId(input.targetId)) {
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
      const allTasks = await this.#list();
      if (!allTasks.some((task) => normalizeLocalId(task.localId) === targetLocalId)) {
        throw new RegistryTeamTaskWriteError(
          'TASK_NOT_FOUND',
          `Task #${targetLocalId} does not exist in this spec`,
          { taskId: targetLocalId }
        );
      }
      const targetRef = canonicalTaskRef(this.#binding.spec, targetLocalId);
      if (input.type === 'blockedBy') {
        this.#assertNoDependencyCycle(allTasks, localId, targetRef);
        const dependsOn = [...new Set([...current.dependsOn, targetRef])];
        await this.#replaceLinks(localId, { dependsOn });
        return;
      }
      await this.#setRelatedPair(localId, targetLocalId, true);
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
      await this.#setRelatedPair(localId, targetLocalId, false);
    });
  }

  /** `subject`/`description` are canonical: idempotent upsert, never a file write. */
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
          ...(input.description === undefined ? {} : { description: input.description }),
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
    const current = await this.readCanonicalTask(taskId);
    const localId = this.#requireLocalId(current.localId);
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

  /** Appends a message-linked execution comment without replacing concurrent comments. */
  async appendLinkedMessageComment(taskId: string, comment: TaskComment): Promise<boolean> {
    const current = await this.readCanonicalTask(taskId, { force: true });
    if (current.status === 'deleted') return false;
    const localId = this.#requireLocalId(current.localId);
    return this.#executionStore.addCommentIfAbsent(this.#teamName, localId, comment).added;
  }

  async transitionReview(input: {
    taskId: string;
    action: 'request' | 'approve' | 'changes' | 'clear';
    actor: string;
    reviewer?: string;
    note?: string;
    taskRefs?: TaskRef[];
    manual?: boolean;
  }): Promise<void> {
    const canonical = await this.readCanonicalTask(input.taskId, { force: true });
    const localId = this.#requireLocalId(canonical.localId);
    const timestamp = this.#clock().toISOString();
    this.#executionStore.update(this.#teamName, localId, (record) => {
      const from =
        record.reviewState ??
        getReviewStateFromTask({
          historyEvents: record.historyEvents,
          status: REGISTRY_TO_TEAM_STATUS[canonical.status],
        });
      if (input.action === 'clear') {
        if (from !== 'none')
          throw new Error(
            `Task #${localId} is in reviewState=${from}; use review or status transitions instead`
          );
        return null;
      }
      if (input.action === 'request' && canonical.status !== 'done') {
        throw new Error(`Task #${localId} must be completed before review`);
      }
      if (input.action === 'request' && from === 'approved') {
        throw new Error(`Task #${localId} is already approved`);
      }
      if (input.action === 'approve' && from === 'approved') return null;
      if (
        input.action !== 'request' &&
        from !== 'review' &&
        !(input.action === 'approve' && input.manual && canonical.status === 'done')
      ) {
        throw new Error(`Task #${localId} must be in review before this action`);
      }
      const common = { id: randomUUID(), timestamp, actor: input.actor, from };
      const event: TaskHistoryEvent =
        input.action === 'request'
          ? {
              ...common,
              type: 'review_requested',
              to: 'review',
              ...(input.reviewer ? { reviewer: input.reviewer } : {}),
            }
          : input.action === 'approve'
            ? { ...common, type: 'review_approved', to: 'approved', note: input.note ?? 'Approved' }
            : {
                ...common,
                type: 'review_changes_requested',
                to: 'needsFix',
                note: input.note ?? 'Reviewer requested changes.',
              };
      const reviewIntervals = record.reviewIntervals.map((interval) =>
        input.action !== 'request' && !interval.completedAt
          ? { ...interval, completedAt: timestamp }
          : interval
      );
      const comments =
        input.action === 'changes'
          ? [
              ...record.comments,
              {
                id: randomUUID(),
                author: input.actor,
                text: input.note ?? 'Reviewer requested changes.',
                createdAt: timestamp,
                type: 'review_request' as const,
                ...(input.taskRefs?.length ? { taskRefs: input.taskRefs } : {}),
              },
            ]
          : record.comments;
      return {
        reviewState:
          input.action === 'request'
            ? 'review'
            : input.action === 'approve'
              ? 'approved'
              : 'needsFix',
        historyEvents: [...record.historyEvents, event],
        reviewIntervals,
        comments,
      };
    });
  }

  async addAttachment(taskId: string, meta: TaskAttachmentMeta): Promise<void> {
    const current = await this.readCanonicalTask(taskId);
    this.#executionStore.addAttachmentMeta(
      this.#teamName,
      this.#requireLocalId(current.localId),
      meta
    );
  }

  async removeAttachment(taskId: string, attachmentId: string): Promise<void> {
    const current = await this.readCanonicalTask(taskId);
    const localId = this.#requireLocalId(current.localId);
    this.#executionStore.update(this.#teamName, localId, (record) => {
      const attachments = record.attachments.filter((entry) => entry.id !== attachmentId);
      return attachments.length === record.attachments.length ? null : { attachments };
    });
  }

  async setNeedsClarification(taskId: string, value: 'lead' | 'user' | null): Promise<void> {
    const current = await this.readCanonicalTask(taskId);
    this.#executionStore.write(this.#teamName, this.#requireLocalId(current.localId), {
      needsClarification: value,
    });
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

  /** Each half is fenced by a fresh TASKS.md hash; no concurrent edit is overwritten. */
  async #changeRelated(
    localId: string,
    targetId: string,
    add: boolean
  ): Promise<{
    before: string[];
    after: string[];
  } | null> {
    const expectedSha = await this.#client.readTasksDocumentSha(this.#binding);
    const current = await this.readCanonicalTask(localId, { force: true });
    const before = current.refs;
    const after = add
      ? before.some((ref) => localIdFromRef(this.#binding.spec, ref) === targetId)
        ? before
        : [...before, canonicalTaskRef(this.#binding.spec, targetId)]
      : before.filter((ref) => localIdFromRef(this.#binding.spec, ref) !== targetId);
    if (after === before || (!add && after.length === before.length)) return null;
    await this.#replaceLinks(localId, { refs: after, expectedSha });
    return { before: [...before], after: [...after] };
  }

  async #setRelatedPair(localId: string, targetId: string, add: boolean): Promise<void> {
    let first: { before: string[]; after: string[] } | null;
    try {
      first = await this.#changeRelated(localId, targetId, add);
    } catch (error) {
      if (error instanceof RegistryTeamTaskWriteError && error.details.registryCode) throw error;
      throw new RegistryTeamTaskWriteError(
        'RELATIONSHIP_OUTCOME_UNKNOWN',
        'The relationship write may have reached the registry; reload both tasks before retrying.',
        { taskId: localId, cause: error }
      );
    }
    try {
      await this.#changeRelated(targetId, localId, add);
    } catch (error) {
      const refused = error instanceof RegistryTeamTaskWriteError && !!error.details.registryCode;
      if (!refused) {
        throw new RegistryTeamTaskWriteError(
          'RELATIONSHIP_OUTCOME_UNKNOWN',
          'The reciprocal relationship write may have reached the registry; reload both tasks before retrying.',
          { taskId: targetId, cause: error }
        );
      }
      if (first) {
        try {
          const expectedSha = await this.#client.readTasksDocumentSha(this.#binding);
          const current = await this.readCanonicalTask(localId, { force: true });
          if (JSON.stringify(current.refs) !== JSON.stringify(first.after)) {
            throw new Error('relationship changed concurrently');
          }
          await this.#replaceLinks(localId, { refs: first.before, expectedSha });
        } catch (rollbackError) {
          throw new RegistryTeamTaskWriteError(
            'RELATIONSHIP_PARTIAL',
            'The reciprocal relationship was refused and the first change could not be safely reverted.',
            { taskId: localId, cause: rollbackError }
          );
        }
      }
      throw error;
    }
  }

  async #replaceLinks(
    localId: string,
    links: { dependsOn?: string[]; refs?: string[]; expectedSha?: string }
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
    this.#executionStore.update(this.#teamName, localId, (record) => {
      const intervals: TaskWorkInterval[] = record.workIntervals.map((interval) => ({
        ...interval,
      }));
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
      return { workIntervals: intervals, historyEvents: [...record.historyEvents, statusEvent] };
    });
  }
}
