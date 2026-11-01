import { NativeCrossTeamMessagingApi } from '../adapters/input/NativeCrossTeamMessagingApi';
import { NativeTeamMemberLifecycleApi } from '../adapters/input/NativeTeamMemberLifecycleApi';
import { NativeTeamMessagingApi } from '../adapters/input/NativeTeamMessagingApi';
import { NativeTeamToolApprovalApi } from '../adapters/input/NativeTeamToolApprovalApi';
import { NativeLanguageChangeNotifier } from '../adapters/output/NativeLanguageChangeNotifier';
import { NativeMcpConsumerQuery } from '../adapters/output/NativeMcpConsumerQuery';
import { NativeTeamClaudeLogs } from '../adapters/output/NativeTeamClaudeLogs';
import { NativeTeamDiagnostics } from '../adapters/output/NativeTeamDiagnostics';

import { createBoundTeamLiveStatusQueries } from './createBoundTeamLiveStatusQueries';
import { createNativeRuntimeSurface } from './createNativeRuntimeSurface';

import type { NativeOpenCodeMemberDeliveryPort } from '../adapters/input/NativeTeamMessagingApi';
import type { NativeDesktopTeamRuntime } from './createNativeDesktopTeamRuntime';
import type {
  TeamCrossTeamMessagingApi,
  TeamIpcHandlerApis,
  TeamProvisioningPreflightApi,
  TeamTaskActivityRepairApi,
} from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamConfig } from '@shared/types';

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
 * Live lead messages come from the lifecycle-owned lead output capture; the
 * production switch that binds this surface remains phase 8.
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
    messaging: buildMessagingApi(lifecycle, deps.openCodeMemberDelivery),
    toolApproval: new NativeTeamToolApprovalApi({
      runs: lifecycle.runs,
      commands: lifecycle.memberCommands,
      claudeApprovals: lifecycle.approvals,
      settings: lifecycle.toolApprovalSettings,
    }),
  };
}

/**
 * Whether the app-owned HTTP MCP bridge still has consumers. Sync by contract,
 * so it reads only the registry instead of launch settings.
 */
export function createNativeMcpConsumerQuery(
  deps: Pick<NativeTeamProvisioningApisDependencies, 'runtime'>
): NativeMcpConsumerQuery {
  return new NativeMcpConsumerQuery({
    runs: deps.runtime.lifecycle.runs,
    configuredProviders: (runId) => deps.runtime.lifecycle.configuredProviders(runId),
  });
}

function buildMessagingApi(
  lifecycle: NativeDesktopTeamRuntime['lifecycle'],
  openCodeMemberDelivery: NativeOpenCodeMemberDeliveryPort | undefined
): TeamIpcHandlerApis['messaging'] {
  // The lifecycle owns the ledger driver, so the wake it arms is the same one
  // its release hook cancels; building a second one here would leak timers.
  const supervisor = lifecycle.promptDelivery;
  return new NativeTeamMessagingApi({
    runs: lifecycle.runs,
    settings: lifecycle.settings,
    liveLeadMessages: lifecycle.liveLeadMessages,
    leadOutput: lifecycle.leadOutput,
    sendLeadMessage: lifecycle.sendLeadMessage,
    relayLeadInboxMessages: (teamName) => lifecycle.relay.relay(teamName),
    ...(openCodeMemberDelivery ? { openCodeMemberDelivery } : {}),
    ...(supervisor
      ? {
          scheduleDeliveryVerification: (input) => supervisor.scheduleDeliveryVerification(input),
        }
      : {}),
  });
}

export interface NativeLanguageChangeNotifierDependencies {
  readConfig(teamName: string): Promise<TeamConfig | null>;
  writeLanguage(teamName: string, language: string): Promise<void>;
  getSystemLocale(): string;
  resolveLanguageName(code: string, systemLocale?: string): string;
  logger: { info(message: string): void; warn(message: string): void };
}

/**
 * `notifyLanguageChange` over the native owner: alive teams come from the native
 * registry and the message goes through the same messaging adapter as every
 * other lead delivery, so a lane lead is reached by the lane inbox.
 */
export function createNativeLanguageChangeNotifier(
  deps: NativeLanguageChangeNotifierDependencies & {
    runtime: Pick<NativeDesktopTeamRuntime, 'runtime' | 'lifecycle'>;
    openCodeMemberDelivery?: NativeOpenCodeMemberDeliveryPort;
  }
): NativeLanguageChangeNotifier {
  const messaging = buildMessagingApi(deps.runtime.lifecycle, deps.openCodeMemberDelivery);
  return new NativeLanguageChangeNotifier({
    getAliveTeams: () => deps.runtime.runtime.getAliveTeams(),
    readConfig: (teamName) => deps.readConfig(teamName),
    writeLanguage: (teamName, language) => deps.writeLanguage(teamName, language),
    sendMessageToTeam: (teamName, message) => messaging.sendMessageToTeam(teamName, message),
    getSystemLocale: () => deps.getSystemLocale(),
    resolveLanguageName: (code, systemLocale) => deps.resolveLanguageName(code, systemLocale),
    logger: deps.logger,
  });
}

/**
 * Cross-team messaging over the same runtime owner. Kept beside the IPC surface
 * because the cutover binds both from one composition; it never builds a second
 * registry or a second reply ledger.
 */
export function createNativeTeamCrossTeamApi(
  deps: Pick<NativeTeamProvisioningApisDependencies, 'runtime' | 'openCodeMemberDelivery' | 'now'>
): TeamCrossTeamMessagingApi {
  const lifecycle = deps.runtime.lifecycle;
  return new NativeCrossTeamMessagingApi({
    runs: lifecycle.runs,
    replyLedger: lifecycle.crossTeamReplies,
    settings: lifecycle.settings,
    inbox: lifecycle.inbox,
    relayLeadInboxMessages: (teamName, options) => lifecycle.relay.relay(teamName, options),
    ...(deps.openCodeMemberDelivery
      ? { openCodeMemberDelivery: deps.openCodeMemberDelivery }
      : {}),
    now: () => Date.parse(deps.now()),
  });
}
