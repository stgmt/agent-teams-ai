// @vitest-environment node
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerTeamTaskRoutes } from '../../../../http/teams/teamTaskRoutes';
import { setClaudeBasePathOverride } from '../../../../utils/pathDecoder';
import { TeamConfigReader } from '../../TeamConfigReader';
import { TeamDataService } from '../../TeamDataService';
import { TeamKanbanManager } from '../../TeamKanbanManager';
import { TeamMetaStore } from '../../TeamMetaStore';
import { TeamTaskReader } from '../../TeamTaskReader';
import { RegistryTaskProvider, RegistryTaskProviderError } from '../RegistryTaskProvider';

import type { HttpServices } from '../../../../http';
import type {
  RegistryBoardSnapshotReadPort,
  RegistryTaskReadOptions,
  RegistryTasksReadResult,
} from '../RegistryTaskProvider';
import type { TeamConfig, TeamSpecBinding, TeamSummary, TeamTask } from '@shared/types';

const FILE_TEAM = 'file-team';
const REG_TEAM = 'reg-team';
const DOWN_TEAM = 'down-team';
const PROJECT = 'stgmt/tokenplan';
const SPEC = 'balancer-consistency-hardening';

function makeTask(id: string, subject: string, status: TeamTask['status'] = 'pending'): TeamTask {
  return {
    id,
    subject,
    status,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  };
}

function summary(teamName: string, binding?: { project: string; spec: string }): TeamSummary {
  return {
    teamName,
    displayName: `${teamName} display`,
    description: '',
    memberCount: 1,
    taskCount: 0,
    lastActivity: null,
    ...(binding ? { specScope: { projects: [binding.project], bindings: [binding] } } : {}),
  };
}

interface HarnessOptions {
  teams: TeamSummary[];
  publish?: boolean;
  registryIdentity?: boolean;
  configs?: Record<string, (TeamConfig & { specProject?: string; specSlug?: string }) | null>;
  fileTasks?: (TeamTask & { teamName: string })[];
  getTasks?: (
    teamName: string,
    options?: RegistryTaskReadOptions
  ) => Promise<RegistryTasksReadResult>;
}

const tempRoots: string[] = [];

function deferred<T>() {
  // The repository's TypeScript lib predates the Node runtime's withResolvers.
  const promises = Promise as unknown as {
    withResolvers<Value>(): {
      promise: Promise<Value>;
      resolve: (value: Value) => void;
      reject: (error: unknown) => void;
    };
  };
  return promises.withResolvers<T>();
}

async function responsive<T>(operation: PromiseLike<T>): Promise<T> {
  const deadline = deferred<T>();
  // Real HTTP/worker I/O must progress on the platform clock, not fake timers.
  const timer = setTimeout(
    () => deadline.reject(new Error('Board consumer waited for the registry operation')),
    250
  );
  try {
    return await Promise.race([operation, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

afterEach(async () => {
  setClaudeBasePathOverride(null);
  TeamConfigReader.invalidateListTeamsCache();
  TeamTaskReader.invalidateAllTasksCache();
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }))
  );
});

