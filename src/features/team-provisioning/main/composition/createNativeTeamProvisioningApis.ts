import { GetProvisioningStatusUseCase } from '../../core/application/use-cases/GetProvisioningStatusUseCase';
import { NativeTeamMemberLifecycleApi } from '../adapters/input/NativeTeamMemberLifecycleApi';
import { NativeTeamMessagingApi } from '../adapters/input/NativeTeamMessagingApi';
import { NativeTeamToolApprovalApi } from '../adapters/input/NativeTeamToolApprovalApi';
import { NativeTeamClaudeLogs } from '../adapters/output/NativeTeamClaudeLogs';
import { NativeTeamDiagnostics } from '../adapters/output/NativeTeamDiagnostics';

import { createBoundTeamLiveStatusQueries } from './createBoundTeamLiveStatusQueries';

import type { NativeDesktopTeamRuntime } from './createNativeDesktopTeamRuntime';
import type {
  TeamIpcHandlerApis,
  TeamProvisioningPreflightApi,
  TeamTaskActivityRepairApi,
} from '@main/services/team/contracts/TeamProvisioningApis';

export interface NativeTeamProvisioningApisDependencies {
  runtime: NativeDesktopTeamRuntime;
  preflight: TeamProvisioningPreflightApi;
  taskActivity: TeamTaskActivityRepairApi;
  now(): string;
}

/**
 * Assembles the native `TeamIpcHandlerApis` surface over one runtime owner.
 * Blocked rows (OpenCode member delivery, lead activity/context, attach/detach)
 * stay explicit fail-closed methods in their adapters; transport wiring and the
 * production switch remain phase 8.
 */
export function createNativeTeamProvisioningApis(
  deps: NativeTeamProvisioningApisDependencies
): TeamIpcHandlerApis {
  const lifecycle = deps.runtime.lifecycle;
  const owner = lifecycle.owner;
  const statuses = createBoundTeamLiveStatusQueries({
    owner,
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
    preflight: deps.preflight,
    provisioningRun: {
      cancelProvisioning: (runId) => deps.runtime.runtime.cancelProvisioning(runId),
      hasProvisioningRun: (teamName) => deps.runtime.runtime.hasProvisioningRun(teamName),
    },
    taskActivity: deps.taskActivity,
    runtime: {
      getRuntimeState: (teamName) => deps.runtime.runtime.getRuntimeState(teamName),
      stopTeam: (teamName) => deps.runtime.runtime.stopTeam(teamName),
      isTeamAlive: (teamName) => deps.runtime.runtime.isTeamAlive(teamName),
      getAliveTeams: () => deps.runtime.runtime.getAliveTeams(),
      getCurrentRunId: (teamName) => deps.runtime.runtime.getCurrentRunId(teamName),
    },
    memberLifecycle: new NativeTeamMemberLifecycleApi({
      owner,
      runs: lifecycle.runs,
      commands: lifecycle.memberCommands,
      statuses,
    }),
    diagnostics: new NativeTeamDiagnostics(statuses),
    claudeLogs: new NativeTeamClaudeLogs(deps.runtime.logs),
    messaging: new NativeTeamMessagingApi({
      runs: lifecycle.runs,
      settings: lifecycle.settings,
      sendLeadMessage: lifecycle.sendLeadMessage,
      relayLeadInboxMessages: (teamName) => lifecycle.relay.relay(teamName),
    }),
    toolApproval: new NativeTeamToolApprovalApi({
      runs: lifecycle.runs,
      commands: lifecycle.memberCommands,
      claudeApprovals: lifecycle.approvals,
      settings: lifecycle.toolApprovalSettings,
    }),
  };
}
