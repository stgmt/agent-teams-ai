// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { TeamDataService } from '../../TeamDataService';
import { RegistryTaskProviderError } from '../RegistryTaskProvider';

import type { RegistryTaskProvider, RegistryTasksReadResult } from '../RegistryTaskProvider';
import type { TeamConfig, TeamSummary, TeamTask } from '@shared/types';
import type { Mock } from 'vitest';

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
  } as TeamTask;
}

function summary(teamName: string, binding?: { project: string; spec: string }): TeamSummary {
  return {
    teamName,
    displayName: `${teamName} display`,
    description: '',
    memberCount: 1,
    taskCount: 0,
    lastActivity: null,
    ...(binding ? { specProject: binding.project, specSlug: binding.spec } : {}),
  } as TeamSummary;
}

interface HarnessOptions {
  teams: TeamSummary[];
  configs?: Record<string, TeamConfig | null>;
  fileTasks?: (TeamTask & { teamName: string })[];
  getTasks?: (teamName: string) => Promise<RegistryTasksReadResult>;
}

function makeService(options: HarnessOptions): {
  service: TeamDataService;
  getTasks: Mock<(teamName: string) => Promise<RegistryTasksReadResult>>;
} {
  const configs = options.configs ?? {};
  const configReader = {
    getConfigSnapshot: async (teamName: string) => configs[teamName] ?? null,
    listTeams: async () => options.teams,
  };
  const fileTasks = options.fileTasks ?? [];
  const taskReader = {
    getAllTasksProjectionSnapshot: async () => fileTasks,
  };
  const kanbanManager = { getState: async () => ({ tasks: {} }) };
  const getTasks: Mock<(teamName: string) => Promise<RegistryTasksReadResult>> = vi.fn(
    options.getTasks ?? (async () => ({ backed: false }))
  );

  const service = new TeamDataService(
    configReader as never,
    taskReader as never,
    undefined,
    undefined,
    undefined,
    undefined,
    kanbanManager as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { getTasks } as unknown as RegistryTaskProvider
  );

  return { service, getTasks };
}

describe('TeamDataService global board', () => {
  it('merges file-backed and registry-backed teams and passes the known binding', async () => {
    const { service, getTasks } = makeService({
      teams: [summary(FILE_TEAM), summary(REG_TEAM, { project: PROJECT, spec: SPEC })],
      configs: {
        [FILE_TEAM]: { name: 'File Team', projectPath: '/teams/file' } as TeamConfig,
        [REG_TEAM]: { name: 'Registry Team', projectPath: '/teams/reg' } as TeamConfig,
      },
      fileTasks: [{ ...makeTask('1', 'File task'), teamName: FILE_TEAM }],
      getTasks: async () => ({ backed: true, tasks: [makeTask('7', 'Registry task')] }),
    });

    const tasks = await service.getAllTasks();

    expect(tasks.map((task) => `${task.teamName}:${task.id}`)).toEqual([
      `${FILE_TEAM}:1`,
      `${REG_TEAM}:7`,
    ]);
    expect(getTasks).toHaveBeenCalledTimes(1);
    expect(getTasks).toHaveBeenCalledWith(REG_TEAM, {
      binding: { project: PROJECT, spec: SPEC },
    });
  });

  it('serves the rest of the board and reports the team when the registry is unavailable', async () => {
    const { service } = makeService({
      teams: [
        summary(FILE_TEAM),
        summary(REG_TEAM, { project: PROJECT, spec: SPEC }),
        summary(DOWN_TEAM, { project: PROJECT, spec: 'other-spec' }),
      ],
      configs: {
        [FILE_TEAM]: { name: 'File Team', projectPath: '/teams/file' } as TeamConfig,
        [REG_TEAM]: { name: 'Registry Team', projectPath: '/teams/reg' } as TeamConfig,
        [DOWN_TEAM]: { name: 'Down Team', projectPath: '/teams/down' } as TeamConfig,
      },
      fileTasks: [
        { ...makeTask('1', 'File task'), teamName: FILE_TEAM },
        // Stale local file of a registry-backed team whose registry read fails:
        // it must not pose as the team's canonical board.
        { ...makeTask('5', 'Stale file task'), teamName: DOWN_TEAM },
      ],
      getTasks: async (teamName) => {
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

    // `getAllTasks` keeps its shape: partial board, no throw. The failure is
    // surfaced as one console warning for the dropped team, which the suite's
    // shared "no unexpected console output" invariant would otherwise flag.
    const warnMock = console.warn as unknown as Mock;
    warnMock.mockClear();
    await expect(service.getAllTasks()).resolves.toHaveLength(2);
    expect(warnMock.mock.calls.map((call) => String(call[1]))).toEqual([
      expect.stringContaining(`team=${DOWN_TEAM} code=REGISTRY_UNAVAILABLE`),
    ]);
    warnMock.mockClear();
  });

  it('keeps the file-only board untouched when no team carries a binding', async () => {
    const { service, getTasks } = makeService({
      teams: [summary(FILE_TEAM)],
      configs: { [FILE_TEAM]: { name: 'File Team', projectPath: '/teams/file' } as TeamConfig },
      fileTasks: [{ ...makeTask('1', 'File task'), teamName: FILE_TEAM }],
    });

    const { tasks, failures } = await service.getAllTasksWithDiagnostics();

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: '1', teamName: FILE_TEAM, teamDisplayName: 'File Team' });
    expect(failures).toEqual([]);
    expect(getTasks).not.toHaveBeenCalled();
  });

  it('reports a half-configured binding instead of falling back to files', async () => {
    const { service, getTasks } = makeService({
      teams: [{ ...summary(REG_TEAM), specProject: PROJECT } as TeamSummary],
      configs: { [REG_TEAM]: { name: 'Registry Team' } as TeamConfig },
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
  });

  it('reads each bound team once per board build, not once per task', async () => {
    const { service, getTasks } = makeService({
      teams: [
        summary(REG_TEAM, { project: PROJECT, spec: SPEC }),
        summary('reg-team-2', { project: PROJECT, spec: 'other-spec' }),
      ],
      configs: {
        [REG_TEAM]: { name: 'Registry Team' } as TeamConfig,
        'reg-team-2': { name: 'Registry Team 2' } as TeamConfig,
      },
      getTasks: async (teamName) =>
        teamName === REG_TEAM
          ? { backed: true, tasks: [makeTask('1', 'A'), makeTask('2', 'B'), makeTask('3', 'C')] }
          : { backed: true, tasks: [makeTask('4', 'D')] },
    });

    await service.getAllTasks();

    expect(getTasks).toHaveBeenCalledTimes(2);
    expect(getTasks.mock.calls.map(([teamName]) => teamName)).toEqual([REG_TEAM, 'reg-team-2']);
  });
});
