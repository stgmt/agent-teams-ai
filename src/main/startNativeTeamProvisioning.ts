import { mkdirSync } from 'node:fs';

import { type ApplicationCommandLedgerFeature } from '@features/application-command-ledger/main';
import {
  createNativeDefinitionStore,
  createNativeDesktopTeamRuntime,
  createNativeLanguageChangeDeps,
  createNativeOpenCodeDeliveryStack,
  createNativeProvisioningSupport,
  createNativeRuntimeToolApproval,
  createNativeSecondaryRuntimeRunStore,
  createNativeTaskActivityRepair,
  createNativeTeamBriefing,
  createNativeTeamProvisioningGraph,
  type NativeTeamProvisioningRoot,
} from '@features/team-provisioning';
import { NativeTeamOperationQueue as TeamOperationQueue } from '@features/team-provisioning';
import { NativeClaudeSdkHost } from '@features/team-provisioning/main';
import {
  ClaudeBinaryResolver,
  TeamDataService,
  TeamMembersMetaStore,
  TeamRuntimeAdapterRegistry,
  TeamTaskReader,
} from '@main/services';
import {
  cleanupAnthropicTeamApiKeyHelperMaterial,
  materializeAnthropicTeamApiKeyHelper,
  verifyAnthropicTeamApiKeyHelperMaterial,
} from '@main/services/runtime/anthropicTeamApiKeyHelper';
import { buildProviderAwareCliEnv } from '@main/services/runtime/providerAwareCliEnv';
import { providerConnectionService } from '@main/services/runtime/ProviderConnectionService';
import { TeamProvisioningAppShellBoundary } from '@main/services/team/provisioning/TeamProvisioningAppShellBoundary';
import { createTeamProvisioningEnvRuntimePorts } from '@main/services/team/provisioning/TeamProvisioningEnvRuntimePorts';
import { resolveOpenCodeInboxAttachmentPayloads } from '@main/services/team/provisioning/TeamProvisioningOpenCodeAttachmentPayloads';
import { readPersistedTeamProjectPath } from '@main/services/team/provisioning/TeamProvisioningPersistedTeamConfigAccess';
import {
  claimExistingTeamForLaunch,
  claimTeamForThisProfile,
  createTeamProfileOwnership,
} from '@main/services/team/provisioning/TeamProvisioningProfileOwnership';
import {
  getAnthropicFastModeDefault,
  getTeamProviderLabel,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeDiagnostics';
import { CreatedSpecBindingObserver } from '@main/services/team/registry';
import {
  resolveRegistryTaskClientConfig,
  SPEC_REGISTRY_TOKEN_ENV,
  SPEC_REGISTRY_URL_ENV,
} from '@main/services/team/registry/RegistryTaskClientConfig';
import { TeamAttachmentStore } from '@main/services/team/TeamAttachmentStore';
import { TeamConfigReader } from '@main/services/team/TeamConfigReader';
import { getTeamDataWorkerCache } from '@main/services/team/TeamDataWorkerClient';
import { TeamInboxReader } from '@main/services/team/TeamInboxReader';
import { TeamInboxWriter } from '@main/services/team/TeamInboxWriter';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { TeamMcpConfigBuilder } from '@main/services/team/TeamMcpConfigBuilder';
import { TeamMetaStore } from '@main/services/team/TeamMetaStore';
import { TeamTaskActivityIntervalService } from '@main/services/team/TeamTaskActivityIntervalService';
import { execCli } from '@main/utils/childProcess';
import {
  getAppDataPath,
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getHomeDir,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { resolveLanguageName } from '@shared/utils/agentLanguage';
import { app, shell } from 'electron';
import { join } from 'path';

import type { DesktopExternalAgentConnection } from '@features/external-agent-connection/main';
import type {
  NativeOpenCodeDeliveryStack,
  NativeOpenCodeDeliveryStackSources,
  NativeRuntimeToolApprovalSources,
} from '@features/team-provisioning/main';
import type { MemberGatewayRuntimeSeams } from '@main/services/team/provisioning/TeamProvisioningMemberGatewayRuntime';
import type { PersistedTeamConfigCacheEntry } from '@main/services/team/provisioning/TeamProvisioningPersistedTeamConfigAccess';
import type { LeadRuntimeFailureObservation } from '@main/services/team/provisioning/TeamProvisioningRuntimeFailureObservationBoundary';
import type { TeamChangeEvent, TeamTask } from '@shared/types';
import type { Logger } from '@shared/utils/logger';

export interface NativeProvisioningLateBindings {
  acknowledgedInbound: NativeOpenCodeDeliveryStackSources['hasAcknowledgedInbound'] | null;
  observeLeadFailure: ((failure: LeadRuntimeFailureObservation) => void) | null;
}

export interface StartNativeTeamProvisioningDependencies {
  gatewaySeams: MemberGatewayRuntimeSeams;
  runtimeAdapterRegistry: TeamRuntimeAdapterRegistry;
  connection: Pick<
    DesktopExternalAgentConnection,
    'getConnectionInfo' | 'withExpectedContext' | 'assertLaunchAdmission'
  >;
  applicationCommandLedgerFeature: ApplicationCommandLedgerFeature | null;
  teamDataService: Pick<
    TeamDataService,
    'readTasks' | 'createController' | 'invalidateTeamRuntimeAdvisories'
  >;
  teamInboxReader: TeamInboxReader;
  teamInboxWriter: Pick<TeamInboxWriter, 'sendMessage'>;
  lateBindings: NativeProvisioningLateBindings;
  getTeamControlApiBaseUrl(): string | null;
  installSdkHost(host: NativeClaudeSdkHost): void;
  emitApprovalEvent: NativeRuntimeToolApprovalSources['emitApprovalEvent'];
  emitTeamChange(event: TeamChangeEvent): void;
  logger: Logger;
}

/** Owns the native stores, SDK authority and graph; the shell installs it before recovery. */
export async function startNativeTeamProvisioning(deps: StartNativeTeamProvisioningDependencies) {
  const {
    runtimeAdapterRegistry,
    applicationCommandLedgerFeature,
    teamDataService,
    teamInboxReader,
    teamInboxWriter,
    getTeamControlApiBaseUrl,
    logger,
  } = deps;
  const externalAgentConnection = deps.connection;
  const provisioningLateBindings = deps.lateBindings;
  // --- native team provisioning ------------------------------------------------
  // Stores the whole provisioning path shares: built once here, read by the runtime,
  // the delivery stack and the root, so none of them can end up with a second copy.
  const provisioningMetaStore = new TeamMetaStore();
  const provisioningMembersStore = new TeamMembersMetaStore();
  const provisioningMcpBuilder = new TeamMcpConfigBuilder();
  const provisioningLaunchState = new TeamLaunchStateStore();
  const provisioningRuns = createNativeSecondaryRuntimeRunStore();
  const provisioningQueue = new TeamOperationQueue();
  const provisioningConfigReader = new TeamConfigReader();
  const provisioningStoppingTeams = new Set<string>();
  const provisioningProjectPathCache = new Map<string, PersistedTeamConfigCacheEntry>();
  const provisioningAttachmentStore = new TeamAttachmentStore();
  const provisioningTaskReader = new TeamTaskReader();
  let provisioningRootRef: NativeTeamProvisioningRoot | null = null;
  const provisioningProfileOwnership = createTeamProfileOwnership({
    isTrackedInThisProcess: (teamName) =>
      Boolean(provisioningRootRef?.runtime.registry.aliveRunId(teamName)) ||
      provisioningRuns.getPrimaryRuntimeRun(teamName) !== null ||
      provisioningRuns.hasSecondaryRuntimeRuns(teamName),
  });
  const provisioningShell = new TeamProvisioningAppShellBoundary(deps.gatewaySeams);
  provisioningShell.setRuntimeAdapterRegistry(runtimeAdapterRegistry);
  const provisioningEnvPorts = createTeamProvisioningEnvRuntimePorts({
    providerConnectionService,
    getControlApiBaseUrlResolver: () => provisioningShell.getControlApiBaseUrlResolver(),
    getRuntimeTurnSettledEnvironmentProvider: () =>
      provisioningShell.getRuntimeTurnSettledEnvironmentProvider(),
    getRuntimeTurnSettledHookSettingsProvider: () =>
      provisioningShell.getRuntimeTurnSettledHookSettingsProvider(),
    getMemberGatewayRuntimeSeams: () => provisioningShell.getMemberGatewayRuntimeSeams(),
    logger,
  });
  const provisioningSupport = createNativeProvisioningSupport({
    provider: {
      profile: {
        homeDirectory: getHomeDir(),
        claudeConfigDirectory: getClaudeBasePath(),
        autoDetectedClaudeConfigDirectory: getAutoDetectedClaudeBasePath(),
        attachmentRoot: join(getAppDataPath(), 'attachments'),
      },
      executable: async () => {
        // Members are started by the Agent Teams runtime: it is the binary that understands
        // the launch flags this path passes. Falling back to the plain Claude CLI would start
        // a binary that rejects them, and the launch would fail on the first member.
        const binary = await ClaudeBinaryResolver.resolve();
        if (!binary) {
          throw new Error('Agent Teams runtime is not available for team provisioning');
        }
        return binary;
      },
      controlUrl: async () => {
        const url = getTeamControlApiBaseUrl();
        if (!url) throw new Error('Team control API is not ready');
        return url;
      },
      environment: {
        ...provisioningEnvPorts.getProvisioningEnvBuilderPorts(),
        // The builder's own fallback is unreachable through a spread, so the step is named.
        buildProviderAwareCliEnv,
        // Anthropic auth for members: without these the runtime refuses to start a turn
        // ("ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is required") and every member
        // stays disconnected.
        materializeAnthropicTeamApiKeyHelper,
        verifyAnthropicTeamApiKeyHelperMaterial,
        cleanupAnthropicTeamApiKeyHelperMaterial,
      },
      identity: {
        execCli,
        providerConnectionService: {
          getCodexModelCatalog: (params) => providerConnectionService.getCodexModelCatalog(params),
        },
        getAnthropicFastModeDefault,
        getProviderLabel: (providerId) => getTeamProviderLabel(providerId),
        logger: { warn: (message) => logger.warn(message) },
      },
      workSync: {
        buildRuntimeTurnSettledHookSettings: async (input) => {
          const provider = provisioningShell.getRuntimeTurnSettledHookSettingsProvider();
          return provider ? provider(input) : null;
        },
        buildRuntimeTurnSettledEnvironment: async (input) => {
          const provider = provisioningShell.getRuntimeTurnSettledEnvironmentProvider();
          return provider ? provider(input) : null;
        },
      },
    },
    runtimeAdapterRegistry,
    logger: { info: (message) => logger.info(message), warn: (message) => logger.warn(message) },
  });
  const provisioningConnectionContext = (await externalAgentConnection.getConnectionInfo()).context;
  const provisioningBriefing = createNativeTeamBriefing({
    readMembersMeta: async (teamName) =>
      (await provisioningMembersStore.getMeta(teamName))?.members ?? [],
  });
  const provisioningDefinitions = createNativeDefinitionStore({
    teamsRoot: getTeamsBasePath(),
    tasksRoot: getTasksBasePath(),
    metadata: provisioningMetaStore,
    members: provisioningMembersStore,
    invalidate: () => TeamConfigReader.invalidateListTeamsCache(),
  });
  const provisioningLanguageDeps = createNativeLanguageChangeDeps({
    config: {
      getConfig: (teamName) => provisioningConfigReader.getConfig(teamName),
      updateConfig: async (teamName, update) => {
        await provisioningConfigReader.updateConfig(teamName, update);
      },
    },
    getSystemLocale: () => app.getLocale(),
    resolveLanguageName: (code, systemLocale) => resolveLanguageName(code, systemLocale),
    logger: { info: (message) => logger.info(message), warn: (message) => logger.warn(message) },
  });
  const provisioningRepair = createNativeTaskActivityRepair({
    isManagedByThisProfile: (teamName) =>
      provisioningProfileOwnership.isManagedByThisProfile(teamName),
    intervals: new TeamTaskActivityIntervalService(),
    readLaunchState: (teamName) => provisioningLaunchState.read(teamName),
    readBootstrapLaunchSnapshot: (teamName) => provisioningLaunchState.read(teamName),
    getTrackedRunId: (teamName) =>
      provisioningRootRef?.runtime.registry.aliveRunId(teamName) ?? null,
    hasRun: (runId) => Boolean(provisioningRootRef?.runtime.registry.findByRunId(runId)),
  });
  // A launch writes its owned attempt under the runtime root and gives isolated members
  // a workspace; both directories must exist before the first launch, not after it fails.
  const provisioningRuntimeRoot = join(getAppDataPath(), 'team-runtime');
  const provisioningWorkspaceRoot = join(getAppDataPath(), 'team-workspaces');
  mkdirSync(provisioningRuntimeRoot, { recursive: true });
  mkdirSync(provisioningWorkspaceRoot, { recursive: true });
  if (!applicationCommandLedgerFeature) {
    throw new Error('Native teams require durable command storage');
  }
  const createdSpecBindings = new CreatedSpecBindingObserver({
    teamMetaStore: provisioningMetaStore,
    configReader: provisioningConfigReader,
  });
  const sdkHost: NativeClaudeSdkHost = new NativeClaudeSdkHost({
    runner: applicationCommandLedgerFeature.runner,
    ledger: applicationCommandLedgerFeature.ledgerStore,
    scopeKey: provisioningConnectionContext.dataRootFingerprint,
    assertAuthorized: (token, identity) =>
      provisioningRuntime.lifecycle.assertSdkAuthority(token, identity),
    observe: (subject, event) => createdSpecBindings.observe(subject, event),
  });
  deps.installSdkHost(sdkHost);
  await sdkHost.recoverEndpoint();
  const provisioningRuntimeDeps = {
    owner: provisioningConnectionContext,
    sdkHost,
    currentContext: () => provisioningConnectionContext,
    teamsRoot: getTeamsBasePath(),
    provider: provisioningSupport.providerPorts,
    runtimeRoot: provisioningRuntimeRoot,
    workspaceRoot: provisioningWorkspaceRoot,
    controlUrl: async () => {
      const url = getTeamControlApiBaseUrl();
      if (!url) throw new Error('Team control API is not ready');
      return url;
    },
    briefing: provisioningBriefing,
    readStartupTasks: (teamName: string) => teamDataService.readTasks(teamName),
    createController: (input: {
      teamName: string;
      claudeDir: string;
      readOnlyTaskSnapshot: TeamTask[];
    }) => teamDataService.createController(input),
    invalidate: (teamName: string) => TeamConfigReader.invalidateTeam(teamName),
    contextInvalidationSignal: () => new AbortController().signal,
    withExpectedContext: <T>(
      expected: typeof provisioningConnectionContext,
      operation: () => Promise<T>
    ) => {
      if (!externalAgentConnection) throw new Error('App connection is not available yet');
      return externalAgentConnection.withExpectedContext(expected, operation);
    },
    definitions: provisioningDefinitions,
    profileOwnership: provisioningProfileOwnership,
    claimTeam: (teamName: string, reason: 'create' | 'launch') =>
      reason === 'create'
        ? claimTeamForThisProfile({ teamsBasePath: getTeamsBasePath(), teamName, reason })
        : claimExistingTeamForLaunch(teamName, getTeamsBasePath()),
    clearStoppedLaneStopBackoff: (teamName: string) =>
      provisioningDelivery.clearStoppedLaneStopBackoff(teamName),
    listTeamNames: async () =>
      (await provisioningConfigReader.listTeams()).map((team) => team.teamName),
    runtimeAdapterRegistry,
    onRuntimeFailure: (input: {
      teamName: string;
      memberName: string;
      runId: string;
      detail: string;
    }) =>
      provisioningLateBindings.observeLeadFailure?.({
        ...input,
        phase: 'terminal',
        observedAt: new Date().toISOString(),
      }),
    log: (message: string) => logger.error(message),
    requireProviderAuth: true,
    launchAdmission: {
      assertAdmitted: () => {
        if (!externalAgentConnection) throw new Error('App connection is not available yet');
        externalAgentConnection.assertLaunchAdmission();
      },
    },
  };
  const resolveSpecRegistryEnvironment = async (): Promise<Record<string, string>> => {
    const registry = await resolveRegistryTaskClientConfig();
    return {
      [SPEC_REGISTRY_URL_ENV]: registry.url,
      [SPEC_REGISTRY_TOKEN_ENV]: registry.token,
    };
  };
  const provisioningRuntime = createNativeDesktopTeamRuntime({
    ...provisioningRuntimeDeps,
    settings: {
      metadata: provisioningMetaStore,
      members: provisioningMembersStore,
      // Bound launches mount the agent MCP surface from this resolver; the
      // lifecycle settings need it too, or every bound launch refuses to start.
      specRegistryEnvironment: resolveSpecRegistryEnvironment,
    },
    mcp: {
      writeConfigFile: (cwd, options) => provisioningMcpBuilder.writeConfigFile(cwd, options),
      removeConfigFile: (path) => provisioningMcpBuilder.removeConfigFile(path),
    },
    inbox: {
      sendMessage: (teamName, message, options) =>
        teamInboxWriter.sendMessage(teamName, message, options),
    },
  });
  const provisioningApprovals = createNativeRuntimeToolApproval({
    claude: {
      approvals: provisioningRuntime.lifecycle.approvals,
      runs: provisioningRuntime.registry,
    },
    getSettings: (teamName) => provisioningRuntime.lifecycle.toolApprovalSettings.get(teamName),
    answerOpenCodePermission: async (input) => {
      const adapter = provisioningShell.getOpenCodeRuntimeAdapter();
      if (!adapter?.answerRuntimePermission) {
        throw new Error('OpenCode runtime bridge cannot answer tool approvals');
      }
      await adapter.answerRuntimePermission({
        ...input,
        providerId: 'opencode',
        cwd: process.cwd(),
        expectedMembers: [],
        previousLaunchState: await provisioningLaunchState.read(input.teamName).catch(() => null),
      });
    },
    emitApprovalEvent: deps.emitApprovalEvent,
    logWarning: (message) => logger.warn(message),
  });
  const provisioningDelivery: NativeOpenCodeDeliveryStack = createNativeOpenCodeDeliveryStack({
    teamsBasePath: getTeamsBasePath(),
    launchState: provisioningLaunchState,
    isManagedByThisProfile: (teamName) =>
      provisioningProfileOwnership.isManagedByThisProfile(teamName),
    isTeamAlive: (teamName) => provisioningRuntime.registry.aliveRunId(teamName) !== null,
    runs: provisioningRuns,
    openCodeAdapter: () => provisioningShell.getOpenCodeRuntimeAdapter(),
    messageAdapter: () => provisioningShell.getOpenCodeRuntimeMessageAdapter(),
    config: { read: (teamName) => provisioningConfigReader.getConfig(teamName) },
    teamMeta: provisioningMetaStore,
    membersMeta: provisioningMembersStore,
    inbox: teamInboxReader,
    readInbox: (teamName, inboxName) => teamInboxReader.getMessagesFor(teamName, inboxName),
    readTasks: (teamName) => provisioningTaskReader.getTasks(teamName),
    queue: {
      run: (teamName, operation) => {
        if (!provisioningRootRef) throw new Error('Team provisioning owner is not initialized');
        return provisioningRootRef.runtime.lifecycle.activity.run(teamName, () =>
          provisioningQueue.run(teamName, operation)
        );
      },
    },
    controlUrlResolver: () => provisioningShell.getControlApiBaseUrlResolver(),
    stoppingTeams: provisioningStoppingTeams,
    isMemberLifecycleOperationActive: (teamName, memberName) => {
      const member = provisioningRuntime.registry.find(teamName)?.members[memberName];
      return member ? member.phase !== 'ready' && member.phase !== 'stopped' : false;
    },
    readPersistedTeamProjectPath: (teamName) =>
      readPersistedTeamProjectPath(teamName, {
        teamsBasePath: getTeamsBasePath(),
        cache: provisioningProjectPathCache,
      }),
    readRun: (runId) => {
      const snapshot = provisioningRuntime.registry.findByRunId(runId);
      if (!snapshot) return undefined;
      return {
        allEffectiveMembers: Object.values(snapshot.members).map((member) => ({
          name: member.memberName,
        })),
        mixedSecondaryLanes: [],
      };
    },
    resolveOpenCodeInboxAttachmentPayloads: (input) =>
      resolveOpenCodeInboxAttachmentPayloads(input, {
        attachmentStore: provisioningAttachmentStore,
      }),
    hasAcceptedMemberWorkSyncReport: async (input) => {
      const checker = provisioningShell.getMemberWorkSyncAcceptedReportChecker();
      return checker ? checker(input) : false;
    },
    hasAcknowledgedInbound: async (input) =>
      provisioningLateBindings.acknowledgedInbound
        ? provisioningLateBindings.acknowledgedInbound(input)
        : false,
    permissionListingAdapter: () => provisioningShell.getOpenCodeRuntimePermissionListingAdapter(),
    syncToolApprovals: (input) =>
      provisioningApprovals.syncOpenCodeRuntimeToolApprovals(input as never),
    emitRuntimeDeliveryReplyAdvisoryRefresh: (teamName) => {
      teamDataService.invalidateTeamRuntimeAdvisories(teamName);
    },
    emitTeamChange: (event) => deps.emitTeamChange(event),
    emitMemberSpawnChange: (input) =>
      deps.emitTeamChange({
        type: 'member-spawn',
        teamName: input.teamName,
        ...(input.runId ? { runId: input.runId } : {}),
        detail: input.memberName,
      } as TeamChangeEvent),
    emitPromptDeliveryTaskLogChange: (record, detail) =>
      deps.emitTeamChange({
        type: 'task-log-change',
        teamName: String(record.teamName ?? ''),
        detail,
      }),
    invalidateRuntimeSnapshotCaches: (teamName) => {
      teamDataService.invalidateTeamRuntimeAdvisories(teamName);
      getTeamDataWorkerCache()?.invalidateMemberRuntimeAdvisory(teamName);
    },
    logPromptDeliveryEvent: (event, record, extra) =>
      logger.debug(
        `[OpenCode delivery] ${event} ${record.laneId ?? ''} ${JSON.stringify(extra ?? {})}`
      ),
    logger: {
      info: (message, context) => logger.info(context ? `${message} ${context}` : message),
      warn: (message) => logger.warn(message),
      debug: (message) => logger.debug(message),
    },
  });
  provisioningRootRef = createNativeTeamProvisioningGraph({
    stores: {
      teamsRoot: getTeamsBasePath(),
      metadata: provisioningMetaStore,
      members: provisioningMembersStore,
      // The agent's spec MCP server is the only way to reach the registry, so a
      // bound team's launch carries the endpoint and token it substitutes.
      specRegistryEnvironment: resolveSpecRegistryEnvironment,
      mcp: provisioningMcpBuilder,
      inbox: teamInboxWriter,
      invalidate: (teamName) => TeamConfigReader.invalidateTeam(teamName),
    },
    nativeRuntime: provisioningRuntime,
    runtimeDeps: provisioningRuntimeDeps,
    mcpConfig: { removeConfigFile: (path) => provisioningMcpBuilder.removeConfigFile(path) },
    apisDeps: {
      taskActivity: provisioningRepair,
      recipientSources: {
        readConfigSnapshot: (teamName) => provisioningConfigReader.getConfigSnapshot(teamName),
        readMembersMeta: (teamName) => provisioningMembersStore.getMembers(teamName),
      },
      openCodeMemberDelivery: provisioningDelivery.deliveryPort,
      now: () => new Date().toISOString(),
    },
    watchdogDeps: provisioningDelivery.watchdogDeps,
    prepDeps: provisioningSupport.preparation,
    languageDeps: provisioningLanguageDeps,
    busyStatus: provisioningDelivery.busyStatus,
    inboxRelay: provisioningDelivery.deliveryPort,
  });
  return {
    root: provisioningRootRef,
    runtime: provisioningRuntime,
    shell: provisioningShell,
    delivery: provisioningDelivery,
    approvals: provisioningApprovals,
    repair: provisioningRepair,
  };
}
