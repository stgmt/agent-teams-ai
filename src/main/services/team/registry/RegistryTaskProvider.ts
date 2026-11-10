import { getReviewStateFromTask } from '@shared/utils/reviewState';
import { registryTaskId } from './RegistryTaskIdentity';
import { ExecutionTaskStore } from '../execution/ExecutionTaskStore';

import {
  resolveTeamSpecBinding,
  resolveTeamSpecBindings,
  TeamSpecBindingError,
  type TeamSpecBindingConfig,
} from './TeamSpecBinding';
import { RegistryTaskClient } from './RegistryTaskClient';
import { RegistryTaskClientError } from './RegistryTaskClientErrors';
import { REGISTRY_TASK_STATUSES } from './RegistryTaskClientTypes';
import { taskCreationTimestamp } from './RegistryTeamTaskProjection';

import type { ExecutionTaskRecord } from '../execution/ExecutionTaskStore';
import type { RegistryTask, RegistryTaskStatus } from './RegistryTaskClientTypes';
import type { TeamSpecBinding, TeamTask, TeamTaskStatus } from '@shared/types';
/** Short enough that a registry edit shows up promptly, long enough to absorb board re-renders. */
export const REGISTRY_TASK_CACHE_TTL_MS = 5_000;

/** Registry task vocabulary translated into the board's own statuses. */
const REGISTRY_TO_TEAM_STATUS: Readonly<Record<RegistryTaskStatus, TeamTaskStatus>> = {
  planned: 'pending',
  todo: 'pending',
  ready: 'pending',
  'in-progress': 'in_progress',
  blocked: 'pending',
  done: 'completed',
  deleted: 'deleted',
  deferred: 'pending',
  unknown: 'pending',
};

export type RegistryTaskProviderErrorCode =
  | 'REGISTRY_SCOPE_INCOMPLETE'
  | 'REGISTRY_SCOPE_UNLINKED'
  | 'REGISTRY_TEAM_ID_MISSING'
  | 'REGISTRY_TASK_ID_AMBIGUOUS'
  | 'REGISTRY_TASK_NOT_FOUND'
  | 'REGISTRY_REFUSED'
  | 'REGISTRY_UNAVAILABLE';

/**
 * Typed failure of the registry-backed task read path.
 *
 * The provider never falls back to local canonical task files.
 */
export class RegistryTaskProviderError extends Error {
  readonly code: RegistryTaskProviderErrorCode;
  readonly teamName: string;
  readonly project: string | undefined;
  readonly spec: string | undefined;
  readonly causeCode: string | undefined;

