import { GetProvisioningStatusUseCase } from '../../core/application/use-cases/GetProvisioningStatusUseCase';

import type { DesktopTeamRuntime } from './createDesktopTeamRuntime';
import type {
  TeamProvisioningRunApi,
  TeamProvisioningStartApi,
  TeamProvisioningStatusApi,
  TeamRuntimeApi,
} from '@main/services/team/contracts/TeamProvisioningApis';

export interface NativeRuntimeSurface {
  provisioningStart: TeamProvisioningStartApi;
  provisioningStatus: TeamProvisioningStatusApi;
  provisioningRun: TeamProvisioningRunApi;
  runtime: TeamRuntimeApi;
}

/** One wiring for the runtime-owned APIs shared by the IPC and HTTP surfaces. */
export function createNativeRuntimeSurface(runtime: DesktopTeamRuntime): NativeRuntimeSurface {
  const status = new GetProvisioningStatusUseCase(runtime);
  return {
    provisioningStart: {
      createTeam: (request, onProgress) => runtime.createTeam(request, onProgress),
      launchTeam: (request, onProgress) => runtime.launchTeam(request, onProgress),
    },
    provisioningStatus: {
      getProvisioningStatus: (runId) => status.execute({ runId }),
    },
    provisioningRun: {
      cancelProvisioning: (runId) => runtime.cancelProvisioning(runId),
      hasProvisioningRun: (teamName) => runtime.hasProvisioningRun(teamName),
    },
    runtime: {
      getRuntimeState: (teamName) => runtime.getRuntimeState(teamName),
      stopTeam: (teamName, expectedRunId) => runtime.stopTeam(teamName, expectedRunId),
      clearStoppedLaneStopBackoff: (teamName) => runtime.clearStoppedLaneStopBackoff(teamName),
      isTeamAlive: (teamName) => runtime.isTeamAlive(teamName),
      getAliveTeams: () => runtime.getAliveTeams(),
      getCurrentRunId: (teamName) => runtime.getCurrentRunId(teamName),
      getStopTargetRunId: (teamName) => runtime.getStopTargetRunId(teamName),
    },
  };
}
