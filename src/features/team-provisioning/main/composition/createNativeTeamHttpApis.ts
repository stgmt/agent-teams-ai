import { GetProvisioningStatusUseCase } from '../../core/application/use-cases/GetProvisioningStatusUseCase';

import { createBoundTeamLiveStatusQueries } from './createBoundTeamLiveStatusQueries';

import type { NativeDesktopTeamRuntime } from './createNativeDesktopTeamRuntime';
import type {
  TeamHttpHandlerApis,
  TeamRuntimeControlCompatibilityApi,
  TeamTaskActivityRepairApi,
} from '@main/services/team/contracts/TeamProvisioningApis';

export interface NativeTeamHttpApisDependencies {
  runtime: NativeDesktopTeamRuntime;
  taskActivity: TeamTaskActivityRepairApi;
  runtimeControl: TeamRuntimeControlCompatibilityApi;
  now(): string;
}

/**
 * HTTP half of the native team surface. Read-only member diagnostics share the
 * same context-fenced live projection as IPC; runtime control stays a pure
 * OpenCode bridge service.
 */
export function createNativeTeamHttpApis(
  deps: NativeTeamHttpApisDependencies
): TeamHttpHandlerApis {
  const lifecycle = deps.runtime.lifecycle;
  const statuses = createBoundTeamLiveStatusQueries({
    owner: lifecycle.owner,
    queries: lifecycle.queries,
    now: deps.now,
  });
  const status = new GetProvisioningStatusUseCase(deps.runtime.runtime);
  return {
    provisioningStart: {
      createTeam: (request, onProgress) => deps.runtime.runtime.createTeam(request, onProgress),
      launchTeam: (request, onProgress) => deps.runtime.runtime.launchTeam(request, onProgress),
    },
    provisioningStatus: {
      getProvisioningStatus: (runId) => status.execute({ runId }),
    },
    taskActivity: deps.taskActivity,
    runtime: {
      getRuntimeState: (teamName) => deps.runtime.runtime.getRuntimeState(teamName),
      stopTeam: (teamName) => deps.runtime.runtime.stopTeam(teamName),
      getAliveTeams: () => deps.runtime.runtime.getAliveTeams(),
    },
    runtimeControl: deps.runtimeControl,
    memberDiagnostics: {
      getMemberSpawnStatusesReadOnly: (teamName) => statuses.memberSpawnStatuses({ teamName }),
      getTeamAgentRuntimeSnapshotReadOnly: (teamName) => statuses.runtimeSnapshot({ teamName }),
    },
  };
}
