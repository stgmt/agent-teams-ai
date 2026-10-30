import {
  validateAgentAttachmentIpcPayload,
  validateAgentAttachmentSerializedIpcPayload,
} from '@features/agent-attachments/main';
import { buildLeadMessageStdinPayload } from '@main/services/team/provisioning/TeamProvisioningLeadAttachments';
import { TaskChangeLedgerReader } from '@main/services/team/TaskChangeLedgerReader';

import { SendLeadMessage } from '../../core/application/commands/SendLeadMessage';
import { LeadMemberStartAuthority } from '../../core/application/LeadMemberStartAuthority';
import { NativeClaudeLaunchPlanner } from '../adapters/output/NativeClaudeLaunchPlanner';
import { NativeConfiguredProvider } from '../adapters/output/NativeConfiguredProvider';
import { NativeTeamTaskLedgerReader } from '../adapters/output/NativeTeamTaskLedgerReader';
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

import type { TeamRunIdentity, TeamRunRegistryRead } from '../../contracts';
import type { LifecycleCommands } from '../../core/application/ports/LifecycleCommands';
import type { LifecycleQueries } from '../../core/application/ports/LifecycleQueries';
import type { ConfiguredMemberLaunch } from '../../core/application/ports/MemberRuntimePorts';
import type { NativeConfiguredProviderPorts } from '../adapters/output/NativeConfiguredProvider';
import type { MemberLifecycle } from './createMemberLifecycle';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { TeamLaunchRuntimeAdapter } from '@main/services/team/runtime';
import type { AttachmentPayload } from '@shared/types';

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
  openCodeAdapter?: Pick<TeamLaunchRuntimeAdapter, 'launch' | 'reconcile' | 'stop'>;
  invalidate(teamName: string): void;
  contextInvalidationSignal(expected: AppConnectionContext): AbortSignal;
  withExpectedContext<T>(expected: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
}

export interface NativeTeamLifecycle {
  runs: TeamRunRegistryRead;
  commands: LifecycleCommands;
  queries: LifecycleQueries;
  taskChanges: Pick<NativeTeamTaskLedgerReader, 'read'>;
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
}

/** Composes native launch components without the former provisioning host or restart algorithm. */
export function createNativeTeamLifecycle(
  deps: NativeTeamLifecycleDependencies
): NativeTeamLifecycle {
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
  const nativeRuntime = new NodeMemberRuntime(planner, (expected, operation) =>
    deps.withExpectedContext(expected, operation)
  );
  const routing = createNativeMemberRuntimeRouting({
    processRuntime: nativeRuntime,
    settings,
    ...(deps.openCodeAdapter ? { openCodeAdapter: deps.openCodeAdapter } : {}),
  });
  const config = new NodeNativeTeamConfig({
    teamsRoot: deps.teamsRoot,
    settings,
    invalidate: (teamName) => deps.invalidate(teamName),
  });
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
      },
      release: async (run) => {
        await config.release(run);
        settings.release(run);
      },
    },
  });
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
  return {
    runs,
    taskChanges,
    commands: createBoundLifecycleCommands({
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
    }),
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
    snapshot: (teamName) => lifecycle.snapshot(teamName),
    watch: (teamName) => lifecycle.watch(teamName),
    stopConfigured: (run) => lifecycle.teams.stop(run),
    shutdown: () => lifecycle.teams.shutdown(),
    launchConfigured: (run) =>
      deps.withExpectedContext(run, async () => {
        const receipt = await lifecycle.teams.launchConfigured(
          run,
          async (signal) => (await settings.capture(run, signal)).members
        );
        return Object.freeze({ run: receipt.run });
      }),
  };
}
