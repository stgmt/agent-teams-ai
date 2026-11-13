import type { TeamAgentRuntimeSnapshot, TeamProcess } from '../../src/shared/types';
import type { TeamConfig } from '../../src/shared/types';
import { TeamConfigReader } from '../../src/main/services/team/TeamConfigReader';
import type { TeamTaskReader } from '../../src/main/services/team/TeamTaskReader';
import type { RegistryBoardSnapshotReadPort } from '../../src/main/services/team/registry/RegistryTaskProvider';
import { TeamMetaStore } from '../../src/main/services/team/TeamMetaStore';
import { TeamDataService } from '../../src/main/services/team/TeamDataService';
import type { RegistryTaskProvider } from '../../src/main/services/team/registry/RegistryTaskProvider';
import type { TeamRegistryTaskWriterProvider } from '../../src/main/services/team/TeamDataRegistryTaskOperations';
import type { TeamKanbanManager } from '../../src/main/services/team/TeamKanbanManager';

/** Config/task fixtures with no running agents explicitly project an empty lifecycle. */
export async function knownEmptyTeamRuntimeSnapshot(
  teamName: string
): Promise<TeamAgentRuntimeSnapshot> {
  return { teamName, runId: null, updatedAt: '2026-11-12T00:00:00.000Z', members: {} };
}

/** Project the process seeds owned by a unit fixture, never a persisted production registry. */
export function teamRuntimeSnapshotFromProcesses(
  teamName: string,
  processes: readonly TeamProcess[]
): TeamAgentRuntimeSnapshot {
  return {
    teamName,
    runId: null,
    updatedAt: '2026-11-12T00:00:00.000Z',
    members: Object.fromEntries(
      processes.map((process) => [
        process.label,
        {
          memberName: process.label,
          alive: !process.stoppedAt,
          restartable: false,
          runtimePid: process.pid,
          updatedAt: process.registeredAt,
          ...(process.command ? { processCommand: process.command } : {}),
        },
      ])
    ),
  };
}

/** Explicitly configured registry scope for unit fixtures with seeded canonical tasks. */
function registryFixtureScope(config: TeamConfig | null): TeamConfig | null {
  if (!config) return null;
  return {
    ...config,
    specScope: config.specScope ?? {
      projects: ['owner/project'],
      bindings: [{ project: 'owner/project', spec: 'fixture' }],
    },
  };
}

/** Keep fixture config mocks intact while declaring the registry authority of their task seeds. */
export function registryTaskFixtureConfigReader(reader: TeamConfigReader): TeamConfigReader {
  return new Proxy(reader, {
    get(target, property, receiver) {
      if (property === 'getConfig' || property === 'getConfigSnapshot') {
        const source =
          property === 'getConfigSnapshot'
            ? (target.getConfigSnapshot ?? target.getConfig)
            : target.getConfig;
        return async (teamName: string) =>
          registryFixtureScope(await source.call(target, teamName));
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** Canonical metadata paired with the explicitly scoped unit config above. No production writes. */
export function registryTaskFixtureMetaStore(
  store: TeamMetaStore = new TeamMetaStore()
): TeamMetaStore {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getMeta') {
        return async (teamName: string) => {
          const meta = typeof target.getMeta === 'function' ? await target.getMeta(teamName) : null;
          return {
            cwd: '',
            createdAt: 0,
            registryRegistrationCompleted: true,
            ...meta,
            specScope: meta?.specScope ?? {
              projects: ['owner/project'],
              bindings: [{ project: 'owner/project', spec: 'fixture' }],
            },
          };
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
}

/** A narrow registry board port over the task state explicitly seeded by a unit fixture. */
export function registryBoardSnapshotFixture(
  tasks: Pick<TeamTaskReader, 'getTasks'>
): RegistryBoardSnapshotReadPort {
  return { readBoardSnapshot: (teamName) => tasks.getTasks(teamName) };
}

/** Unit-only assembly: the caller supplies canonical registry rows, never local task fallback. */
export function registryTaskFixtureService(
  board: RegistryBoardSnapshotReadPort,
  configReader = new TeamConfigReader(),
  options: {
    provider?: RegistryTaskProvider;
    writerProvider?: TeamRegistryTaskWriterProvider;
    kanbanManager?: TeamKanbanManager;
  } = {}
): TeamDataService {
  return new TeamDataService(
    knownEmptyTeamRuntimeSnapshot,
    registryTaskFixtureConfigReader(configReader),
    undefined,
    undefined,
    undefined,
    options.kanbanManager,
    undefined,
    undefined,
    undefined,
    undefined,
    registryTaskFixtureMetaStore(),
    undefined,
    undefined,
    undefined,
    undefined,
    options.writerProvider,
    options.provider,
    undefined,
    undefined,
    undefined,
    undefined,
    board
  );
}