async function makeService(options: HarnessOptions) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-global-board-'));
  tempRoots.push(root);
  setClaudeBasePathOverride(root);
  TeamConfigReader.invalidateListTeamsCache();
  TeamTaskReader.invalidateAllTasksCache();

  const configReader = new TeamConfigReader();
  const taskReader = new TeamTaskReader();
  const kanbanManager = new TeamKanbanManager();
  const teamMetaStore = new TeamMetaStore();
  const linkedBindings = new Map<string, TeamSpecBinding[]>();

  for (const team of options.teams) {
    const registryTeamId =
      options.registryIdentity === false
        ? undefined
        : (options.configs?.[team.teamName]?.registryTeamId ?? `registry-team-${team.teamName}`);
    const { specProject, specSlug, ...configured } = options.configs?.[team.teamName] ?? {};
    const config: TeamConfig = {
      name: team.teamName,
      ...(team.specScope ? { specScope: team.specScope } : {}),
      ...configured,
      ...(specProject
        ? {
            specScope: {
              projects: [specProject],
              bindings: [{ project: specProject, spec: specSlug ?? '' }],
            },
          }
        : {}),
      registryTeamId,
    };
    const teamDir = path.join(root, 'teams', team.teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    const metadata = {
      cwd: teamDir,
      createdAt: Date.now(),
      registryTeamId,
      ...(config.specScope ? { specScope: config.specScope } : {}),
    };
    if (specProject && !specSlug) {
      // Corrupt persisted input must bypass the validating writer, not fail during fixture setup.
      await fs.writeFile(
        path.join(teamDir, 'team.meta.json'),
        JSON.stringify({ version: 1, ...metadata })
      );
    } else {
      await teamMetaStore.updateMeta(team.teamName, () => metadata);
    }
    linkedBindings.set(team.teamName, [...(config.specScope?.bindings ?? [])]);
  }

  vi.spyOn(configReader, 'listTeams').mockResolvedValue(options.teams);
  const readLocalTasks = vi
    .spyOn(taskReader, 'getAllTasksProjectionSnapshot')
    .mockResolvedValue(options.fileTasks ?? []);

  const registryTaskProvider = new RegistryTaskProvider({
    readConfig: (teamName) => configReader.getConfigSnapshot(teamName),
    clientFactory: async () => {
      throw new Error('Unexpected registry HTTP client access in global board test');
    },
  });
  vi.spyOn(registryTaskProvider, 'getBindings').mockImplementation(async (teamName) => {
    const bindings = linkedBindings.get(teamName);
    if (!bindings) throw new Error(`Unexpected registry team read for ${teamName}`);
    return [...bindings];
  });
  // linkTeamSpec is gone: bindings are configuration, so no registry mock is needed.
  const getTasks = vi
    .spyOn(registryTaskProvider, 'getTasks')
    .mockImplementation(async (teamName, readOptions = {}) => {
      if (!options.getTasks) {
        throw new Error(`Unexpected registry task read for ${teamName}`);
      }
      return options.getTasks(teamName, readOptions);
    });
  vi.spyOn(registryTaskProvider, 'getDeletedTasks').mockResolvedValue({ backed: true, tasks: [] });
  if (options.publish !== false && options.getTasks) {
    for (const [teamName, bindings] of linkedBindings) {
      if (bindings.length === 0 || bindings.some((binding) => !binding.spec)) continue;
      await registryTaskProvider.refreshBoardSnapshot(teamName).catch(() => {
        // A refused publication stays explicit; the board must retain diagnostics.
      });
    }
  }

  const createService = (
    boardSnapshots: RegistryBoardSnapshotReadPort | undefined,
    provider: RegistryTaskProvider | undefined
  ) =>
    new TeamDataService(
      async (teamName) => ({
        teamName,
        runId: null,
        updatedAt: '2026-01-01T00:00:00Z',
        members: {},
      }),
      configReader,
      undefined,
      undefined,
      undefined,
      kanbanManager,
      undefined,
      undefined,
      undefined,
      undefined,
      teamMetaStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      provider,
      undefined,
      undefined,
      undefined,
      undefined,
      boardSnapshots
    );
  const service = createService(undefined, registryTaskProvider);

  return {
    service,
    getTasks,
    readLocalTasks,
    root,
    registryTaskProvider,
    createProjectionService: (snapshots: RegistryBoardSnapshotReadPort) =>
      createService(snapshots, undefined),
  };
}

