// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setImmediate as flushMacrotask } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { ExecutionTaskStore } from '../../execution/ExecutionTaskStore';
import { RegistryTaskClientError } from '../RegistryTaskClientErrors';
import { registryTaskId } from '../RegistryTaskIdentity';
import {
  REGISTRY_TASK_CACHE_TTL_MS,
  RegistryTaskProvider,
  RegistryTaskProviderError,
} from '../RegistryTaskProvider';

import type { RegistryTaskClient } from '../RegistryTaskClient';
import type { RegistryTask, RegistryTaskStatus } from '../RegistryTaskClientTypes';
import type { ListRegistryTasksInput } from '../RegistryTaskClientTypes';
import type { TeamSpecBinding, TeamSpecBindingConfig } from '../TeamSpecBinding';

const PROJECT = 'stgmt/tokenplan';
const SPEC = 'balancer-consistency-hardening';
const TEAM = 'alpha-team';
const TEAM_ID = 'registry-team-alpha';

function taskKey(localId: string, spec = SPEC, project = PROJECT): string {
  return registryTaskId({ project, spec, localId });
}

const tempPaths: string[] = [];

afterEach(() => {
  for (const tempPath of tempPaths.splice(0)) {
    fs.rmSync(tempPath, { recursive: true, force: true });
  }
});

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeTempBasePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-task-provider-'));
  tempPaths.push(dir);
  return dir;
}

function registryTask(
  localId: string,
  overrides: Partial<RegistryTask> & { status?: RegistryTaskStatus } = {}
): RegistryTask {
  return {
    canonicalId: `${SPEC}:TASK-${localId}`,
    specSlug: SPEC,
    localId,
    title: `Task ${localId}`,
    description: null,
    creationToken: null,
    status: 'todo',
    phase: null,
    owner: null,
    tracking: null,
    contentHash: null,
    source: {
      path: null,
      startLine: null,
      startColumn: null,
      endLine: null,
      endColumn: null,
    },
    requirements: [],
    dependsOn: [],
    blocks: [],
    blockedBy: [],
    refs: [],
    ...overrides,
  };
}

interface FakeRegistry {
  client: RegistryTaskClient;
  calls: ListRegistryTasksInput[];
  bindingCalls: string[];
  /** Resolves as soon as `listTasks` has been entered at least once. */
  entered: Promise<void>;
  /** Releases a `deferred` listTasks call. */
  release(): void;
}

function createFakeRegistry(options: {
  tasks?: RegistryTask[];
  bindings?: TeamSpecBinding[];
  failWith?: Error;
  deferred?: boolean;
}): FakeRegistry {
  const calls: ListRegistryTasksInput[] = [];
  const bindingCalls: string[] = [];
  const enteredGate = createDeferred();
  const releaseGate = createDeferred();
  const stub = {
    async listTeamSpecBindings(teamId: string) {
      bindingCalls.push(teamId);
      return {
        teamId,
        bindings: options.bindings ?? [{ project: PROJECT, spec: SPEC }],
      };
    },
    async listTasks(input: ListRegistryTasksInput): Promise<RegistryTask[]> {
      calls.push(input);
      enteredGate.resolve();
      if (options.deferred) {
        await releaseGate.promise;
      }
      if (options.failWith) {
        throw options.failWith;
      }
      return options.tasks ?? [];
    },
    async getTaskEntity(input: { project: string; spec: string; canonicalId: string }) {
      const localId = input.canonicalId.slice(`${input.spec}:TASK-`.length);
      return {
        canonicalId: input.canonicalId,
        specSlug: input.spec,
        localId,
        kind: 'TASK',
        title: `Task ${localId}`,
        body: '',
        attributes: {},
        contentHash: null,
        span: null,
      };
    },
  };
  return {
    client: stub as unknown as RegistryTaskClient,
    calls,
    bindingCalls,
    entered: enteredGate.promise,
    release: () => releaseGate.resolve(),
  };
}

