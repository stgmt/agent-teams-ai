import { RegistryTaskProvider } from './registry/RegistryTaskProvider';
import { resolveRegistryBindingConfig } from './registry/TeamSpecBinding';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamMetaStore } from './TeamMetaStore';
import { compactTeamTaskForSnapshot } from './teamTaskSnapshotCompaction';

import type { TeamTask } from '@shared/types';

/** Canonical task reads always resolve the team's required registry binding. */
export class TeamTaskReader {
  private static generation = 0;
  private generation = TeamTaskReader.generation;
  private readonly provider: RegistryTaskProvider;

  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    provider?: RegistryTaskProvider,
    teamMetaStore: TeamMetaStore = new TeamMetaStore()
  ) {
    this.provider =
      provider ??
      new RegistryTaskProvider({
        readConfig: (teamName) =>
          resolveRegistryBindingConfig(teamName, {
            readConfig: (name) => this.configReader.getConfigSnapshot(name),
            readMetadata: (name) => teamMetaStore.getMeta(name),
          }),
      });
  }

  static invalidateAllTasksCache(): void {
    TeamTaskReader.generation += 1;
  }

  private invalidateIfChanged(): void {
    if (this.generation !== TeamTaskReader.generation) {
      this.provider.invalidate();
      this.generation = TeamTaskReader.generation;
    }
  }

  async getTasks(teamName: string): Promise<TeamTask[]> {
    this.invalidateIfChanged();
    return (await this.provider.getTasks(teamName)).tasks;
  }

  async getTasksProjectionSnapshot(teamName: string): Promise<readonly TeamTask[]> {
    return (await this.getTasks(teamName)).map(compactTeamTaskForSnapshot);
  }

  async getNextTaskId(teamName: string): Promise<string> {
    const [active, deleted] = await Promise.all([
      this.getTasks(teamName),
      this.getDeletedTasks(teamName),
    ]);
    const tasks = [...active, ...deleted];
    return String(
      tasks.reduce(
        (max, task) => (/^\d+$/.test(task.id) ? Math.max(max, Number(task.id)) : max),
        0
      ) + 1
    );
  }

  async getDeletedTasks(teamName: string): Promise<TeamTask[]> {
    this.invalidateIfChanged();
    return (await this.provider.getDeletedTasks(teamName)).tasks;
  }

  async getAllTasks(): Promise<(TeamTask & { teamName: string })[]> {
    const names = await this.configReader.listTeamNames();
    const perTeam = await Promise.all(
      names.map(async (teamName) =>
        (await this.getTasks(teamName)).map((task) => ({ ...task, teamName }))
      )
    );
    return perTeam.flat();
  }

  async getAllTasksProjectionSnapshot(): Promise<readonly (TeamTask & { teamName: string })[]> {
    return (await this.getAllTasks()).map((task) => ({
      ...compactTeamTaskForSnapshot(task),
      teamName: task.teamName,
    }));
  }
}