describe('TeamDataService global board', () => {
  it('reads only registry tasks and reports an unbound team', async () => {
    const { service, getTasks, readLocalTasks } = await makeService({
      teams: [summary(FILE_TEAM), summary(REG_TEAM, { project: PROJECT, spec: SPEC })],
      configs: {
        [FILE_TEAM]: { name: 'File Team', projectPath: '/teams/file' },
        [REG_TEAM]: { name: 'Registry Team', projectPath: '/teams/reg' },
      },
      fileTasks: [{ ...makeTask('1', 'File task'), teamName: FILE_TEAM }],
      getTasks: async () => ({ backed: true, tasks: [makeTask('7', 'Registry task')] }),
    });

    const { tasks, failures } = await service.getAllTasksWithDiagnostics();
    expect(tasks.map((task) => `${task.teamName}:${task.id}`)).toEqual([`${REG_TEAM}:7`]);
    expect(failures).toMatchObject([{ teamName: FILE_TEAM, code: 'SPEC_BINDINGS_INVALID' }]);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(readLocalTasks).not.toHaveBeenCalled();
  });

  it('serves the rest of the board and reports the team when the registry is unavailable', async () => {
    const { service, readLocalTasks } = await makeService({
      teams: [
        summary(FILE_TEAM, { project: PROJECT, spec: 'file-team-spec' }),
        summary(REG_TEAM, { project: PROJECT, spec: SPEC }),
        summary(DOWN_TEAM, { project: PROJECT, spec: 'other-spec' }),
      ],
      configs: {
        [FILE_TEAM]: { name: 'File Team', projectPath: '/teams/file' },
        [REG_TEAM]: { name: 'Registry Team', projectPath: '/teams/reg' },
        [DOWN_TEAM]: { name: 'Down Team', projectPath: '/teams/down' },
      },
      fileTasks: [
        { ...makeTask('1', 'File task'), teamName: FILE_TEAM },
        // Stale local file of a registry-backed team whose registry read fails:
        // it must not pose as the team's canonical board.
        { ...makeTask('5', 'Stale file task'), teamName: DOWN_TEAM },
      ],
      getTasks: async (teamName) => {
        if (teamName === FILE_TEAM)
          return { backed: true, tasks: [makeTask('1', 'Registry task')] };
        if (teamName === DOWN_TEAM) {
          throw new RegistryTaskProviderError({
            code: 'REGISTRY_UNAVAILABLE',
            teamName,
            message: 'registry unreachable',
            project: PROJECT,
            spec: 'other-spec',
            causeCode: 'TRANSPORT_CLOSED',
          });
        }
        return { backed: true, tasks: [makeTask('7', 'Registry task')] };
      },
    });

    const { tasks, failures } = await service.getAllTasksWithDiagnostics();

    expect(tasks.map((task) => `${task.teamName}:${task.id}`)).toEqual([
      `${FILE_TEAM}:1`,
      `${REG_TEAM}:7`,
    ]);
    expect(failures).toMatchObject([
      {
        teamName: DOWN_TEAM,
        project: PROJECT,
        spec: 'other-spec',
        code: 'REGISTRY_UNAVAILABLE',
      },
    ]);

    // The legacy list endpoint must not present an incomplete board as complete.
    await expect(service.getAllTasks()).rejects.toThrow(
      'Global task board unavailable for down-team'
    );
    expect(readLocalTasks).not.toHaveBeenCalled();
  });

  it('reports an unbound team instead of reading stale local tasks', async () => {
    const { service, getTasks, readLocalTasks } = await makeService({
      teams: [summary(FILE_TEAM)],
      configs: { [FILE_TEAM]: { name: 'File Team', projectPath: '/teams/file' } },
      fileTasks: [{ ...makeTask('1', 'File task'), teamName: FILE_TEAM }],
    });

    const { tasks, failures } = await service.getAllTasksWithDiagnostics();

    expect(tasks).toEqual([]);
    expect(failures).toMatchObject([{ teamName: FILE_TEAM, code: 'SPEC_BINDINGS_INVALID' }]);
    expect(getTasks).not.toHaveBeenCalled();
    expect(readLocalTasks).not.toHaveBeenCalled();
  });

  it('reports a half-configured binding instead of falling back to files', async () => {
    const { service, getTasks, readLocalTasks } = await makeService({
      teams: [summary(REG_TEAM)],
      configs: { [REG_TEAM]: { name: 'Registry Team', specProject: PROJECT } },
      fileTasks: [{ ...makeTask('3', 'Orphan file task'), teamName: REG_TEAM }],
    });

    const { tasks, failures } = await service.getAllTasksWithDiagnostics();

    expect(tasks).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      teamName: REG_TEAM,
      code: 'SPEC_SLUG_MISSING',
    });
    // The canonical projection refuses an incomplete binding, so no project is
    // attached and no file fallback may supply one.
    expect(failures[0]).not.toHaveProperty('project');
    expect(getTasks).not.toHaveBeenCalled();
    expect(readLocalTasks).not.toHaveBeenCalled();
  });

  it('aggregates published snapshots without starting an all-team registry scan', async () => {
    const { service, getTasks, readLocalTasks } = await makeService({
      teams: [
        summary(REG_TEAM, { project: PROJECT, spec: SPEC }),
        summary('reg-team-2', { project: PROJECT, spec: 'other-spec' }),
      ],
      getTasks: async (teamName) => ({
        backed: true,
        tasks: [makeTask(teamName === REG_TEAM ? '1' : '2', teamName)],
      }),
    });
    getTasks.mockClear();
    const board = await service.getAllTasksWithDiagnostics();
    expect(board.tasks.map((task) => `${task.teamName}:${task.id}`).sort()).toEqual(
      [`${REG_TEAM}:1`, 'reg-team-2:2'].sort()
    );
    expect(board.failures).toEqual([]);
    expect(getTasks).not.toHaveBeenCalled();
    expect(readLocalTasks).not.toHaveBeenCalled();
  });

  it('retains a successful background refresh for the next board reader', async () => {
    const first = makeTask('1', 'Before refresh');
    const refreshed = makeTask('1', 'After refresh');
    const { service, getTasks } = await makeService({
      teams: [summary(REG_TEAM, { project: PROJECT, spec: SPEC })],
      getTasks: async () => ({ backed: true, tasks: [first] }),
    });
    getTasks.mockResolvedValueOnce({ backed: true, tasks: [refreshed] });
    expect(await service.readTasks(REG_TEAM)).toEqual([first]);
    await nextTurn();
    const slowWrite = deferred<RegistryTasksReadResult>();
    getTasks.mockImplementation(() => slowWrite.promise);
    try {
      expect(await responsive(service.readTasks(REG_TEAM))).toEqual([refreshed]);
    } finally {
      slowWrite.resolve({ backed: true, tasks: [refreshed] });
      await nextTurn();
    }
  });

  it('surfaces a confirmed registry refusal instead of serving stale success', async () => {
    const { service, getTasks } = await makeService({
      teams: [summary(REG_TEAM, { project: PROJECT, spec: SPEC })],
      getTasks: async () => ({ backed: true, tasks: [makeTask('1', 'Previously visible')] }),
    });
    getTasks.mockRejectedValue(
      new RegistryTaskProviderError({
        code: 'REGISTRY_REFUSED',
        teamName: REG_TEAM,
        project: PROJECT,
        spec: SPEC,
        message: 'Project access revoked',
        causeCode: 'PROJECT_NOT_ALLOWED',
      })
    );
    await service.readTasks(REG_TEAM);
    await nextTurn();
    await expect(responsive(service.readTasks(REG_TEAM))).rejects.toMatchObject({
      code: 'REGISTRY_REFUSED',
    });
    await nextTurn();
  });

  it('preserves refused-team diagnostics even while another team has tasks', async () => {
    const { service } = await makeService({
      teams: [
        summary(REG_TEAM, { project: PROJECT, spec: SPEC }),
        summary(DOWN_TEAM, { project: PROJECT, spec: 'restricted' }),
      ],
      getTasks: async (teamName) => {
        if (teamName === DOWN_TEAM)
          throw new RegistryTaskProviderError({
            code: 'REGISTRY_REFUSED',
            teamName,
            project: PROJECT,
            spec: 'restricted',
            message: 'Project access revoked',
            causeCode: 'PROJECT_NOT_ALLOWED',
          });
        return { backed: true, tasks: [makeTask('1', 'Visible task')] };
      },
    });
    await expect(service.readTasks(DOWN_TEAM)).rejects.toMatchObject({
      code: 'REGISTRY_REFUSED',
    });
    const board = await service.getAllTasksWithDiagnostics();
    expect(board.tasks).toEqual([expect.objectContaining({ teamName: REG_TEAM, id: '1' })]);
    expect(board.failures).toEqual([
      expect.objectContaining({
        teamName: DOWN_TEAM,
        code: 'REGISTRY_REFUSED',
        project: PROJECT,
        spec: 'restricted',
      }),
    ]);
    await expect(service.getAllTasks()).rejects.toThrow(DOWN_TEAM);
  });

  it('reports a cold pending board explicitly without waiting or inventing empty success', async () => {
    const pending = deferred<RegistryTasksReadResult>();
    const { service } = await makeService({
      publish: false,
      teams: [summary(REG_TEAM, { project: PROJECT, spec: SPEC })],
      getTasks: () => pending.promise,
    });
    try {
      await expect(responsive(service.getTasks(REG_TEAM))).rejects.toMatchObject({
        code: 'REGISTRY_UNAVAILABLE',
      });
    } finally {
      pending.resolve({ backed: true, tasks: [makeTask('1', 'Eventually available')] });
      await nextTurn();
    }
  });

  it.each(['list', 'detail', 'briefing'])(
    'serves agent %s from the published board during a slow registry operation',
    async (consumer) => {
      const visible = { ...makeTask('1', 'Published registry work'), owner: 'alice' };
      const { service, getTasks, root, registryTaskProvider } = await makeService({
        teams: [summary(REG_TEAM, { project: PROJECT, spec: SPEC })],
        configs: {
          [REG_TEAM]: {
            name: REG_TEAM,
            members: [
              { name: 'lead', agentId: 'lead', agentType: 'team-lead' },
              { name: 'alice', agentId: 'alice', agentType: 'general-purpose' },
            ],
          },
        },
        getTasks: async () => ({ backed: true, tasks: [visible] }),
      });
      const pending = deferred<RegistryTasksReadResult>();
      getTasks.mockImplementation(() => pending.promise);
      vi.spyOn(registryTaskProvider, 'getTask').mockImplementation(async () => {
        await pending.promise;
        return { backed: true, task: visible };
      });
      const app = Fastify();
      registerTeamTaskRoutes(app, { teamDataApi: service } as unknown as HttpServices);
      let worker: Worker | undefined;
      try {
        if (consumer === 'briefing') {
          const url = await app.listen({ host: '127.0.0.1', port: 0 });
          const result = deferred<string>();
          const require = createRequire(import.meta.url);
          worker = new Worker(
            `
            const { parentPort, workerData } = require('node:worker_threads');
            process.env.AGENT_TEAMS_BOUND_CONTROL_URL = workerData.url;
            process.env.AGENT_TEAMS_BOUND_CONTEXT_JSON = JSON.stringify({
              appInstanceId: 'board-red', dataRootFingerprint: 'board-red', connectionGeneration: 1
            });
            process.env.AGENT_TEAMS_MCP_CLAUDE_DIR = workerData.root;
            const { createController } = require(workerData.entry);
            const controller = createController({ teamName: workerData.team, claudeDir: workerData.root });
            Promise.resolve(controller.tasks.taskBriefing('alice'))
              .then(value => parentPort.postMessage(value))
              .catch(error => { throw error; });
          `,
            {
              eval: true,
              workerData: {
                url,
                root,
                team: REG_TEAM,
                entry: require.resolve('../../../../../../agent-teams-controller/src/index.js'),
              },
            }
          );
          worker.once('message', result.resolve);
          worker.once('error', result.reject);
          // Includes real worker startup; the registry promise remains held throughout.
          const timer = setTimeout(
            () => result.reject(new Error('Agent briefing blocked on registry')),
            2_000
          );
          try {
            expect(await result.promise).toContain(visible.subject);
          } finally {
            clearTimeout(timer);
          }
        } else {
          const response = await responsive(
            app.inject({
              method: 'GET',
              url: `/api/teams/${REG_TEAM}/tasks${consumer === 'detail' ? '/1' : ''}`,
            })
          );
          expect(response.statusCode).toBe(200);
          expect(response.json()).toMatchObject(
            consumer === 'detail'
              ? { task: { id: '1', subject: visible.subject } }
              : { tasks: [{ id: '1', subject: visible.subject }] }
          );
        }
      } finally {
        pending.resolve({ backed: true, tasks: [visible] });
        await worker?.terminate();
        await app.close();
        await nextTurn();
      }
    }
  );
});

