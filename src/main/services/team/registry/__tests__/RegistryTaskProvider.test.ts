// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setImmediate as flushMacrotask } from 'node:timers/promises';

import { afterEach, describe, expect, it } from 'vitest';

import { ExecutionTaskStore } from '../../execution/ExecutionTaskStore';
import { RegistryTaskClientError } from '../RegistryTaskClientErrors';
import {
  REGISTRY_TASK_CACHE_TTL_MS,
  RegistryTaskProvider,
  RegistryTaskProviderError,
} from '../RegistryTaskProvider';

import type { RegistryTaskClient } from '../RegistryTaskClient';
import type { RegistryTask, RegistryTaskStatus } from '../RegistryTaskClientTypes';
import type { ListRegistryTasksInput } from '../RegistryTaskClientTypes';

const PROJECT = 'stgmt/tokenplan';
const SPEC = 'balancer-consistency-hardening';
const TEAM = 'alpha-team';

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
    localId,
    title: `Task ${localId}`,
    status: 'todo',
    owner: null,
    tracking: null,
    requirements: [],
    dependsOn: [],
    blocks: [],
    blockedBy: [],
    refs: [],
    contentHash: null,
    ...overrides,
  };
}

interface FakeRegistry {
  client: RegistryTaskClient;
  calls: ListRegistryTasksInput[];
  /** Resolves as soon as `listTasks` has been entered at least once. */
  entered: Promise<void>;
  /** Releases a `deferred` listTasks call. */
  release(): void;
}

function createFakeRegistry(options: {
  tasks?: RegistryTask[];
  failWith?: Error;
  deferred?: boolean;
}): FakeRegistry {
  const calls: ListRegistryTasksInput[] = [];
  const enteredGate = createDeferred();
  const releaseGate = createDeferred();
  const stub = {
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
  };
  // Test seam: the provider only ever calls `listTasks`.
  return {
    client: stub as unknown as RegistryTaskClient,
    calls,
    entered: enteredGate.promise,
    release: () => releaseGate.resolve(),
  };
}

function createProvider(
  options: {
    config?: unknown;
    registry?: FakeRegistry;
    executionStore?: ExecutionTaskStore;
    now?: () => number;
    readConfig?: (teamName: string) => Promise<unknown>;
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

const BOUND_CONFIG = { name: TEAM, specProject: PROJECT, specSlug: SPEC };

describe('RegistryTaskProvider', () => {
  it('reports an unbound team without touching the registry', async () => {
    const { provider, registry } = createProvider({ config: { name: TEAM } });

    await expect(provider.getTasks(TEAM)).resolves.toEqual({ backed: false });
    await expect(provider.getTask(TEAM, '7')).resolves.toEqual({ backed: false });
    await expect(provider.getDeletedTasks(TEAM)).resolves.toEqual({ backed: false });
    expect(registry.calls).toHaveLength(0);
  });

  it('merges registry canonical fields with execution fields', async () => {
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
    executionStore.write(TEAM, '7', {
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
    expect(tasks.map((task) => task.id)).toEqual(['2', '7']);

    const task7 = tasks.find((task) => task.id === '7');
    expect(task7).toMatchObject({
      id: '7',
      displayId: '7',
      subject: 'Harden balancer admission',
      owner: 'alice',
      status: 'completed',
      blockedBy: ['2', 'foreign-spec:TASK-9', '3'],
      blocks: ['8'],
      related: ['5'],
      needsClarification: 'lead',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(task7?.comments?.map((comment) => comment.id)).toEqual(['comment-1']);
    expect(task7?.workIntervals).toHaveLength(1);
    expect(task7?.historyEvents?.map((event) => event.id)).toEqual(['event-1']);

    const task2 = tasks.find((task) => task.id === '2');
    expect(task2).toMatchObject({ subject: 'Second', owner: 'bob', status: 'in_progress' });
  });

  it('returns one task by id and null for an unknown id', async () => {
    const { provider } = createProvider({
      config: BOUND_CONFIG,
      registry: createFakeRegistry({ tasks: [registryTask('4', { title: 'Only' })] }),
    });

    await expect(provider.getTask(TEAM, '4')).resolves.toMatchObject({
      backed: true,
      task: { id: '4', subject: 'Only' },
    });
    await expect(provider.getTask(TEAM, `${SPEC}:TASK-4`)).resolves.toMatchObject({
      backed: true,
      task: { id: '4' },
    });
    await expect(provider.getTask(TEAM, '99')).resolves.toEqual({ backed: true, task: null });
  });

  it('answers deleted-task reads with an empty list for a registry-backed team', async () => {
    const { provider } = createProvider({
      config: BOUND_CONFIG,
      registry: createFakeRegistry({ tasks: [registryTask('1')] }),
    });

    await expect(provider.getDeletedTasks(TEAM)).resolves.toEqual({ backed: true, tasks: [] });
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
    const { provider } = createProvider({ config: { name: TEAM, specProject: PROJECT } });

    const error = await provider.getTasks(TEAM).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryTaskProviderError);
    expect((error as RegistryTaskProviderError).code).toBe('REGISTRY_SCOPE_INCOMPLETE');
  });

  it('honours a caller-supplied binding without reading config', async () => {
    let configReads = 0;
    const { provider, registry } = createProvider({
      readConfig: async () => {
        configReads += 1;
        throw new Error('config must not be read');
      },
      registry: createFakeRegistry({ tasks: [registryTask('1')] }),
    });

    const bound = await provider.getTasks(TEAM, { binding: { project: PROJECT, spec: SPEC } });
    expect(bound.backed && bound.tasks.map((task) => task.id)).toEqual(['1']);
    await expect(provider.getTasks(TEAM, { binding: null })).resolves.toEqual({ backed: false });
    expect(registry.calls).toHaveLength(1);
    expect(configReads).toBe(0);
  });
});
