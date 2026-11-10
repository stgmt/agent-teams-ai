// @vitest-environment node
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TeamConfigReader } from '../../TeamConfigReader';
import { TeamDataService } from '../../TeamDataService';
import { TeamKanbanManager } from '../../TeamKanbanManager';
import { TeamMetaStore } from '../../TeamMetaStore';
import { TeamTaskReader } from '../../TeamTaskReader';
import { setClaudeBasePathOverride } from '../../../../utils/pathDecoder';
import { RegistryTaskProvider, RegistryTaskProviderError } from '../RegistryTaskProvider';

import type { RegistryTaskReadOptions, RegistryTasksReadResult } from '../RegistryTaskProvider';
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
    ...(binding ? { specBindings: [binding] } : {}),
  };
}

interface HarnessOptions {
  teams: TeamSummary[];
  configs?: Record<string, TeamConfig | null>;
  fileTasks?: (TeamTask & { teamName: string })[];
  getTasks?: (
    teamName: string,
    options?: RegistryTaskReadOptions
  ) => Promise<RegistryTasksReadResult>;
}

const tempRoots: string[] = [];

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
  const teamNameByRegistryId = new Map<string, string>();

  for (const team of options.teams) {
    const registryTeamId =
      options.configs?.[team.teamName]?.registryTeamId ?? `registry-team-${team.teamName}`;
    const config: TeamConfig = {
      name: team.teamName,
      ...(team.specBindings ? { specBindings: team.specBindings } : {}),
      ...(options.configs?.[team.teamName] ?? {}),
      registryTeamId,
    };
    const teamDir = path.join(root, 'teams', team.teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(path.join(teamDir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    await teamMetaStore.updateMeta(team.teamName, () => ({
      cwd: teamDir,
      createdAt: Date.now(),
      registryTeamId,
    }));
    linkedBindings.set(team.teamName, [...(config.specBindings ?? [])]);
    teamNameByRegistryId.set(registryTeamId, team.teamName);
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

  const service = new TeamDataService(
    configReader,
    taskReader,
    undefined,
    undefined,
    undefined,
    undefined,
    kanbanManager,
    undefined,
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
    registryTaskProvider
  );

  return { service, getTasks, readLocalTasks };
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
    expect(failures).toMatchObject([{ teamName: FILE_TEAM, code: 'SPEC_PROJECT_MISSING' }]);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledWith(REG_TEAM, {
      binding: { project: PROJECT, spec: SPEC },
    });
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
    expect(failures).toEqual([
      {
        teamName: DOWN_TEAM,
        project: PROJECT,
        spec: 'other-spec',
        code: 'REGISTRY_UNAVAILABLE',
        message: 'registry unreachable',
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
    expect(failures).toMatchObject([{ teamName: FILE_TEAM, code: 'SPEC_PROJECT_MISSING' }]);
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
      project: PROJECT,
      code: 'SPEC_SLUG_MISSING',
    });
    expect(getTasks).not.toHaveBeenCalled();
    expect(readLocalTasks).not.toHaveBeenCalled();
  });

  it('reads each bound team once per board build, not once per task', async () => {
    const { service, getTasks } = await makeService({
      teams: [
        summary(REG_TEAM, { project: PROJECT, spec: SPEC }),
        summary('reg-team-2', { project: PROJECT, spec: 'other-spec' }),
      ],
      configs: {
        [REG_TEAM]: { name: 'Registry Team' },
        'reg-team-2': { name: 'Registry Team 2' },
      },
      getTasks: async (teamName) =>
        teamName === REG_TEAM
          ? { backed: true, tasks: [makeTask('1', 'A'), makeTask('2', 'B'), makeTask('3', 'C')] }
          : { backed: true, tasks: [makeTask('4', 'D')] },
    });

    await service.getAllTasks();

    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getTasks.mock.calls.map(([teamName]) => teamName).sort()).toEqual(
      [REG_TEAM, 'reg-team-2'].sort()
    );
  });
});