describe('TeamDataService initial permitted project', () => {
  it('has a readable empty board before the first specification is created', async () => {
    const { service, getTasks, readLocalTasks } = await makeService({
      teams: [
        {
          ...summary(REG_TEAM),
          specScope: { projects: [PROJECT], bindings: [] },
        },
      ],
    });
    expect(await service.getAllTasksWithDiagnostics()).toEqual({ tasks: [], failures: [] });
    expect(getTasks).not.toHaveBeenCalled();
    expect(readLocalTasks).not.toHaveBeenCalled();
  });
});

describe('TeamDataService main-owned task snapshots', () => {
  it('builds a worker UI projection from main authority and propagates a later refusal', async () => {
    const visible = makeTask('7', 'Registry-owned work');
    const main = await makeService({
      teams: [summary(REG_TEAM, { project: PROJECT, spec: SPEC })],
      getTasks: async () => ({ backed: true, tasks: [visible] }),
    });
    const projection = main.createProjectionService(main.service);
    const localDir = path.join(main.root, 'tasks', REG_TEAM);
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(
      path.join(localDir, '99.json'),
      JSON.stringify(makeTask('99', 'Untrusted local canonical task')),
      'utf8'
    );

    const view = await projection.getTeamData(REG_TEAM, { includeMemberBranches: false });
    expect(view.tasks.map((task) => ({ id: task.id, subject: task.subject }))).toEqual([
      { id: '7', subject: visible.subject },
    ]);

    main.getTasks.mockRejectedValue(
      new RegistryTaskProviderError({
        code: 'REGISTRY_REFUSED',
        teamName: REG_TEAM,
        project: PROJECT,
        spec: SPEC,
        message: 'Project access revoked',
      })
    );
    await main.service.readBoardSnapshot(REG_TEAM);
    await nextTurn();
    await expect(
      projection.getTeamData(REG_TEAM, {
        includeMemberBranches: false,
      })
    ).rejects.toMatchObject({ code: 'REGISTRY_REFUSED' });
  });

  it('refuses unconfigured local task files on every canonical read boundary', async () => {
    const { service, root } = await makeService({
      teams: [summary(FILE_TEAM)],
      registryIdentity: false,
    });
    const localDir = path.join(root, 'tasks', FILE_TEAM);
    await fs.mkdir(localDir, { recursive: true });
    await fs.writeFile(
      path.join(localDir, '9.json'),
      JSON.stringify(makeTask('9', 'Legacy canonical task')),
      'utf8'
    );
    await fs.writeFile(
      path.join(localDir, '10.json'),
      JSON.stringify(makeTask('10', 'Legacy deleted task', 'deleted')),
      'utf8'
    );

    for (const read of [
      () => service.getTasks(FILE_TEAM),
      () => service.getTask(FILE_TEAM, '9'),
      () => service.getDeletedTasks(FILE_TEAM),
      () => service.readTaskArtifactData(FILE_TEAM, '9', '123e4567-e89b-42d3-a456-426614174000'),
      () => service.getTeamData(FILE_TEAM, { includeMemberBranches: false }),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: 'REGISTRY_SCOPE_INCOMPLETE' });
    }
  });
});
