import { type InternalStorageFeature } from '@features/internal-storage/main';
import {
  createNativeOpenCodeRuntimeControlPort,
  createNativeTeamHttpApis,
  type NativeTeamProvisioningRoot,
} from '@features/team-provisioning';
import {
  createTeamRuntimeRecoveryFeature,
  type TeamRuntimeRecoveryFeatureFacade,
} from '@features/team-runtime-recovery/main';
import {
  ActiveTeamRegistry,
  configManager,
  NotificationManager,
  TeamDataService,
  TeamLogSourceTracker,
  TeamTaskStallJournal,
  TeamTaskStallMonitor,
  TeamTaskStallNotifier,
  TeamTaskStallPolicy,
  TeamTaskStallSnapshotSource,
  TeamTranscriptSourceLocator,
} from '@main/services';
import { computeTeamWatchScope } from '@main/services/infrastructure/teamWatchScope';
import { type TeamHttpHandlerApis } from '@main/services/team/contracts/TeamProvisioningApis';
import { OpenCodePromptDeliveryContinuityScan } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryContinuityScan';
import { isOpenCodePromptDeliveryWatchdogEnabled } from '@main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import { createOpenCodeRuntimeControlApi } from '@main/services/team/runtime-control';
import { createOpenCodeRuntimeControlRouter } from '@main/services/team/runtime-control/application/OpenCodeRuntimeControlProvider';
import { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { TeamMemberRuntimeAdvisoryService } from '@main/services/team/TeamMemberRuntimeAdvisoryService';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type {
  NativeDesktopTeamRuntime,
  NativeOpenCodeDeliveryStack,
  NativeRuntimeToolApproval,
} from '@features/team-provisioning/main';
import type { TeamTaskActivityRepairApi } from '@main/services/team/contracts/TeamProvisioningApis';
import type { TeamTaskStallObservationPort } from '@main/services/team/stallMonitor/TeamTaskStallNotifier';
import type { TeamChangeEvent } from '@shared/types';
import type { Logger } from '@shared/utils/logger';

export interface NativeTeamHttpDependencies {
  runtime: NativeDesktopTeamRuntime;
  repair: TeamTaskActivityRepairApi;
  delivery: NativeOpenCodeDeliveryStack;
  approvals: NativeRuntimeToolApproval;
  teamInboxWriter: Pick<TeamInboxWriter, 'sendMessage'>;
  emitTeamChange(event: TeamChangeEvent): void;
}

export function createNativeTeamHttpHandlers(
  deps: NativeTeamHttpDependencies
): TeamHttpHandlerApis {
  const {
    runtime: provisioningRuntime,
    repair: provisioningRepair,
    delivery: provisioningDelivery,
    approvals: provisioningApprovals,
    teamInboxWriter,
  } = deps;
  return createNativeTeamHttpApis({
    runtime: provisioningRuntime,
    taskActivity: provisioningRepair,
    runtimeControl: createOpenCodeRuntimeControlApi({
      runtimeControl: createOpenCodeRuntimeControlRouter(
        createNativeOpenCodeRuntimeControlPort({
          resolveLaneId: (input) => provisioningDelivery.resolveRuntimeLaneId(input),
          bootstrap: provisioningDelivery.bootstrap,
          sendInboxMessage: async ({ teamName, recipient, from, text, messageId, observedAt }) => {
            const result = await teamInboxWriter.sendMessage(teamName, {
              member: recipient,
              text,
              from,
              timestamp: observedAt,
              ...(messageId ? { messageId } : {}),
            });
            return { messageId: result.messageId ?? messageId ?? '' };
          },
          answerPermission: (input) => provisioningApprovals.respond(input),
          emitMemberSpawnChange: (input) =>
            deps.emitTeamChange({
              type: 'member-spawn',
              teamName: input.teamName,
              runId: input.runId,
              detail: input.memberName,
            } as TeamChangeEvent),
          emitTaskLogChange: (input) =>
            deps.emitTeamChange({
              type: 'task-log-change',
              teamName: input.teamName,
              detail: input.taskId,
            }),
        })
      ),
      resolveOpenCodeRuntimeLaneId: (input) => provisioningDelivery.resolveRuntimeLaneId(input),
    }),
    now: () => new Date().toISOString(),
  });
}

export interface NativeTeamRecoveryDependencies {
  teamProvisioningService: Pick<
    NativeTeamProvisioningRoot,
    | 'getAliveTeams'
    | 'isTeamAlive'
    | 'isTeamManagedByThisProfile'
    | 'getRuntimeState'
    | 'getTeamAgentRuntimeSnapshot'
    | 'relayInboxFileToLiveRecipient'
    | 'getOpenCodeMemberDeliveryBusyStatus'
  >;
  teamDataService: Pick<TeamDataService, 'getLeadMemberName' | 'getTeamDisplayName' | 'getTask'>;
  teamInboxReader: Pick<TeamInboxReader, 'getMessagesFor'>;
  teamInboxWriter: Pick<TeamInboxWriter, 'sendMessage'>;
  teamMemberRuntimeAdvisoryService: Pick<TeamMemberRuntimeAdvisoryService, 'getMemberAdvisory'>;
  notificationManager: Pick<NotificationManager, 'addTeamNotification'>;
  getCurrentContextId(): string;
}

export function createNativeTeamRecovery(
  deps: NativeTeamRecoveryDependencies
): TeamRuntimeRecoveryFeatureFacade {
  const {
    teamProvisioningService,
    teamDataService,
    teamInboxReader,
    teamInboxWriter,
    teamMemberRuntimeAdvisoryService,
    notificationManager,
  } = deps;
  return createTeamRuntimeRecoveryFeature({
    teamsBasePath: getTeamsBasePath(),
    configManager,
    getCurrentContextId: deps.getCurrentContextId,
    listActiveTeamNames: async () => teamProvisioningService.getAliveTeams(),
    isTeamActive: async (teamName) => teamProvisioningService.isTeamAlive(teamName),
    isTeamManagedByThisProfile: (teamName) =>
      teamProvisioningService.isTeamManagedByThisProfile(teamName),
    getRuntimeState: (teamName) => teamProvisioningService.getRuntimeState(teamName),
    getRuntimeSnapshot: (teamName) => teamProvisioningService.getTeamAgentRuntimeSnapshot(teamName),
    getLeadName: (teamName) => teamDataService.getLeadMemberName(teamName),
    getTeamDisplayName: (teamName) => teamDataService.getTeamDisplayName(teamName),
    getInboxMessages: (teamName, memberName) =>
      teamInboxReader.getMessagesFor(teamName, memberName),
    inboxWriter: teamInboxWriter,
    relay: async (teamName, memberName) => {
      const result = await teamProvisioningService.relayInboxFileToLiveRecipient(
        teamName,
        memberName
      );
      return {
        kind: result.relayed > 0 ? ('opencode_member' as const) : ('ignored' as const),
        relayed: result.relayed,
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        ...(result.lastDelivery ? { lastDelivery: result.lastDelivery } : {}),
      };
    },
    getTask: (teamName, taskId) => teamDataService.getTask(teamName, taskId),
    getMemberAdvisory: (teamName, memberName, options) =>
      teamMemberRuntimeAdvisoryService.getMemberAdvisory(teamName, memberName, options),
    getOpenCodeBusyStatus: (input) =>
      teamProvisioningService.getOpenCodeMemberDeliveryBusyStatus(input),
    addNotification: (payload) => notificationManager.addTeamNotification(payload),
    logger: createLogger('Feature:TeamRuntimeRecovery'),
  });
}

export interface NativeTeamDeliveryMonitorDependencies {
  teamDataService: Pick<
    TeamDataService,
    | 'listAliveProcessTeams'
    | 'isTeamManagedByThisProfile'
    | 'sendSystemNotificationToLead'
    | 'listTeams'
    | 'getTasks'
    | 'getDeletedTasks'
  >;
  teamProvisioningService: Pick<
    NativeTeamProvisioningRoot,
    'relayOpenCodeMemberInboxMessages' | 'scanOpenCodePromptDeliveryWatchdog'
  >;
  teamLogSourceTracker: Pick<TeamLogSourceTracker, 'enableTracking' | 'disableTracking'>;
  teamTranscriptSourceLocator: TeamTranscriptSourceLocator;
  internalStorageFeature: Pick<InternalStorageFeature, 'taskStallJournalStore'>;
  memberWorkSyncStallObservation: TeamTaskStallObservationPort;
  logger: Logger;
}

export function createNativeTeamDeliveryMonitors(deps: NativeTeamDeliveryMonitorDependencies) {
  const {
    teamDataService,
    teamProvisioningService,
    teamLogSourceTracker,
    teamTranscriptSourceLocator,
    internalStorageFeature,
    memberWorkSyncStallObservation,
    logger,
  } = deps;
  const teamTaskStallMonitor = new TeamTaskStallMonitor(
    new ActiveTeamRegistry(teamDataService, teamLogSourceTracker),
    new TeamTaskStallSnapshotSource({
      transcriptSourceLocator: teamTranscriptSourceLocator,
      taskReader: teamDataService,
    }),
    new TeamTaskStallPolicy(),
    new TeamTaskStallJournal({ store: internalStorageFeature.taskStallJournalStore }),
    new TeamTaskStallNotifier(
      teamDataService,
      teamProvisioningService,
      undefined,
      undefined,
      memberWorkSyncStallObservation
    )
  );
  const openCodePromptDeliveryContinuityScan = new OpenCodePromptDeliveryContinuityScan({
    isEnabled: () => isOpenCodePromptDeliveryWatchdogEnabled(),
    listLiveTeamNames: async () => {
      const scope = computeTeamWatchScope();
      if (scope) {
        return [...scope];
      }
      const teams = await teamDataService.listTeams();
      return teams.filter((team) => !team.deletedAt).map((team) => team.teamName);
    },
    scanTeam: (teamName) =>
      teamProvisioningService.scanOpenCodePromptDeliveryWatchdog(teamName, 'continuity'),
    warn: (message) => logger.warn(message),
  });
  return { teamTaskStallMonitor, openCodePromptDeliveryContinuityScan };
}
