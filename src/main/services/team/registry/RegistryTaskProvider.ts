import { getReviewStateFromTask } from '@shared/utils/reviewState';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';

import { ExecutionTaskStore } from '../execution/ExecutionTaskStore';

import { RegistryTaskClient } from './RegistryTaskClient';
import { RegistryTaskClientError } from './RegistryTaskClientErrors';
import { REGISTRY_TASK_STATUSES } from './RegistryTaskClientTypes';
import { taskCreationTimestamp } from './RegistryTeamTaskProjection';
import { resolveTeamSpecBinding, TeamSpecBindingError } from './TeamSpecBinding';

import type { ExecutionTaskRecord } from '../execution/ExecutionTaskStore';
import type { RegistryTask, RegistryTaskStatus } from './RegistryTaskClientTypes';
import type { TeamConfig, TeamTask, TeamTaskStatus } from '@shared/types';

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

export type RegistryTaskProviderErrorCode = 'REGISTRY_SCOPE_INCOMPLETE' | 'REGISTRY_UNAVAILABLE';

/**
 * Typed failure of the registry-backed task read path.
 *
 * The provider never falls back to the local canonical task files: a caller
 * that sees this error knows the canonical state could not be produced, and
 * that an empty board would be a lie.
 */
export class RegistryTaskProviderError extends Error {
  readonly code: RegistryTaskProviderErrorCode;
  readonly teamName: string;
  readonly project: string | undefined;
  readonly spec: string | undefined;
  /** `RegistryTaskClientError['code']` when the failure came from the client. */
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

/** The registry project/spec a team's tasks live in. */
export interface RegistryTaskScope {
  project: string;
  spec: string;
}

export type RegistryTasksReadResult = { backed: true; tasks: TeamTask[] };

export type RegistryTaskReadResult = { backed: true; task: TeamTask | null };

/** Binding already validated by the caller, avoiding a second config read. */
export interface RegistryTaskReadOptions {
  binding?: RegistryTaskScope;
}

export interface RegistryTaskProviderOptions {
  /** Reads the team's config; the provider only interprets `specProject`/`specSlug`. */
  readConfig: (teamName: string) => Promise<unknown>;
  /** Injectable for tests; defaults to a client resolved from env/token file. */
  clientFactory?: () => Promise<RegistryTaskClient>;
  /** Execution-field store; registry-backed teams keep no canonical task files. */
  executionStore?: ExecutionTaskStore;
  cacheTtlMs?: number;
  now?: () => number;
}

interface CachedRegistryTasks {
  expiresAt: number;
  tasks: RegistryTask[];
}

/**
 * Registry links are canonical ids (`<spec>:TASK-7`). Board fields hold the
 * same team's local task ids, so strip the current spec's namespace and keep
 * foreign ids verbatim (they still identify the task unambiguously).
 */
function stripTaskPrefix(value: string): string {
  return value
    .trim()
    .replace(/^#/, '')
    .replace(/^TASK-/i, '');
}

function toLocalTaskRef(ref: string, spec: string): string {
  const prefix = `${spec}:`;
  if (!ref.startsWith(prefix)) {
    return ref;
  }
  const local = ref.slice(prefix.length);
  return local.startsWith('TASK-') ? local.slice('TASK-'.length) : local;
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
 * Canonical team-task reads backed by the spec registry.
 *
 * For a team whose config carries `specProject` + `specSlug`, canonical task
 * fields (id, subject, status, owner, links) come from the registry and the
 * execution half of each task (intervals, comments, attachments, history,
 * clarification) comes from {@link ExecutionTaskStore}. The merged result has
 * the same shape as the file reader's, so the renderer and the board stay
 * unchanged.
 *
 * There is no fallback: when the registry cannot be read, {@link RegistryTaskProviderError}
 * is thrown instead of quietly serving a stale or empty board from disk.
 */
export class RegistryTaskProvider {
  private readonly readConfig: (teamName: string) => Promise<unknown>;
  private readonly clientFactory: () => Promise<RegistryTaskClient>;
  private readonly executionStore: ExecutionTaskStore;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedRegistryTasks>();
  private cacheGeneration = 0;
  private readonly inFlight = new Map<string, Promise<RegistryTask[]>>();

  constructor(options: RegistryTaskProviderOptions) {
    this.readConfig = options.readConfig;
    this.clientFactory = options.clientFactory ?? (() => RegistryTaskClient.create());
    this.executionStore = options.executionStore ?? new ExecutionTaskStore();
    this.cacheTtlMs = options.cacheTtlMs ?? REGISTRY_TASK_CACHE_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  /** Required registry binding of the team. */
  async getScope(teamName: string): Promise<RegistryTaskScope> {
    const config = await this.readConfig(teamName);
    // `resolveTeamSpecBinding` validates every field at runtime; the cast only
    // recovers the two optional config keys the config reader returns as `unknown`.
    const bindingConfig = config as Pick<TeamConfig, 'specProject' | 'specSlug'> | null;
    try {
      return resolveTeamSpecBinding(bindingConfig, teamName);
    } catch (error) {
      if (!(error instanceof TeamSpecBindingError)) {
        throw error;
      }
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_SCOPE_INCOMPLETE',
        teamName,
        message: error.message,
        causeCode: error.code,
        ...(typeof bindingConfig?.specProject === 'string'
          ? { project: bindingConfig.specProject }
          : {}),
      });
    }
  }

  async getTasks(
    teamName: string,
    options: RegistryTaskReadOptions = {}
  ): Promise<RegistryTasksReadResult> {
    const scope = options.binding === undefined ? await this.getScope(teamName) : options.binding;
    const registryTasks = await this.readRegistryTasks(teamName, scope);
    return {
      backed: true,
      tasks: this.mergeExecutionFields(
        teamName,
        scope,
        registryTasks.filter((task) => task.status !== 'deleted')
      ),
    };
  }

  async getTask(
    teamName: string,
    taskId: string,
    options: RegistryTaskReadOptions = {}
  ): Promise<RegistryTaskReadResult> {
    const scope = options.binding === undefined ? await this.getScope(teamName) : options.binding;
    // The board and the MCP store address a task as `12`; the corpus stores
    // `TASK-12`. Compare canonical ids, never the spelling.
    const wantedId = stripTaskPrefix(toLocalTaskRef(taskId.trim(), scope.spec));
    const registryTasks = await this.readRegistryTasks(teamName, scope);
    const match = registryTasks.find((task) => stripTaskPrefix(task.localId) === wantedId);
    if (!match) {
      return { backed: true, task: null };
    }
    return {
      backed: true,
      task: this.toTeamTask(
        scope,
        match,
        this.readRecord(teamName, match.localId),
        registryTasks
          .filter((task) => task.refs.some((ref) => ref === `${scope.spec}:TASK-${wantedId}`))
          .map((task) => stripTaskPrefix(task.localId))
      ),
    };
  }

  /** Deleted tasks remain canonical registry records and retain their execution fields. */
  async getDeletedTasks(
    teamName: string,
    options: RegistryTaskReadOptions = {}
  ): Promise<RegistryTasksReadResult> {
    const scope = options.binding === undefined ? await this.getScope(teamName) : options.binding;
    const registryTasks = await this.readRegistryTasks(teamName, scope);
    return {
      backed: true,
      tasks: this.mergeExecutionFields(
        teamName,
        scope,
        registryTasks.filter((task) => task.status === 'deleted')
      ),
    };
  }

  /** Drops cached registry reads; call after a registry write for the team. */
  invalidate(scope?: RegistryTaskScope): void {
    this.cacheGeneration += 1;
    if (!scope) {
      this.cache.clear();
      this.inFlight.clear();
      return;
    }
    this.cache.delete(RegistryTaskProvider.cacheKey(scope));
    this.inFlight.delete(RegistryTaskProvider.cacheKey(scope));
  }

  private static cacheKey(scope: RegistryTaskScope): string {
    return `${scope.project}\u0000${scope.spec}`;
  }

  private async readRegistryTasks(
    teamName: string,
    scope: RegistryTaskScope
  ): Promise<RegistryTask[]> {
    const key = RegistryTaskProvider.cacheKey(scope);
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.now()) {
      return cached.tasks;
    }
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }

    const generation = this.cacheGeneration;
    const request = this.loadRegistryTasks(teamName, scope);
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
    scope: RegistryTaskScope
  ): Promise<RegistryTask[]> {
    try {
      const client = await this.clientFactory();
      // The registry filters to active statuses unless asked otherwise; a board
      // must show finished work too, so request the full vocabulary.
      return await client.listTasks({
        project: scope.project,
        spec: scope.spec,
        statuses: [...REGISTRY_TASK_STATUSES],
        includeBodies: true,
      });
    } catch (error) {
      const causeCode =
        error instanceof RegistryTaskClientError
          ? error.code
          : error !== null &&
              typeof error === 'object' &&
              'code' in error &&
              typeof error.code === 'string'
            ? error.code
            : 'UNKNOWN';
      const message =
        `Spec registry is unavailable for team "${teamName}" ` +
        `(project "${scope.project}", spec "${scope.spec}"): ` +
        `${error instanceof Error ? error.message : 'unknown error'}`;
      throw new RegistryTaskProviderError({
        code: 'REGISTRY_UNAVAILABLE',
        teamName,
        message,
        project: scope.project,
        spec: scope.spec,
        causeCode,
      });
    }
  }

