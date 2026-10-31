import {
  validateAgentAttachmentIpcPayload,
  validateAgentAttachmentSerializedIpcPayload,
} from '@features/agent-attachments/main';
import { buildLeadMessageStdinPayload } from '@main/services/team/provisioning/TeamProvisioningLeadAttachments';
import { TaskChangeLedgerReader } from '@main/services/team/TaskChangeLedgerReader';
import { TeamInboxReader } from '@main/services/team/TeamInboxReader';

import { SendLeadMessage } from '../../core/application/commands/SendLeadMessage';
import { LeadMemberStartAuthority } from '../../core/application/LeadMemberStartAuthority';
import { NativeClaudeLaunchPlanner } from '../adapters/output/NativeClaudeLaunchPlanner';
import {
  NativeClaudeApprovalStore,
  NativeClaudeToolApprovals,
} from '../adapters/output/NativeClaudeToolApprovals';
import { NativeConfiguredProvider } from '../adapters/output/NativeConfiguredProvider';
import { NativeLeadInboxRelay } from '../adapters/output/NativeLeadInboxRelay';
import { NativeMemberInboxRelay } from '../adapters/output/NativeMemberInboxRelay';
import { NativeTeamLogStore } from '../adapters/output/NativeTeamLogStore';
import { NativeTeamTaskLedgerReader } from '../adapters/output/NativeTeamTaskLedgerReader';
import { NativeToolApprovalSettings } from '../adapters/output/NativeToolApprovalSettings';
import { NodeMemberRuntime } from '../adapters/output/NodeMemberRuntime';
import { NodeNativeLaunchArtifacts } from '../adapters/output/NodeNativeLaunchArtifacts';
import { NodeNativeMemberRegistration } from '../adapters/output/NodeNativeMemberRegistration';
import { NodeNativeTeamConfig } from '../adapters/output/NodeNativeTeamConfig';
import { NodeTeamLaunchSettings } from '../adapters/output/NodeTeamLaunchSettings';
import { NodeTeamWorkspace } from '../adapters/output/NodeTeamWorkspace';
import { nativeTeamTaskLedgerProjectDirectory } from '../infrastructure/nativeTeamTaskLedger';

import { createBoundLifecycleCommands } from './createBoundLifecycleCommands';
import { createBoundLifecycleQueries } from './createBoundLifecycleQueries';
import { createMemberLifecycle } from './createMemberLifecycle';
import { createNativeMemberRuntimeRouting } from './createNativeMemberRuntimeRouting';
import { type OpenCodeLaneAdapter, selectOpenCodeLaneAdapter } from './selectOpenCodeLaneAdapter';

import type { MemberProcessToken, TeamRunIdentity, TeamRunRegistryRead } from '../../contracts';
import type { MemberLifecycleCommands } from '../../core/application/commands/MemberLifecycleCommands';
import type { LifecycleCommands } from '../../core/application/ports/LifecycleCommands';
import type { LifecycleQueries } from '../../core/application/ports/LifecycleQueries';
import type { ConfiguredMemberLaunch } from '../../core/application/ports/MemberRuntimePorts';
import type { NativeConfiguredProviderPorts } from '../adapters/output/NativeConfiguredProvider';
import type { MemberLifecycle } from './createMemberLifecycle';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { TeamRuntimeAdapterRegistry } from '@main/services/team/runtime';
import type {
  AttachmentPayload,
  InboxMessage,
  RetryFailedOpenCodeSecondaryLanesResult,
} from '@shared/types';

