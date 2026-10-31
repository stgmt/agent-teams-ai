import { NativeTeamMemberLifecycleApi } from '../adapters/input/NativeTeamMemberLifecycleApi';
import { NativeTeamMessagingApi } from '../adapters/input/NativeTeamMessagingApi';
import { NativeTeamToolApprovalApi } from '../adapters/input/NativeTeamToolApprovalApi';
import { NativeTeamClaudeLogs } from '../adapters/output/NativeTeamClaudeLogs';
import { NativeTeamDiagnostics } from '../adapters/output/NativeTeamDiagnostics';

import { createBoundTeamLiveStatusQueries } from './createBoundTeamLiveStatusQueries';
import { createNativeRuntimeSurface } from './createNativeRuntimeSurface';

import type { NativeOpenCodeMemberDeliveryPort } from '../adapters/input/NativeTeamMessagingApi';
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
  /** Removes the member from durable team data after native detach. */
  detachMemberData?(teamName: string, memberName: string): Promise<void>;
  /** Production OpenCode member prompt ledger; owns delivery state, not runs. */
  openCodeMemberDelivery?: NativeOpenCodeMemberDeliveryPort;
  now(): string;
}

/**
 * Assembles the native `TeamIpcHandlerApis` surface over one runtime owner.
 * Unmigrated rows (live lead process messages, OpenCode lane lead delivery)
 * stay explicit fail-closed methods in their adapters; always-on composition
 * and the production switch remain phase 8.
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
  const surface = createNativeRuntimeSurface(deps.runtime.runtime);
  return {
    provisioningStart: surface.provisioningStart,
    provisioningStatus: surface.provisioningStatus,
    preflight: deps.preflight,
    provisioningRun: surface.provisioningRun,
    taskActivity: deps.taskActivity,
    runtime: surface.runtime,
    memberLifecycle: new NativeTeamMemberLifecycleApi({
      owner,
      runs: lifecycle.runs,
      commands: lifecycle.memberCommands,
      statuses,
      ...(deps.detachMemberData ? { detachMemberData: deps.detachMemberData } : {}),
    }),
    diagnostics: new NativeTeamDiagnostics({
      statuses,
      runs: lifecycle.runs,
      logs: deps.runtime.logs,
    }),
    claudeLogs: new NativeTeamClaudeLogs(deps.runtime.logs),
    messaging: new NativeTeamMessagingApi({
      runs: lifecycle.runs,
      settings: lifecycle.settings,
      sendLeadMessage: lifecycle.sendLeadMessage,
      relayLeadInboxMessages: (teamName) => lifecycle.relay.relay(teamName),
      ...(deps.openCodeMemberDelivery
        ? { openCodeMemberDelivery: deps.openCodeMemberDelivery }
        : {}),
    }),
    toolApproval: new NativeTeamToolApprovalApi({
      runs: lifecycle.runs,
      commands: lifecycle.memberCommands,
      claudeApprovals: lifecycle.approvals,
      settings: lifecycle.toolApprovalSettings,
    }),
  };
}