  private mergeExecutionFields(
    teamName: string,
    scope: RegistryTaskScope,
    registryTasks: readonly RegistryTask[]
  ): TeamTask[] {
    const recordsById = new Map<string, ExecutionTaskRecord>();
    for (const record of this.executionStore.list(teamName)) {
      recordsById.set(stripTaskPrefix(record.taskId), record);
    }
    const incoming = new Map<string, string[]>();
    for (const task of registryTasks) {
      for (const ref of task.refs) {
        const prefix = `${scope.spec}:TASK-`;
        if (!ref.startsWith(prefix)) continue;
        const target = ref.slice(prefix.length);
        const sources = incoming.get(target) ?? [];
        sources.push(stripTaskPrefix(task.localId));
        incoming.set(target, sources);
      }
    }
    return registryTasks
      .map((task) =>
        this.toTeamTask(
          scope,
          task,
          recordsById.get(stripTaskPrefix(task.localId)),
          incoming.get(stripTaskPrefix(task.localId))
        )
      )
      .sort(compareTasks);
  }

  private readRecord(teamName: string, taskId: string): ExecutionTaskRecord | undefined {
    return this.executionStore.read(teamName, stripTaskPrefix(taskId)) ?? undefined;
  }

  private toTeamTask(
    scope: RegistryTaskScope,
    registryTask: RegistryTask,
    record: ExecutionTaskRecord | undefined,
    incomingRelated: readonly string[] = []
  ): TeamTask {
    const id = stripTaskPrefix(registryTask.localId);
    const status = REGISTRY_TO_TEAM_STATUS[registryTask.status] ?? 'pending';
    const blockedBy = uniqueRefs([
      ...registryTask.blockedBy.map((ref) => stripTaskPrefix(toLocalTaskRef(ref, scope.spec))),
      ...registryTask.dependsOn.map((ref) => stripTaskPrefix(toLocalTaskRef(ref, scope.spec))),
    ]);
    const blocks = uniqueRefs(
      registryTask.blocks.map((ref) => stripTaskPrefix(toLocalTaskRef(ref, scope.spec)))
    );
    const related = uniqueRefs([
      ...registryTask.refs.map((ref) => stripTaskPrefix(toLocalTaskRef(ref, scope.spec))),
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
      displayId: deriveTaskDisplayId(id),
      ...(registryTask.body !== undefined ? { description: registryTask.body } : {}),
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
      // The registry list payload carries no timestamps; the execution record's
      // updatedAt is the only "last touched" signal this team has.
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
