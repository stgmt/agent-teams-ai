import { yieldToEventLoop } from '@main/utils/asyncYield';
import type { GlobalTask, KanbanState, TeamConfig, TeamTask } from '@shared/types';

import {
  RegistryTaskProviderError,
  type RegistryTaskProvider,
} from './registry/RegistryTaskProvider';
import {
  resolveTeamSpecBinding,
  type TeamSpecBinding,
  type TeamSpecBindingConfig,
  TeamSpecBindingError,
} from './registry/TeamSpecBinding';
import { resolveProjectPathFromConfig, type TeamConfigReader } from './TeamConfigReader';
import type { TeamKanbanManager } from './TeamKanbanManager';
import { resolveTaskKanbanColumn, resolveTaskReviewState } from './TeamTaskWorkflowProjection';

const TASK_MAP_YIELD_EVERY = 250;
const GLOBAL_TASK_TEAM_FANOUT_CONCURRENCY = 12;

interface GlobalTaskTeamInfo {
  displayName: string;
  projectPath?: string;
  deletedAt?: string;
}

interface GlobalTeamSpecCensus {
  teamName: string;
  specProject?: string;
  specSlug?: string;
}

/**
 * One team kept off the global board because its registry-backed task state
 * could not be read. The rest of the board is still served: the file-backed
 * teams and the registry teams that answered stay visible.
 */
export interface GlobalBoardTeamFailure {
  teamName: string;
  /** Registry scope, when the team's binding was readable. */
  project?: string;
  spec?: string;
  /** `RegistryTaskProviderErrorCode`, `TeamSpecBindingErrorCode`, or `UNKNOWN`. */
  code: string;
  message: string;
}

async function mapLimitLocal<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= items.length) {
          return;
        }
        results[index] = await mapper(items[index]);
      }
    })
  );

  return results;
}

export class TeamGlobalTaskBoardReader {
  constructor(
    private readonly configReader: TeamConfigReader,
    private readonly registryTaskProvider: RegistryTaskProvider,
    private readonly kanbanManager: TeamKanbanManager,
    private readonly readSnapshotConfig: (teamName: string) => Promise<TeamConfig | null>,
    private readonly readRegistryBindingConfig: (
      teamName: string
    ) => Promise<TeamSpecBindingConfig | null>
  ) {}

  /** Global board reads fail rather than presenting a partial board as complete. */
  async getAllTasks(): Promise<GlobalTask[]> {
    const { tasks, failures } = await this.getAllTasksWithDiagnostics();
    if (failures.length > 0) {
      throw new Error(
        `Global task board unavailable for ${failures.map((failure) => failure.teamName).join(', ')}`
      );
    }
    return tasks;
  }

