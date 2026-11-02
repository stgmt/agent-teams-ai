import {
  createNativeDesktopTeamRuntime,
  type NativeDesktopTeamRuntime,
  type NativeDesktopTeamRuntimeDependencies,
} from './createNativeDesktopTeamRuntime';
import {
  createNativeOpenCodeDeliveryWatchdog,
  type NativeOpenCodeDeliveryWatchdog,
  type NativeOpenCodeDeliveryWatchdogDependencies,
} from './createNativeOpenCodeDeliveryWatchdog';
import {
  createNativeProvisioningPreparation,
  type NativeProvisioningPreparationDependencies,
} from './createNativeProvisioningPreparation';
import { createNativeRuntimeSurface, type NativeRuntimeSurface } from './createNativeRuntimeSurface';
import {
  createNativeLanguageChangeNotifier,
  createNativeMcpConsumerQuery,
  createNativeTeamProvisioningApis,
  type NativeLanguageChangeNotifierDependencies,
  type NativeTeamProvisioningApisDependencies,
} from './createNativeTeamProvisioningApis';

import type { NativeLeadRestartAvailability } from '../adapters/output/NativeLeadRestartAssessment';
import type { NativeLeadRuntimeSettings } from '../adapters/output/NativeLeadRestartAssessment';
import type { NativeOpenCodeDeliveryBusyStatus } from '../adapters/output/NativeOpenCodeDeliveryBusyStatus';
import type { OpenCodeMemberDeliveryBusyInput } from '../adapters/output/NativeOpenCodeDeliveryBusyStatus';
import type { NativeOpenCodeMemberInboxRelay } from '../adapters/output/NativeOpenCodeMemberInboxRelay';
import type { MemberSpawnStatusesSnapshot, TeamAgentRuntimeSnapshot } from '@shared/types';

export interface NativeTeamProvisioningRootDependencies {
  runtimeDeps: NativeDesktopTeamRuntimeDependencies;
  /**
   * Pre-built runtime owner. The production root omits it and the composition
   * builds one from `runtimeDeps`; tests and alternate shells inject the same
   * owner they already hold so runs recorded on it are the runs read here.
   */
  nativeRuntime?: NativeDesktopTeamRuntime;
  /** The IPC preflight surface; preparation and its help text come from this root. */
  apisDeps: Omit<NativeTeamProvisioningApisDependencies, 'runtime' | 'preflight'>;
  watchdogDeps: NativeOpenCodeDeliveryWatchdogDependencies;
  prepDeps: NativeProvisioningPreparationDependencies;
  languageDeps: Omit<NativeLanguageChangeNotifierDependencies, 'runtime' | 'openCodeMemberDelivery'>;
  busyStatus: Pick<NativeOpenCodeDeliveryBusyStatus, 'getBusyStatus'>;
  inboxRelay: Pick<NativeOpenCodeMemberInboxRelay, 'relayOpenCodeMemberInboxMessages'>;
}

export interface NativeTeamProvisioningRoot {
  /** The IPC handler surface over the same owner; the root must not bind a second one. */
  apis: ReturnType<typeof createNativeTeamProvisioningApis>;
  createTeam: NativeRuntimeSurface['provisioningStart']['createTeam'];
  launchTeam: NativeRuntimeSurface['provisioningStart']['launchTeam'];
  cancelProvisioning: NativeRuntimeSurface['provisioningRun']['cancelProvisioning'];
  hasProvisioningRun: NativeRuntimeSurface['provisioningRun']['hasProvisioningRun'];
  getRuntimeState: NativeRuntimeSurface['runtime']['getRuntimeState'];
  stopTeam: NativeRuntimeSurface['runtime']['stopTeam'];
  stopAllTeams: () => Promise<readonly { teamName: string; error: string }[]>;
  isTeamAlive: NativeRuntimeSurface['runtime']['isTeamAlive'];
  getAliveTeams: NativeRuntimeSurface['runtime']['getAliveTeams'];
  getAliveTeamNames: () => string[];
  hasActiveTeamRuntimes: () => boolean;
  getCurrentRunId: NativeRuntimeSurface['runtime']['getCurrentRunId'];
  prepareForProvisioning: NativeProvisioningPreparation['prepareForProvisioning'];
  warmup: () => Promise<void>;
  scanOpenCodePromptDeliveryWatchdog: (teamName: string, mode?: 'continuity') => Promise<void>;
  getOpenCodeMemberDeliveryBusyStatus: (
    input: OpenCodeMemberDeliveryBusyInput
  ) => ReturnType<NativeOpenCodeDeliveryBusyStatus['getBusyStatus']>;
  scheduleOpenCodeMemberInboxDeliveryWake: (input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs?: number;
  }) => void;
  relayInboxFileToLiveRecipient: (
    teamName: string,
    memberName: string
  ) => ReturnType<NativeOpenCodeMemberInboxRelay['relayOpenCodeMemberInboxMessages']>;
  getMemberSpawnStatuses: (teamName: string) => Promise<MemberSpawnStatusesSnapshot>;
  getTeamAgentRuntimeSnapshot: (teamName: string) => Promise<TeamAgentRuntimeSnapshot>;
  restartLeadRuntime: (input: {
    teamName: string;
    expectedRunId: string;
    before: Readonly<NativeLeadRuntimeSettings>;
    after: Readonly<NativeLeadRuntimeSettings>;
  }) => Promise<void>;
  assessLeadRuntimeRestart: (input: {
    teamName: string;
    providerId: NativeLeadRuntimeSettings['providerId'];
    model: string | null;
    effort: NativeLeadRuntimeSettings['effort'];
  }) => Promise<NativeLeadRestartAvailability>;
  notifyLanguageChange: (language: string) => Promise<void>;
  hasLiveOpenCodeMcpConsumers: () => boolean;
  cancelPendingRuntimeAdapterLaunchesForShutdown: () => Promise<void>;
}