function createProvider(
  options: {
    config?: TeamSpecBindingConfig | null;
    registry?: FakeRegistry;
    executionStore?: ExecutionTaskStore;
    now?: () => number;
    readConfig?: (teamName: string) => Promise<TeamSpecBindingConfig | null>;
  } = {}
): { provider: RegistryTaskProvider; registry: FakeRegistry; executionStore: ExecutionTaskStore } {
  const registry = options.registry ?? createFakeRegistry({});
  const executionStore =
    options.executionStore ??
    new ExecutionTaskStore({
      basePath: makeTempBasePath(),
      clock: () => new Date('2026-01-01T00:00:00.000Z'),
    });
  const provider = new RegistryTaskProvider({
    readConfig:
      options.readConfig ??
      (async (teamName: string) => (teamName === TEAM ? (options.config ?? null) : null)),
    clientFactory: async () => registry.client,
    executionStore,
    ...(options.now ? { now: options.now } : {}),
  });
  return { provider, registry, executionStore };
}

const BOUND_CONFIG = {
  registryTeamId: TEAM_ID,
  specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: SPEC }] },
};

describe('RegistryTaskProvider', () => {
  it('exposes an authored one-way related reference to consumers of both tasks', async () => {
    const task1Id = taskKey('1');
    const task2Id = taskKey('2');
    const { provider } = createProvider({
      config: BOUND_CONFIG,
      registry: createFakeRegistry({
        tasks: [registryTask('1', { refs: [`${SPEC}:TASK-2`] }), registryTask('2')],
      }),
    });
    const list = (await provider.getTasks(TEAM)).tasks;
    expect(list.find((task) => task.id === task1Id)?.related).toEqual([task2Id]);
    expect(list.find((task) => task.id === task2Id)?.related).toEqual([task1Id]);
    expect((await provider.getTask(TEAM, task2Id)).task?.related).toEqual([task1Id]);
  });

  it('refuses missing team configuration rather than publishing an empty board', async () => {
    const { provider, registry } = createProvider({});
    await expect(provider.readBoardSnapshot(TEAM)).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_INCOMPLETE',
      teamName: TEAM,
    });
    expect(registry.calls).toHaveLength(0);
  });

  it('reports an unbound team without touching the registry', async () => {
    const { provider, registry } = createProvider({ config: {} });

    await expect(provider.getTasks(TEAM)).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_INCOMPLETE',
    });
    await expect(provider.getTask(TEAM, '7')).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_INCOMPLETE',
    });
    await expect(provider.getDeletedTasks(TEAM)).rejects.toMatchObject({
      code: 'REGISTRY_SCOPE_INCOMPLETE',
    });
    expect(registry.calls).toHaveLength(0);
    expect(registry.bindingCalls).toHaveLength(0);
  });

  it('merges registry canonical fields with execution fields', async () => {
    const task2Id = taskKey('2');
    const task7Id = taskKey('7');
    const { provider, executionStore } = createProvider({
      config: BOUND_CONFIG,
      registry: createFakeRegistry({
        tasks: [
          registryTask('7', {
            title: 'Harden balancer admission',
            status: 'done',
            owner: 'alice',
            dependsOn: [`${SPEC}:TASK-3`],
            blockedBy: [`${SPEC}:TASK-2`, 'foreign-spec:TASK-9'],
            blocks: [`${SPEC}:TASK-8`, `${SPEC}:TASK-8`],
            refs: [`${SPEC}:TASK-5`],
          }),
          registryTask('2', { title: 'Second', status: 'in-progress', owner: 'bob' }),
        ],
      }),
    });
    executionStore.write(TEAM, task7Id, {
      comments: [
        {
          id: 'comment-1',
          author: 'user',
          text: 'execution comment',
          createdAt: '2026-01-01T00:00:00.000Z',
          type: 'regular',
        },
      ],
      workIntervals: [{ startedAt: '2026-01-01T00:00:00.000Z' }],
      needsClarification: 'lead',
      historyEvents: [
        {
          id: 'event-1',
          timestamp: '2026-01-01T00:00:00.000Z',
          type: 'task_created',
          status: 'pending',
        },
      ],
    });

    const result = await provider.getTasks(TEAM);
    expect(result.backed).toBe(true);
    const tasks = result.backed ? result.tasks : [];
    expect(tasks.map((task) => task.id).sort()).toEqual([task2Id, task7Id].sort());

    const task7 = tasks.find((task) => task.id === task7Id);
    expect(task7).toMatchObject({
      id: task7Id,
      displayId: task7Id.slice('registry-'.length, 'registry-'.length + 12),
      subject: 'Harden balancer admission',
      owner: 'alice',
      status: 'completed',
      blockedBy: [task2Id, 'foreign-spec:TASK-9', taskKey('3')],
      blocks: [taskKey('8')],
      related: [taskKey('5')],
      needsClarification: 'lead',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(task7?.comments?.map((comment) => comment.id)).toEqual(['comment-1']);
    expect(task7?.workIntervals).toHaveLength(1);
    expect(task7?.historyEvents?.map((event) => event.id)).toEqual(['event-1']);

    const task2 = tasks.find((task) => task.id === task2Id);
    expect(task2).toMatchObject({ subject: 'Second', owner: 'bob', status: 'in_progress' });
    expect(task2).not.toHaveProperty('createdAt');
  });

  it('returns one task by its scoped identity and null for an unknown identity', async () => {
    const task4Id = taskKey('4');
    const task4DisplayId = task4Id.slice('registry-'.length, 'registry-'.length + 12);
    expect(task4Id).not.toBe(taskKey('4', 'another-spec'));

    const { provider } = createProvider({
      config: BOUND_CONFIG,
      registry: createFakeRegistry({ tasks: [registryTask('4', { title: 'Only' })] }),
    });

    await expect(provider.getTask(TEAM, task4Id)).resolves.toMatchObject({
      backed: true,
      task: { id: task4Id, subject: 'Only' },
    });
    await expect(provider.getTask(TEAM, task4DisplayId)).resolves.toMatchObject({
      backed: true,
      task: { id: task4Id },
    });
    await expect(provider.getTask(TEAM, taskKey('99'))).resolves.toEqual({
      backed: true,
      task: null,
    });
  });

  it('separates deleted registry tasks from the active board and retains execution history', async () => {
    const task1Id = taskKey('1');
    const task2Id = taskKey('2');
    const { provider, executionStore, registry } = createProvider({
      config: BOUND_CONFIG,
      registry: createFakeRegistry({
        tasks: [registryTask('1'), registryTask('2', { status: 'deleted' })],
      }),
    });
    executionStore.write(TEAM, task2Id, {
      workIntervals: [{ startedAt: '2025-01-01T00:00:00.000Z' }],
      historyEvents: [
        {
          id: 'deleted-event',
          type: 'status_changed',
          from: 'completed',
          to: 'deleted',
          timestamp: '2026-01-02T03:04:05.000Z',
        },
      ],
    });
    expect((await provider.getTasks(TEAM)).tasks.map((task) => task.id)).toEqual([task1Id]);
    expect((await provider.getDeletedTasks(TEAM)).tasks).toMatchObject([
      {
        id: task2Id,
        status: 'deleted',
        deletedAt: '2026-01-02T03:04:05.000Z',
        workIntervals: [{ startedAt: '2025-01-01T00:00:00.000Z' }],
      },
    ]);
    expect((await provider.getTask(TEAM, task2Id)).task?.status).toBe('deleted');
    expect(registry.calls[0].statuses).toContain('deleted');
  });

  it('caches registry reads for the TTL and deduplicates in-flight calls', async () => {
    let now = 1_000;
    const registry = createFakeRegistry({ tasks: [registryTask('1')], deferred: true });
    const { provider } = createProvider({
      config: BOUND_CONFIG,
      registry,
      now: () => now,
    });

    const first = provider.getTasks(TEAM);
    const second = provider.getTasks(TEAM);
    await registry.entered;
    // Let both callers pass their config read and either join the in-flight
    // request or start their own before the deferred call is released.
    await flushMacrotask();
    registry.release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.backed && firstResult.tasks).toHaveLength(1);
    expect(secondResult.backed && secondResult.tasks).toHaveLength(1);
    // The second concurrent read joined the first request instead of issuing its own.
    expect(registry.calls).toHaveLength(1);

    now += REGISTRY_TASK_CACHE_TTL_MS - 1;
    await provider.getTasks(TEAM);
    expect(registry.calls).toHaveLength(1);

    now += 1;
    await provider.getTasks(TEAM);
    expect(registry.calls).toHaveLength(2);
  });

  it('fails with a typed error when the registry is unavailable', async () => {
    const { provider } = createProvider({
      config: BOUND_CONFIG,
      registry: createFakeRegistry({
        failWith: new RegistryTaskClientError({
          code: 'TRANSPORT_ERROR',
          message: 'connection refused',
        }),
      }),
    });

    const error = await provider.getTasks(TEAM).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryTaskProviderError);
    const typed = error as RegistryTaskProviderError;
    expect(typed.code).toBe('REGISTRY_UNAVAILABLE');
    expect(typed.causeCode).toBe('TRANSPORT_ERROR');
    expect(typed.project).toBe(PROJECT);
    expect(typed.spec).toBe(SPEC);
  });

  it('refuses a half-configured binding instead of falling back to files', async () => {
    const { provider } = createProvider({
      config: { specScope: { projects: [PROJECT], bindings: [{ project: PROJECT, spec: '' }] } },
    });

    const error = await provider.getTasks(TEAM).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryTaskProviderError);
    expect((error as RegistryTaskProviderError).code).toBe('REGISTRY_SCOPE_INCOMPLETE');
  });

  it('filters registry reads by a caller-supplied binding', async () => {
    let configReads = 0;
    const { provider, registry } = createProvider({
      readConfig: async () => {
        configReads += 1;
        return BOUND_CONFIG;
      },
      registry: createFakeRegistry({
        bindings: [
          { project: PROJECT, spec: SPEC },
          { project: 'product/api', spec: 'api' },
        ],
        tasks: [registryTask('1')],
      }),
    });

    const result = await provider.getTasks(TEAM, { binding: { project: PROJECT, spec: SPEC } });
    expect(result.backed && result.tasks.map((task) => task.id)).toEqual([taskKey('1')]);
    // Bindings come from the team configuration, never from a registry tool.
    expect(registry.bindingCalls).toEqual([]);
    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0]).toMatchObject({
      project: PROJECT,
      spec: SPEC,
    });
    expect(registry.calls[0]).not.toHaveProperty('teamId');
    expect(configReads).toBeGreaterThan(0);
  });

  it('keeps a cold publication explicit and single-flight across TTL windows', async () => {
    let now = 0;
    const registry = createFakeRegistry({ tasks: [registryTask('1')], deferred: true });
    const { provider } = createProvider({ config: BOUND_CONFIG, registry, now: () => now });
    await expect(provider.readBoardSnapshot(TEAM)).rejects.toMatchObject({
      code: 'REGISTRY_UNAVAILABLE',
    });
    await registry.entered;
    now += REGISTRY_TASK_CACHE_TTL_MS * 4;
    await expect(provider.readBoardSnapshot(TEAM)).rejects.toMatchObject({
      code: 'REGISTRY_UNAVAILABLE',
    });
    expect(registry.calls).toHaveLength(1);
    registry.release();
    await provider.refreshBoardSnapshot(TEAM);
    expect(await provider.readBoardSnapshot(TEAM, { refresh: false })).toEqual([
      expect.objectContaining({ id: taskKey('1'), subject: 'Task 1' }),
    ]);
  });

  it('does not convert an authenticated registry refusal into a readable board', async () => {
    const { provider } = createProvider({
      config: BOUND_CONFIG,
      registry: createFakeRegistry({
        failWith: new RegistryTaskClientError({
          code: 'UNAUTHORIZED',
          operation: 'listTasks',
          message: 'Project access refused',
        }),
      }),
    });
    await expect(provider.refreshBoardSnapshot(TEAM)).rejects.toMatchObject({
      code: 'REGISTRY_REFUSED',
    });
    await expect(provider.readBoardSnapshot(TEAM, { refresh: false })).rejects.toMatchObject({
      code: 'REGISTRY_REFUSED',
    });
  });
});

describe('RegistryTaskProvider initial permitted project', () => {
  it('serves a valid empty binding set without inventing a remote task source', async () => {
    const { provider, registry } = createProvider({
      config: { specScope: { projects: [PROJECT], bindings: [] } },
    });
    expect(await provider.readBoardSnapshot(TEAM, { refresh: false })).toEqual([]);
    expect(registry.calls).toEqual([]);
  });
});