  async getAllTasksWithDiagnostics(): Promise<{
    tasks: GlobalTask[];
    failures: GlobalBoardTeamFailure[];
  }> {
    const census = await this.readTeamSpecCensus();
    const registry = await this.readRegistryBackedGlobalTasks(census);
    const rawTasks = registry.tasks;
    const teamInfoMap = await this.readGlobalTaskTeamInfo(rawTasks);

    const MAX_GLOBAL_TASKS_EXPORTED = 500;
    let tasksToExport = rawTasks.filter((task) => teamInfoMap.has(task.teamName));
    if (tasksToExport.length > MAX_GLOBAL_TASKS_EXPORTED) {
      // Prefer newest first before reading kanban and building the lightweight IPC projection.
      tasksToExport = tasksToExport
        .slice()
        .sort((a, b) => {
          const at = Date.parse(a.updatedAt ?? a.createdAt ?? '') || 0;
          const bt = Date.parse(b.updatedAt ?? b.createdAt ?? '') || 0;
          return bt - at;
        })
        .slice(0, MAX_GLOBAL_TASKS_EXPORTED);
    }

    const teamNames = [...new Set(tasksToExport.map((task) => task.teamName))];
    const kanbanByTeam = new Map<string, KanbanState>();
    await Promise.all(
      teamNames.map(async (teamName) => {
        try {
          const state = await this.kanbanManager.getState(teamName);
          kanbanByTeam.set(teamName, state);
        } catch {
          // ignore
        }
      })
    );

    const out: GlobalTask[] = [];
    let processed = 0;
    for (const task of tasksToExport) {
      const info = teamInfoMap.get(task.teamName)!;
      const kanbanTaskState = kanbanByTeam.get(task.teamName)?.tasks[task.id];
      const reviewState = resolveTaskReviewState(task, kanbanTaskState);
      const kanbanColumn = resolveTaskKanbanColumn(task, kanbanTaskState, reviewState);

      // IPC payload safety: GlobalTask lists can be enormous (especially comments and large nested fields).
      // Return a "light" task object and defer heavy details to team/task detail views.
      const projectPath = task.projectPath ?? info.projectPath;
      const subject =
        typeof task.subject === 'string'
          ? task.subject.slice(0, 300)
          : String(task.subject).slice(0, 300);
      out.push({
        id: task.id,
        subject,
        owner: task.owner,
        status: task.status,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        projectPath,
        needsClarification: task.needsClarification,
        deletedAt: task.deletedAt,
        reviewState,
        // Keep dependency state in the lightweight snapshot. Otherwise opening a
        // team hydrates old blockers and the renderer reports them as new.
        blockedBy: Array.isArray(task.blockedBy)
          ? task.blockedBy.filter((id): id is string => typeof id === 'string')
          : undefined,
        // IMPORTANT: comments MUST be included here (at least lightweight metadata).
        //
        // Previously comments were omitted from GlobalTask payload to keep IPC small.
        // This silently broke task comment notifications in the renderer: the store's
        // detectTaskCommentNotifications() compares oldTask.comments vs newTask.comments
        // to find new comments and fire native OS toasts. Without comments in the payload,
        // both counts were always 0 → newCommentCount <= oldCommentCount → every comment
        // was silently skipped → "Task comment notifications" toggle had no effect.
        //
        // Fix: include lightweight comment metadata (id, author, truncated text for toast
        // preview, createdAt, type). Full text and attachments are still omitted — those
        // are loaded on-demand by the task detail view via team:getTask.
        comments: Array.isArray(task.comments)
          ? task.comments.map((c) => ({
              id: c.id,
              author: c.author,
              text: c.text.slice(0, 120),
              createdAt: c.createdAt,
              type: c.type,
            }))
          : undefined,
        kanbanColumn,
        teamName: task.teamName,
        teamDisplayName: info.displayName,
        teamDeleted: Boolean(info.deletedAt) || undefined,
      });
      processed++;
      if (processed % TASK_MAP_YIELD_EVERY === 0) {
        await yieldToEventLoop();
      }
    }

    return { tasks: out, failures: registry.failures };
  }

  private async readGlobalTaskTeamInfoFromListTeams(): Promise<Map<string, GlobalTaskTeamInfo>> {
    const teams = await this.configReader.listTeams();
    const teamInfoMap = new Map<string, GlobalTaskTeamInfo>();
    for (const team of teams) {
      teamInfoMap.set(team.teamName, {
        displayName: team.displayName,
        projectPath: team.projectPath,
        deletedAt: team.deletedAt,
      });
    }
    return teamInfoMap;
  }

  private async readGlobalTaskTeamInfo(
    rawTasks: readonly (TeamTask & { teamName: string })[]
  ): Promise<Map<string, GlobalTaskTeamInfo>> {
    const readerMethods: { getConfigSnapshot?: unknown; getConfig?: unknown } = this.configReader;
    const canReadConfigDirectly =
      typeof readerMethods.getConfigSnapshot === 'function' ||
      typeof readerMethods.getConfig === 'function';
    if (!canReadConfigDirectly) {
      return this.readGlobalTaskTeamInfoFromListTeams();
    }

    const teamNames = [...new Set(rawTasks.map((task) => task.teamName))];
    const entries = await mapLimitLocal(
      teamNames,
      GLOBAL_TASK_TEAM_FANOUT_CONCURRENCY,
      async (teamName) => {
        const config = await this.readSnapshotConfig(teamName).catch(() => null);
        const displayName = config?.name?.trim();
        if (!config || !displayName) {
          return null;
        }
        return [
          teamName,
          {
            displayName,
            projectPath: resolveProjectPathFromConfig(config),
            deletedAt: typeof config.deletedAt === 'string' ? config.deletedAt : undefined,
          },
        ] as const;
      }
    );

    if (entries.some((entry) => entry === null)) {
      return this.readGlobalTaskTeamInfoFromListTeams();
    }

    return new Map(entries.filter((entry): entry is NonNullable<typeof entry> => entry !== null));
  }