export interface NativeTeamLifecycleDependencies {
  owner: AppConnectionContext;
  settings: Omit<ConstructorParameters<typeof NodeTeamLaunchSettings>[0], 'teamsRoot'>;
  provider: NativeConfiguredProviderPorts;
  runtimeRoot: string;
  workspaceRoot: string;
  teamsRoot: string;
  mcp: ConstructorParameters<typeof NodeNativeLaunchArtifacts>[0]['mcp'];
  inbox: ConstructorParameters<typeof NodeNativeMemberRegistration>[0]['inbox'];
  controlUrl(): Promise<string>;
  briefing(settings: Readonly<ConfiguredMemberLaunch>): Promise<string>;
  /** Adapter for OpenCode lanes; omitted keeps OpenCode unsupported by native launch. */
  openCodeAdapter?: OpenCodeLaneAdapter;
  /** Production registry entry source; used when `openCodeAdapter` is omitted. */
  runtimeAdapterRegistry?: Pick<TeamRuntimeAdapterRegistry, 'has' | 'get'>;
  /** Lead inbox reader; defaults to the shared file reader. */
  inboxReader?: { getMessagesFor(teamName: string, member: string): Promise<InboxMessage[]> };
  /** Enables inbox relay polling after a successful launch. Omitted keeps relays on-demand. */
  relayIntervalMs?: number;
  invalidate(teamName: string): void;
  contextInvalidationSignal(expected: AppConnectionContext): AbortSignal;
  withExpectedContext<T>(expected: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
}

export interface OrphanedRunRecovery {
  recovered: readonly string[];
  failed: readonly { teamName: string; error: string }[];
}

export interface NativeTeamLifecycle {
  owner: Readonly<AppConnectionContext>;
  runs: TeamRunRegistryRead;
  commands: LifecycleCommands;
  queries: LifecycleQueries;
  settings: Pick<NodeTeamLaunchSettings, 'findConfiguredMember'>;
  memberCommands: {
    restartMember: LifecycleCommands['restartMember'];
    skipMember: LifecycleCommands['skipMember'];
    retryFailedLanes(run: TeamRunIdentity): Promise<RetryFailedOpenCodeSecondaryLanesResult>;
    answerLanePermission: MemberLifecycleCommands['answerLanePermission'];
  };
  logs: Pick<NativeTeamLogStore, 'read'>;
  approvals: Pick<NativeClaudeToolApprovals, 'list' | 'respond' | 'onEvent'>;
  toolApprovalSettings: Pick<NativeToolApprovalSettings, 'get' | 'update'>;
  taskChanges: Pick<NativeTeamTaskLedgerReader, 'read'>;
  relay: Pick<
    NativeLeadInboxRelay,
    'relay' | 'schedule' | 'cancel' | 'startPolling' | 'stopPolling' | 'reset' | 'dispose'
  >;
  memberRelay: Pick<
    NativeMemberInboxRelay,
    'relay' | 'startPolling' | 'stopPolling' | 'reset' | 'dispose'
  >;
  /** Starts inbox polling for both relays; phase 8 calls this after a successful launch. */
  startRelays(teamName: string, intervalMs: number): void;
  stopRelays(teamName: string): void;
  leadStart: Pick<MemberLifecycle['leadStart'], 'execute'>;
  resolveLeadCredential(credential: string): Readonly<TeamRunIdentity>;
  snapshot: MemberLifecycle['snapshot'];
  watch: MemberLifecycle['watch'];
  launchConfigured(run: TeamRunIdentity): Promise<Readonly<{ run: Readonly<TeamRunIdentity> }>>;
  stopConfigured(run: TeamRunIdentity): Promise<void>;
  shutdown(): Promise<void>;
  sendLeadMessage(
    run: TeamRunIdentity,
    text: string,
    attachments?: readonly Readonly<AttachmentPayload>[]
  ): Promise<void>;
  /** Clears native run claims that are not alive in this process. */
  recoverOrphanedRuns(teamNames: readonly string[]): Promise<OrphanedRunRecovery>;
}

/** Composes native launch components without the former provisioning host or restart algorithm. */
export function createNativeTeamLifecycle(
  deps: NativeTeamLifecycleDependencies
): NativeTeamLifecycle {
  if (
    deps.relayIntervalMs !== undefined &&
    (!Number.isSafeInteger(deps.relayIntervalMs) || deps.relayIntervalMs < 1)
  )
    throw new Error('Relay polling interval must be a positive integer');
  const authority = new LeadMemberStartAuthority();
  const settings = new NodeTeamLaunchSettings({ ...deps.settings, teamsRoot: deps.teamsRoot });
  const provider = new NativeConfiguredProvider(deps.provider);
  const registration = new NodeNativeMemberRegistration({
    teamsRoot: deps.teamsRoot,
    inbox: deps.inbox,
    invalidate: (teamName) => deps.invalidate(teamName),
  });
  const artifacts = new NodeNativeLaunchArtifacts({
    runtimeRoot: deps.runtimeRoot,
    mcp: deps.mcp,
    controlUrl: () => deps.controlUrl(),
    leadCredential: (run) => authority.credentialFor(run),
    briefing: (launch) => deps.briefing(launch),
    registration,
  });
  const workspace = new NodeTeamWorkspace(deps.workspaceRoot, (launch) =>
    Promise.resolve(nativeTeamTaskLedgerProjectDirectory(deps.teamsRoot, launch.team.teamName))
  );
  const planner = new NativeClaudeLaunchPlanner({
    prepareWorkspace: (launch, signal) => workspace.prepare(launch, signal),
    prepareProvider: (launch, signal) => provider.prepare(launch, signal),
    prepareArtifacts: (launch, token, signal) => artifacts.prepare(launch, token, signal),
  });
  const logs = new NativeTeamLogStore({ teamsRoot: deps.teamsRoot });
  const toolApprovalSettings = new NativeToolApprovalSettings();
  let writeApprovalLine: (
    token: Readonly<MemberProcessToken>,
    line: string
  ) => Promise<void> = async () => {
    throw new Error('Native approval input is not wired');
  };
  const approvals = new NativeClaudeToolApprovals({
    store: new NativeClaudeApprovalStore(),
    write: (token, line) => writeApprovalLine(token, line),
  });
  const plannerWithLogs = {
    prepare: async (
      launch: Parameters<typeof planner.prepare>[0],
      token: Parameters<typeof planner.prepare>[1],
      signal: AbortSignal
    ) => {
      const plan = await planner.prepare(launch, token, signal);
      return {
        ...plan,
        observeOutput: (line: string, stream: 'stdout' | 'stderr') => {
          if (stream === 'stdout') approvals.observeLine(token, line);
          logs.append(token.runId, token.teamName, stream === 'stderr' ? `[stderr] ${line}` : line);
          return plan.observeOutput?.(line, stream) ?? null;
        },
      };
    },
  };
  const nativeRuntime = new NodeMemberRuntime(plannerWithLogs, (expected, operation) =>
    deps.withExpectedContext(expected, operation)
  );
  const openCodeAdapter =
    deps.openCodeAdapter ?? selectOpenCodeLaneAdapter(deps.runtimeAdapterRegistry);
  const routing = createNativeMemberRuntimeRouting({
    processRuntime: nativeRuntime,
    settings,
    ...(openCodeAdapter ? { openCodeAdapter } : {}),
  });
  const config = new NodeNativeTeamConfig({
    teamsRoot: deps.teamsRoot,
    settings,
    invalidate: (teamName) => deps.invalidate(teamName),
  });
  let relay: NativeLeadInboxRelay | null = null;
  let memberRelayRef: NativeMemberInboxRelay | null = null;
  const lifecycle = createMemberLifecycle({
    owner: deps.owner,
    settings,
    authority,
    runtime: routing.runtime,
    laneGroups: routing.laneGroups,
    teamResources: {
      prepare: async (run, signal) => {
        await settings.prepareWorkspace(run, workspace, signal);
        await config.prepare(run, signal);
        const configured = await settings.runtimeConfiguration(run);
        const lead = configured.members.find(({ launch }) => launch.role === 'lead');
        toolApprovalSettings.initializeForLaunch(run.teamName, lead?.launch.skipPermissions);
      },
      release: async (run) => {
        relay?.reset(run.teamName);
        memberRelayRef?.reset(run.teamName);
        await config.release(run);
        settings.release(run);
        logs.retainLast(run.teamName, run.runId);
        approvals.clearRun(run.runId);
      },
    },
  });
  writeApprovalLine = (token, line) => lifecycle.commands.writeInput(token, line);
  const send = new SendLeadMessage({
    snapshot: (teamName) => lifecycle.snapshot(teamName),
    write: (token, line) => lifecycle.commands.writeInput(token, line),
    encode: async (text, run, attachments) => {
      const validated = validateAgentAttachmentIpcPayload(attachments);
      if (!validated.valid) throw new Error(validated.error);
      const budget = validateAgentAttachmentSerializedIpcPayload({
        text,
        attachments: validated.value,
      });
      if (!budget.valid) throw new Error(budget.error);
      const lead = Object.values(lifecycle.snapshot(run.teamName).members).find(
        (member) => member.role === 'lead'
      );
      const launch = lead && (await settings.findConfiguredMember(run, lead.memberName));
      if (!launch) throw new Error('Configured lead launch settings are unavailable');
      return buildLeadMessageStdinPayload({
        teamName: run.teamName,
        runId: run.runId,
        providerId: launch.providerId,
        text,
        attachments: validated.value,
      });
    },
  });
  const queries = createBoundLifecycleQueries({
    owner: deps.owner,
    source: lifecycle.registry,
    invalidationSignal: (expected) => deps.contextInvalidationSignal(expected),
    withExpectedContext: (expected, operation) => deps.withExpectedContext(expected, operation),
  });
  const resolveLeadCredential = (credential: string): Readonly<TeamRunIdentity> => {
    const run = authority.resolve(credential);
    deps.contextInvalidationSignal(run).throwIfAborted();
    lifecycle.registry.assertRun(run);
    if (lifecycle.snapshot(run.teamName).desired !== 'running')
      throw new Error('Lead team run is no longer running');
    return run;
  };
  const ledger = new TaskChangeLedgerReader();
  const taskChanges = new NativeTeamTaskLedgerReader({
    teamsRoot: deps.teamsRoot,
    queries,
    reader: { readTaskChanges: (input) => ledger.readCurrentTaskChanges(input) },
  });
  const runs = Object.freeze<TeamRunRegistryRead>({
    find: (teamName) => lifecycle.registry.find(teamName),
    findByRunId: (runId) => lifecycle.registry.findByRunId(runId),
    hasRun: (run) => lifecycle.registry.hasRun(run),
    isLive: (run) => lifecycle.registry.isLive(run),
    aliveTeamNames: () => lifecycle.registry.aliveTeamNames(),
    aliveRunId: (teamName) => lifecycle.registry.aliveRunId(teamName),
  });
  const inboxReader = deps.inboxReader ?? new TeamInboxReader();
  const leadRelay = new NativeLeadInboxRelay({
    runs,
    snapshot: (teamName) => lifecycle.snapshot(teamName),
    inbox: inboxReader,
    send: (run, text) => deps.withExpectedContext(run, () => send.execute(run, text)),
    teamsRoot: deps.teamsRoot,
    controlUrl: () => deps.controlUrl(),
  });
  const memberRelay = new NativeMemberInboxRelay({
    runs,
    snapshot: (teamName) => lifecycle.snapshot(teamName),
    inbox: inboxReader,
    send: (run, text) => deps.withExpectedContext(run, () => send.execute(run, text)),
    teamsRoot: deps.teamsRoot,
  });
  memberRelayRef = memberRelay;
  relay = leadRelay;
  const startRelays = (teamName: string, intervalMs: number): void => {
    leadRelay.startPolling(teamName, intervalMs);
    memberRelay.startPolling(teamName, intervalMs);
  };
  const stopRelays = (teamName: string): void => {
    leadRelay.stopPolling(teamName);
    memberRelay.stopPolling(teamName);
  };
  const commands = createBoundLifecycleCommands({
    owner: deps.owner,
    source: {
      launchCurrent: (...args) => lifecycle.teams.launchCurrent(...args),
      stop: (run) => lifecycle.teams.stop(run),
      restart: (target, signal) => lifecycle.commands.restart(target, signal),
      skip: (target, signal) => lifecycle.commands.skip(target, signal),
    },
    load: async (run, signal) => (await settings.capture(run, signal)).members,
    invalidationSignal: (expected) => deps.contextInvalidationSignal(expected),
    withExpectedContext: (expected, operation) => deps.withExpectedContext(expected, operation),
  });
  const memberCommands: NativeTeamLifecycle['memberCommands'] = {
    restartMember: commands.restartMember,
    skipMember: commands.skipMember,
    retryFailedLanes: (run) =>
      deps.withExpectedContext(run, () => lifecycle.commands.retryFailedLanes(run)),
    answerLanePermission: (input) =>
      deps.withExpectedContext(input.run, () => lifecycle.commands.answerLanePermission(input)),
  };
  return {
    owner: Object.freeze({ ...deps.owner }),
    runs,
    logs,
    approvals,
    toolApprovalSettings,
    taskChanges,
    relay: leadRelay,
    memberRelay,
    startRelays,
    stopRelays,
    commands,
    settings,
    memberCommands,
    queries,
    resolveLeadCredential,
    leadStart: {
      execute: async (credential, input) => {
        const run = resolveLeadCredential(credential);
        return deps.withExpectedContext(run, () => lifecycle.leadStart.execute(credential, input));
      },
    },
    sendLeadMessage: (run, text, attachments) =>
      deps.withExpectedContext(run, () => send.execute(run, text, attachments)),
    recoverOrphanedRuns: async (teamNames) => {
      const recovered: string[] = [];
      const failed: { teamName: string; error: string }[] = [];
      for (const teamName of teamNames) {
        try {
          if (
            await config.recoverOrphanedClaim(
              teamName,
              (run) => lifecycle.registry.hasRun(run) && lifecycle.registry.isLive(run)
            )
          )
            recovered.push(teamName);
        } catch (error) {
          failed.push({
            teamName,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return { recovered, failed };
    },
    snapshot: (teamName) => lifecycle.snapshot(teamName),
    watch: (teamName) => lifecycle.watch(teamName),
    stopConfigured: (run) => lifecycle.teams.stop(run),
    shutdown: async () => {
      leadRelay.dispose();
      memberRelay.dispose();
      try {
        await lifecycle.teams.shutdown();
      } finally {
        logs.dispose();
      }
    },
    launchConfigured: (run) =>
      deps.withExpectedContext(run, async () => {
        const receipt = await lifecycle.teams.launchConfigured(
          run,
          async (signal) => (await settings.capture(run, signal)).members
        );
        if (deps.relayIntervalMs) startRelays(run.teamName, deps.relayIntervalMs);
        return Object.freeze({ run: receipt.run });
      }),
  };
}