  constructor(init: {
    code: RegistryTaskProviderErrorCode;
    teamName: string;
    message: string;
    project?: string;
    spec?: string;
    causeCode?: string;
  }) {
    super(init.message);
    this.name = 'RegistryTaskProviderError';
    this.code = init.code;
    this.teamName = init.teamName;
    this.project = init.project;
    this.spec = init.spec;
    this.causeCode = init.causeCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function incompleteBindingError(error: TeamSpecBindingError): RegistryTaskProviderError {
  return new RegistryTaskProviderError({
    code: 'REGISTRY_SCOPE_INCOMPLETE',
    teamName: error.teamName,
    message: error.message,
    causeCode: error.code,
  });
}

/** The registry project/spec a team's tasks live in. */
export interface RegistryTaskScope {
  project: string;
  spec: string;
}

export type RegistryTasksReadResult = { backed: true; tasks: TeamTask[] };
export type RegistryTaskReadResult = { backed: true; task: TeamTask | null };

/** Optional scope filter; bindings are always checked against the registry owner. */
export interface RegistryTaskReadOptions {
  binding?: RegistryTaskScope;
  forceRefresh?: boolean;
}

export interface RegistryTaskProviderOptions {
  /** Reads team metadata containing the registry-issued team id. */
  readConfig: (teamName: string) => Promise<TeamSpecBindingConfig | null>;
  /** Injectable for tests; defaults to a client resolved from env/token file. */
  clientFactory?: () => Promise<RegistryTaskClient>;
  executionStore?: ExecutionTaskStore;
  cacheTtlMs?: number;
  now?: () => number;
}

interface CachedRegistryTasks {
  expiresAt: number;
  tasks: RegistryTask[];
}

interface CachedTeamBindings {
  teamId: string;
  expiresAt: number;
  bindings: TeamSpecBinding[];
}

function localIdFromRef(ref: string, spec: string): string | null {
  const prefix = `${spec}:TASK-`;
  return ref.startsWith(prefix) ? ref.slice(prefix.length) : null;
}

function taskCardId(scope: RegistryTaskScope, localId: string): string {
  return registryTaskId({ project: scope.project, spec: scope.spec, localId });
}

function taskLinkId(scope: RegistryTaskScope, ref: string): string {
  const localId = localIdFromRef(ref, scope.spec);
  return localId === null ? ref : taskCardId(scope, localId);
}

function uniqueRefs(refs: readonly string[]): string[] | undefined {
  const unique = [...new Set(refs.filter((ref) => ref.length > 0))];
  return unique.length > 0 ? unique : undefined;
}

/** Mirrors `TeamTaskReader`'s ordering: numeric labels first, then natural compare. */
function compareTasks(left: TeamTask, right: TeamTask): number {
  const leftLabel = left.displayId ?? left.id;
  const rightLabel = right.displayId ?? right.id;
  const leftNumeric = /^\d+$/.test(leftLabel);
  const rightNumeric = /^\d+$/.test(rightLabel);
  if (leftNumeric && rightNumeric) return Number(leftLabel) - Number(rightLabel);
  if (leftNumeric) return -1;
  if (rightNumeric) return 1;
  const byDisplay = leftLabel.localeCompare(rightLabel, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (byDisplay !== 0) return byDisplay;
  return left.id.localeCompare(right.id, undefined, { numeric: true, sensitivity: 'base' });
}

/**
 * Registry-backed shared task reads. The registry owns team/spec bindings and
 * canonical task fields; execution-only data remains in ExecutionTaskStore.
 * Full entity content is fetched only for an opened task.
 */
export class RegistryTaskProvider {
  private readonly readConfig: (teamName: string) => Promise<TeamSpecBindingConfig | null>;
  private readonly clientFactory: () => Promise<RegistryTaskClient>;
  private readonly executionStore: ExecutionTaskStore;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedRegistryTasks>();
  private readonly bindingCache = new Map<string, CachedTeamBindings>();
  private readonly bindingInFlight = new Map<string, Promise<TeamSpecBinding[]>>();
  private cacheGeneration = 0;
  private readonly inFlight = new Map<string, Promise<RegistryTask[]>>();

  constructor(options: RegistryTaskProviderOptions) {
    this.readConfig = options.readConfig;
    this.clientFactory = options.clientFactory ?? (() => RegistryTaskClient.create());
    this.executionStore = options.executionStore ?? new ExecutionTaskStore();
    this.cacheTtlMs = options.cacheTtlMs ?? REGISTRY_TASK_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Bindings belong to the team configuration the app owns: the registry has no
   * tool that lists them, and asking it made every bound read fail with
   * REGISTRY_UNAVAILABLE. Only the app's own configuration is authoritative.
   */
  async getBindings(teamName: string, forceRefresh = false): Promise<TeamSpecBinding[]> {
    const config = await this.readConfig(teamName);
    if (!config) {
      this.bindingCache.delete(teamName);
      return [];
    }
    let configured: TeamSpecBinding[];
    try {
      configured = resolveTeamSpecBindings(config, teamName);
      // A half-configured team must say so instead of looking unbound.
      if (configured.length === 0) resolveTeamSpecBinding(config, teamName);
    } catch (error) {
      if (error instanceof TeamSpecBindingError) throw incompleteBindingError(error);
      throw error;
    }
    const teamId = typeof config.registryTeamId === 'string' ? config.registryTeamId.trim() : '';
    if (forceRefresh) {
      this.bindingCache.delete(teamName);
      this.bindingInFlight.delete(teamName);
    }
    const cached = this.bindingCache.get(teamName);
    if (cached && cached.teamId === teamId && cached.expiresAt > this.now()) return cached.bindings;
    this.bindingCache.set(teamName, {
      teamId,
      expiresAt: this.now() + this.cacheTtlMs,
      bindings: configured,
    });
    return configured;
  }


  /**
   * The registry scopes tasks by project and spec; it declares no team identity,
   * so a missing id is the normal state, not an error.
   */
  /**
   * Creates a canonical registry task and returns the stored projection.
   * The next free `TASK-<n>` is derived from the spec's own task list.
   */
  async createTask(
    teamName: string,
    input: {
      project: string;
      spec: string;
      subject: string;
      requirements: readonly string[];
      owner?: string | null;
      description?: string;
    }
  ): Promise<RegistryTask> {
    const client = await this.clientFactory();
    const existing = await client.listTasks({
      project: input.project,
      spec: input.spec,
      statuses: [...REGISTRY_TASK_STATUSES],
    });
    const used = new Set(
      existing
        .map((task) => task.localId ?? task.id)
        .filter((value): value is string => typeof value === 'string')
        .map((value) => Number.parseInt(value.replace(/^TASK-/u, ''), 10))
        .filter((value) => Number.isFinite(value))
    );
    // Allocate above the highest id ever used: reusing a retired number would
    // collide with the board's execution records for that id.
    let next = used.size === 0 ? 1 : Math.max(...used) + 1;
    while (used.has(next)) next += 1;
    const entity = `TASK-${next}`;
    const created = await client.createTaskFields({
      project: input.project,
      spec: input.spec,
      entity,
      subject: input.subject,
      requirements: input.requirements,
      owner: input.owner ?? null,
      description: input.description,
    });
    if (created && created.ok === false) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_REFUSED',
        teamName,
        message: `The spec registry refused the task: ${String((created.error as { message?: unknown })?.message ?? 'no reason given')}`,
      });
    }
    const { task } = await this.getTask(teamName, `${input.spec}:${entity}`, { forceRefresh: true });
    if (!task) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_TASK_NOT_FOUND',
        teamName,
        message: `Task "${entity}" was created but could not be read back.`,
      });
    }
    return task.registryTask as RegistryTask;
  }

  /** Appends one comment straight into the registry task block. */
  async addTaskComment(
    teamName: string,
    taskId: string,
    text: string,
    actor: string
  ): Promise<void> {
    const { task } = await this.getTask(teamName, taskId, { forceRefresh: true });
    const project = task?.specProject;
    const spec = task?.specSlug;
    const localId = task?.registryTask?.localId;
    if (!task || !project || !spec || !localId) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_TASK_NOT_FOUND',
        teamName,
        message: `Task "${taskId}" was not found in the linked registry scopes.`,
      });
    }
    const client = await this.clientFactory();
    await client.addTaskComment({ project, spec, entity: localId, text, actor });
  }

  /**
   * Owner/status writes go straight to the registry contract: resolve the task
   * once, then one `spec_patch` intent. This bypasses the legacy writer, which
   * required a registry team identity the registry does not have.
   */
  async writeTaskFields(
    teamName: string,
    taskId: string,
    fields: { status?: RegistryTaskStatus; owner?: string | null; expectedStatus?: RegistryTaskStatus }
  ): Promise<void> {
    const { task } = await this.getTask(teamName, taskId, { forceRefresh: true });
    if (!task) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_TASK_NOT_FOUND',
        teamName,
        message: `Task "${taskId}" was not found in the linked registry scopes.`,
      });
    }
    const project = task.specProject;
    const spec = task.specSlug;
    const localId = task.registryTask?.localId;
    if (!project || !spec || !localId) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
        teamName,
        message: `Task "${taskId}" is missing registry identity metadata.`,
      });
    }
    const client = await this.clientFactory();
    await client.updateTaskFields({
      project,
      spec,
      entity: localId,
      ...(fields.status === undefined ? {} : { status: fields.status }),
      ...(fields.owner === undefined ? {} : { owner: fields.owner }),
      ...(fields.expectedStatus === undefined ? {} : { expectedStatus: fields.expectedStatus }),
    });
  }

  private async readTeamId(teamName: string): Promise<string> {
    const config = await this.readConfig(teamName);
    return typeof config?.registryTeamId === 'string' ? config.registryTeamId.trim() : '';
  }

  async getTasks(
    teamName: string,
    options: RegistryTaskReadOptions = {}
  ): Promise<RegistryTasksReadResult> {
    const bindings = this.selectBindings(
      teamName,
      await this.getBindings(teamName, options.forceRefresh),
      options.binding
    );
    const taskSets = await Promise.all(
      bindings.map(async (scope) => ({
        scope,
        tasks: await this.readRegistryTasks(teamName, scope, options.forceRefresh),
      }))
    );
    return {
      backed: true,
      tasks: taskSets
        .flatMap(({ scope, tasks }) =>
          this.mergeExecutionFields(
            teamName,
            scope,
            tasks.filter((task) => task.status !== 'deleted')
          )
        )
        .sort(compareTasks),
    };
  }

  async getTask(
    teamName: string,
    taskId: string,
    options: RegistryTaskReadOptions = {}
  ): Promise<RegistryTaskReadResult> {
    const [active, deleted] = await Promise.all([
      this.getTasks(teamName, options),
      this.getDeletedTasks(teamName, options),
    ]);
    const wanted = taskId.trim();
    const matches = [...active.tasks, ...deleted.tasks].filter((task) => {
      if (task.id === wanted || task.displayId === wanted) return true;
      const canonical = task.registryTask?.canonicalId;
      if (typeof canonical === 'string' && canonical === wanted) return true;
      const localId = task.registryTask?.localId;
      return typeof localId === 'string' && localId === wanted;
    });
    if (matches.length > 1) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_TASK_ID_AMBIGUOUS',
        teamName,
        message: `Task identity "${taskId}" matched more than one linked registry task.`,
      });
    }
    const task = matches[0];
    if (!task) return { backed: true, task: null };
    const snapshot = task.registryTask;
    const project = task.specProject;
    const spec = task.specSlug;
    if (!snapshot || !project || !spec) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
        teamName,
        message: `Task "${taskId}" is missing registry identity metadata.`,
      });
    }
    try {
      const registryEntity = await (
        await this.clientFactory()
      ).getTaskEntity({
        project,
        spec,
        canonicalId: snapshot.canonicalId,
      });
      return { backed: true, task: { ...task, registryEntity } };
    } catch (error) {
      throw this.unavailableError(teamName, { project, spec }, error, 'getTaskEntity');
    }
  }
  async getTaskScope(
    teamName: string,
    taskId: string,
    options: RegistryTaskReadOptions = {}
  ): Promise<RegistryTaskScope | null> {
    const [active, deleted] = await Promise.all([
      this.getTasks(teamName, options),
      this.getDeletedTasks(teamName, options),
    ]);
    const key = taskId.trim();
    const matches = [...active.tasks, ...deleted.tasks].filter(
      (task) => task.id === key || task.displayId === key
    );
    if (matches.length > 1) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_TASK_ID_AMBIGUOUS',
        teamName,
        message: `Task identity "${taskId}" matched more than one linked registry task.`,
      });
    }
    const task = matches[0];
    if (!task) return null;
    if (!task.specProject || !task.specSlug) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
        teamName,
        message: `Task "${taskId}" is missing registry identity metadata.`,
      });
    }
    return { project: task.specProject, spec: task.specSlug };
  }

  /** Deleted tasks remain canonical registry records and retain their execution fields. */
  async getDeletedTasks(
    teamName: string,
    options: RegistryTaskReadOptions = {}
  ): Promise<RegistryTasksReadResult> {
    const bindings = this.selectBindings(
      teamName,
      await this.getBindings(teamName, options.forceRefresh),
      options.binding
    );
    const taskSets = await Promise.all(
      bindings.map(async (scope) => ({
        scope,
        tasks: await this.readRegistryTasks(teamName, scope, options.forceRefresh),
      }))
    );
    return {
      backed: true,
      tasks: taskSets
        .flatMap(({ scope, tasks }) =>
          this.mergeExecutionFields(
            teamName,
            scope,
            tasks.filter((task) => task.status === 'deleted')
          )
        )
        .sort(compareTasks),
    };
  }

  private selectBindings(
    teamName: string,
    bindings: readonly TeamSpecBinding[],
    requested?: RegistryTaskScope
  ): RegistryTaskScope[] {
    if (!requested) return [...bindings];
    const binding = bindings.find(
      (candidate) => candidate.project === requested.project && candidate.spec === requested.spec
    );
    if (!binding) {
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_UNLINKED',
        teamName,
        project: requested.project,
        spec: requested.spec,
        message: `Registry scope "${requested.project}/${requested.spec}" is not linked to team "${teamName}".`,
      });
    }
    return [binding];
  }

  private unavailableError(
    teamName: string,
    scope: RegistryTaskScope | undefined,
    error: unknown,
    operation: string
  ): RegistryTaskProviderError {
    const causeCode =
      error instanceof RegistryTaskClientError
        ? error.code
        : error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            typeof error.code === 'string'
          ? error.code
          : 'UNKNOWN';
    const location = scope ? ` (project "${scope.project}", spec "${scope.spec}")` : '';
    return new RegistryTaskProviderError({
      code: 'REGISTRY_UNAVAILABLE',
      teamName,
      message:
        `Spec registry ${operation} is unavailable for team "${teamName}"${location}: ` +
        `${error instanceof Error ? error.message : 'unknown error'}`,
      ...(scope ? { project: scope.project, spec: scope.spec } : {}),
      causeCode,
    });
  }

  /** Drops cached registry reads; call after a registry write or link change. */
  invalidate(scope?: RegistryTaskScope): void {
    this.cacheGeneration += 1;
    if (!scope) {
      this.cache.clear();
      this.inFlight.clear();
      this.bindingCache.clear();
      this.bindingInFlight.clear();
      return;
    }
    const suffix = `\u0000${scope.project}\u0000${scope.spec}`;
    for (const key of this.cache.keys()) {
      if (key.endsWith(suffix)) this.cache.delete(key);
    }
    for (const key of this.inFlight.keys()) {
      if (key.endsWith(suffix)) this.inFlight.delete(key);
    }
  }

  private static cacheKey(scope: RegistryTaskScope, teamId: string): string {
    return `${teamId}\u0000${scope.project}\u0000${scope.spec}`;
  }

  private async readRegistryTasks(
    teamName: string,
    scope: RegistryTaskScope,
    forceRefresh = false
  ): Promise<RegistryTask[]> {
    const teamId = await this.readTeamId(teamName);
    const key = RegistryTaskProvider.cacheKey(scope, teamId);
    if (forceRefresh) {
      this.cacheGeneration += 1;
      this.cache.delete(key);
      this.inFlight.delete(key);
    }
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.tasks;
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const generation = this.cacheGeneration;
    const request = this.loadRegistryTasks(teamName, scope, teamId);
    this.inFlight.set(key, request);
    try {
      const tasks = await request;
      if (generation === this.cacheGeneration) {
        this.cache.set(key, { expiresAt: this.now() + this.cacheTtlMs, tasks });
      }
      return tasks;
    } finally {
      if (this.inFlight.get(key) === request) {
        this.inFlight.delete(key);
      }
    }
  }

  private async loadRegistryTasks(
    teamName: string,
    scope: RegistryTaskScope,
    teamId: string
  ): Promise<RegistryTask[]> {
    try {
      const client = await this.clientFactory();
      return await client.listTasks({
        project: scope.project,
        spec: scope.spec,
        statuses: [...REGISTRY_TASK_STATUSES],
      });
    } catch (error) {
      throw this.unavailableError(teamName, scope, error, 'listTasks');
    }
  }

  private mergeExecutionFields(
    teamName: string,
    scope: RegistryTaskScope,
    registryTasks: readonly RegistryTask[]
  ): TeamTask[] {
    const recordsById = new Map<string, ExecutionTaskRecord>();
    for (const record of this.executionStore.list(teamName)) {
      recordsById.set(record.taskId, record);
    }
    const incoming = new Map<string, string[]>();
    for (const task of registryTasks) {
      for (const ref of task.refs) {
        const localId = localIdFromRef(ref, scope.spec);
        if (localId === null) continue;
        const target = taskCardId(scope, localId);
        const sources = incoming.get(target) ?? [];
        sources.push(taskCardId(scope, task.localId));
        incoming.set(target, sources);
      }
    }
    return registryTasks.map((task) => {
      const id = taskCardId(scope, task.localId);
      return this.toTeamTask(scope, task, recordsById.get(id), incoming.get(id));
    });
  }

  private toTeamTask(
    scope: RegistryTaskScope,
    registryTask: RegistryTask,
    record: ExecutionTaskRecord | undefined,
    incomingRelated: readonly string[] = []
  ): TeamTask {
    const id = taskCardId(scope, registryTask.localId);
    const status = REGISTRY_TO_TEAM_STATUS[registryTask.status] ?? 'pending';
    const blockedBy = uniqueRefs([
      ...registryTask.blockedBy.map((ref) => taskLinkId(scope, ref)),
      ...registryTask.dependsOn.map((ref) => taskLinkId(scope, ref)),
    ]);
    const blocks = uniqueRefs(registryTask.blocks.map((ref) => taskLinkId(scope, ref)));
    const related = uniqueRefs([
      ...registryTask.refs.map((ref) => taskLinkId(scope, ref)),
      ...incomingRelated,
    ]);
    const historyEvents = record?.historyEvents.length ? record.historyEvents : undefined;
    const createdAt = taskCreationTimestamp(historyEvents);
    let deletedAt: string | undefined;
    if (status === 'deleted' && historyEvents) {
      for (let index = historyEvents.length - 1; index >= 0; index -= 1) {
        const event = historyEvents[index];
        if (event.type === 'status_changed') {
          if (event.to === 'deleted') deletedAt = event.timestamp;
          break;
        }
      }
    }

    return {
      id,
      displayId: id.slice('registry-'.length, 'registry-'.length + 12),
      specProject: scope.project,
      specSlug: scope.spec,
      registryLocalId: registryTask.localId,
      registryStatus: registryTask.status,
      registryTask,
      requirements: registryTask.requirements,
      dependsOn: registryTask.dependsOn.map((ref) => taskLinkId(scope, ref)),
      registryRefs: registryTask.refs,
      registryPhase: registryTask.phase,
      tracking: registryTask.tracking,
      contentHash: registryTask.contentHash,
      registrySource: registryTask.source,
      ...(registryTask.body !== undefined ? { registryBody: registryTask.body } : {}),
      ...(registryTask.description !== null ? { description: registryTask.description } : {}),
      subject: registryTask.title,
      ...(registryTask.owner === null ? {} : { owner: registryTask.owner }),
      status,
      ...(createdAt ? { createdAt } : {}),
      ...(deletedAt ? { deletedAt } : {}),
      ...(blockedBy ? { blockedBy } : {}),
      ...(blocks ? { blocks } : {}),
      ...(related ? { related } : {}),
      ...(record?.workIntervals.length ? { workIntervals: record.workIntervals } : {}),
      ...(record?.reviewIntervals.length ? { reviewIntervals: record.reviewIntervals } : {}),
      ...(historyEvents ? { historyEvents } : {}),
      ...(record?.comments.length ? { comments: record.comments } : {}),
      ...(record?.attachments.length ? { attachments: record.attachments } : {}),
      ...(record?.activeForm !== undefined ? { activeForm: record.activeForm } : {}),
      ...(record?.groupChatId !== undefined ? { groupChatId: record.groupChatId } : {}),
      ...(record?.prompt !== undefined ? { prompt: record.prompt } : {}),
      ...(record?.projectPath !== undefined ? { projectPath: record.projectPath } : {}),
      ...(record?.descriptionTaskRefs !== undefined
        ? { descriptionTaskRefs: record.descriptionTaskRefs }
        : {}),
      ...(record?.promptTaskRefs !== undefined ? { promptTaskRefs: record.promptTaskRefs } : {}),
      ...(record?.sourceMessageId !== undefined ? { sourceMessageId: record.sourceMessageId } : {}),
      ...(record?.sourceMessage !== undefined ? { sourceMessage: record.sourceMessage } : {}),
      ...(record?.createdBy !== undefined ? { createdBy: record.createdBy } : {}),
      ...(record?.creationCommand !== undefined ? { creationCommand: record.creationCommand } : {}),
      ...(record?.needsClarification ? { needsClarification: record.needsClarification } : {}),
      ...(record ? { updatedAt: record.updatedAt } : {}),
      reviewState:
        record?.reviewState ??
        getReviewStateFromTask({
          ...(historyEvents ? { historyEvents } : {}),
          status,
        }),
    };
  }
}