  /**
   * Registry half of the global board.
   *
   * Only teams that carry `specProject` + `specSlug` participate; their rows
   * are read through {@link RegistryTaskProvider}, whose TTL cache and in-flight
   * dedupe absorb repeated board renders, so N teams cost at most N registry
   * reads per TTL window rather than N per render. The read is bounded by the
   * same concurrency limit the team-config fan-out uses.
   *
   * Failures are per team: an unreachable registry drops that team's rows and
   * lands in `failures`, while every other team is still served.
   */
  /** Read each team's registry binding, including saved but unlaunched drafts. */
  private async readTeamSpecCensus(): Promise<GlobalTeamSpecCensus[]> {
    const names = await this.configReader.listTeamNames();
    const out: GlobalTeamSpecCensus[] = [];
    await Promise.all(
      names.map(async (teamName) => {
        const binding = await this.readRegistryBindingConfig(teamName);
        out.push({
          teamName,
          ...(typeof binding?.specProject === 'string' ? { specProject: binding.specProject } : {}),
          ...(typeof binding?.specSlug === 'string' ? { specSlug: binding.specSlug } : {}),
        });
      })
    );
    return out;
  }

  private async readRegistryBackedGlobalTasks(teams: readonly GlobalTeamSpecCensus[]): Promise<{
    tasks: (TeamTask & { teamName: string })[];
    backedTeamNames: Set<string>;
    failures: GlobalBoardTeamFailure[];
  }> {
    const failures: GlobalBoardTeamFailure[] = [];
    const backedTeamNames = new Set<string>();
    const scopes: { teamName: string; binding: TeamSpecBinding }[] = [];

    for (const team of teams) {
      let binding: TeamSpecBinding;
      try {
        binding = resolveTeamSpecBinding(
          { specProject: team.specProject, specSlug: team.specSlug },
          team.teamName
        );
      } catch (error) {
        if (!(error instanceof TeamSpecBindingError)) {
          throw error;
        }
        // Half-configured binding: the team is registry-backed, but its scope
        // cannot be addressed. Reporting it beats showing a file board the
        // registry does not back.
        backedTeamNames.add(team.teamName);
        failures.push({
          teamName: team.teamName,
          ...(team.specProject ? { project: team.specProject } : {}),
          ...(team.specSlug ? { spec: team.specSlug } : {}),
          code: error.code,
          message: error.message,
        });
        continue;
      }
      backedTeamNames.add(team.teamName);
      scopes.push({ teamName: team.teamName, binding });
    }

    const perTeam = await mapLimitLocal(
      scopes,
      GLOBAL_TASK_TEAM_FANOUT_CONCURRENCY,
      async ({ teamName, binding }) => {
        try {
          const result = await this.registryTaskProvider.getTasks(teamName, { binding });
          return result.tasks.map((task) => ({ ...task, teamName }));
        } catch (error) {
          failures.push(
            error instanceof RegistryTaskProviderError
              ? {
                  teamName,
                  project: error.project ?? binding.project,
                  spec: error.spec ?? binding.spec,
                  code: error.code,
                  message: error.message,
                }
              : {
                  teamName,
                  project: binding.project,
                  spec: binding.spec,
                  code: 'UNKNOWN',
                  message: error instanceof Error ? error.message : String(error),
                }
          );
          return [];
        }
      }
    );

    return { tasks: perTeam.flat(), backedTeamNames, failures };
  }
}