type NativeProvisioningPreparation = ReturnType<typeof createNativeProvisioningPreparation>;

/**
 * One native owner of the team-provisioning surface the application root reads.
 *
 * Every member is answered by a native composition: runs and launches by the
 * runtime surface over `NativeDesktopTeamRuntime`, readiness by the preparation
 * composition, delivery wakes by the OpenCode watchdog, snapshots by the
 * diagnostics/member-lifecycle adapters, and the MCP-bridge predicate by the
 * consumer query. Dependencies the root can only construct after this object
 * (cross-team sender, window, approval/team-change emitters, adapter registry)
 * are late-bound arrows supplied by the caller, never post-construction setters.
 */
export function createNativeTeamProvisioningRoot(
  deps: NativeTeamProvisioningRootDependencies
): NativeTeamProvisioningRoot {
  const nativeRuntime = deps.nativeRuntime ?? createNativeDesktopTeamRuntime(deps.runtimeDeps);
  const surface = createNativeRuntimeSurface(nativeRuntime.runtime);
  // Preparation is built first: the IPC preflight answers with the same pipeline the
  // launch readiness check uses, so a readiness answer can never come from a second one.
  const prep = createNativeProvisioningPreparation(deps.prepDeps);
  const apis = createNativeTeamProvisioningApis({
    ...deps.apisDeps,
    preflight: {
      getCliHelpOutput: () => prep.getCliHelpOutput(),
      prepareForProvisioning: (cwd, options) => prep.prepareForProvisioning(cwd, options),
    },
    runtime: nativeRuntime,
  });
  const watchdog: NativeOpenCodeDeliveryWatchdog = createNativeOpenCodeDeliveryWatchdog(
    deps.watchdogDeps
  );
  const mcpConsumers = createNativeMcpConsumerQuery({ runtime: nativeRuntime });
  const languageNotifier = createNativeLanguageChangeNotifier({
    ...deps.languageDeps,
    runtime: nativeRuntime,
    ...(deps.apisDeps.openCodeMemberDelivery
      ? { openCodeMemberDelivery: deps.apisDeps.openCodeMemberDelivery }
      : {}),
  });

  return {
    apis,
    createTeam: surface.provisioningStart.createTeam,
    launchTeam: surface.provisioningStart.launchTeam,
    cancelProvisioning: surface.provisioningRun.cancelProvisioning,
    hasProvisioningRun: surface.provisioningRun.hasProvisioningRun,
    getRuntimeState: surface.runtime.getRuntimeState,
    stopTeam: surface.runtime.stopTeam,
    stopAllTeams: () => nativeRuntime.runtime.stopAllTeams(),
    isTeamAlive: surface.runtime.isTeamAlive,
    getAliveTeams: surface.runtime.getAliveTeams,
    getAliveTeamNames: () => nativeRuntime.runtime.getAliveTeamNames(),
    hasActiveTeamRuntimes: () => nativeRuntime.runtime.hasActiveTeamRuntimes(),
    getCurrentRunId: surface.runtime.getCurrentRunId,
    prepareForProvisioning: (cwd, options) => prep.prepareForProvisioning(cwd, options),
    warmup: () => prep.warmup(),
    scanOpenCodePromptDeliveryWatchdog: async (teamName, mode) => {
      if (mode === 'continuity') {
        await watchdog.scanContinuity(teamName);
        return;
      }
      await watchdog.scan(teamName);
    },
    getOpenCodeMemberDeliveryBusyStatus: (input) => deps.busyStatus.getBusyStatus(input),
    scheduleOpenCodeMemberInboxDeliveryWake: (input) => {
      deps.watchdogDeps.scheduler.schedule({
        teamName: input.teamName,
        memberName: input.memberName,
        messageId: input.messageId,
        delayMs: input.delayMs ?? 0,
      });
    },
    relayInboxFileToLiveRecipient: (teamName, memberName) =>
      deps.inboxRelay.relayOpenCodeMemberInboxMessages(teamName, memberName),
    getMemberSpawnStatuses: (teamName) =>
      apis.memberLifecycle.getMemberSpawnStatuses(teamName),
    getTeamAgentRuntimeSnapshot: (teamName) =>
      apis.diagnostics.getTeamAgentRuntimeSnapshot(teamName),
    restartLeadRuntime: (input) => nativeRuntime.lifecycle.leadRuntime.restart(input),
    assessLeadRuntimeRestart: (input) =>
      nativeRuntime.lifecycle.leadRuntime.assess(input.teamName, {
        providerId: input.providerId,
        model: input.model,
        effort: input.effort,
      }),
    notifyLanguageChange: (language) => languageNotifier.notify(language),
    hasLiveOpenCodeMcpConsumers: () => mcpConsumers.hasLiveOpenCodeMcpConsumers(),
    cancelPendingRuntimeAdapterLaunchesForShutdown: () =>
      nativeRuntime.lifecycle.leadRuntime.cancelPendingLaunches(),
  };
}
