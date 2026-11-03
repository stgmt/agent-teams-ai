import { MemberLifecycleRegistry } from '../../core/domain/MemberLifecycleRegistry';

import { createDesktopTeamRuntime } from './createDesktopTeamRuntime';
import { createNativeTeamLifecycle } from './createNativeTeamLifecycle';

import type { ProvisioningStatusReaderPort } from '../../core/application/use-cases/GetProvisioningStatusUseCase';
import type {
  DesktopTeamRuntime,
  DesktopTeamRuntimeDependencies,
  TeamLaunchRequestPersistence,
} from './createDesktopTeamRuntime';
import type {
  NativeTeamLifecycle,
  NativeTeamLifecycleDependencies,
  OrphanedRunRecovery,
} from './createNativeTeamLifecycle';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';

export interface NativeDesktopTeamRuntimeDependencies {
  owner: AppConnectionContext;
  currentContext(): Readonly<AppConnectionContext>;
  teamsRoot: string;
  settings: NativeTeamLifecycleDependencies['settings'];
  provider: NativeTeamLifecycleDependencies['provider'];
  runtimeRoot: string;
  workspaceRoot: string;
  mcp: NativeTeamLifecycleDependencies['mcp'];
  inbox: NativeTeamLifecycleDependencies['inbox'];
  controlUrl(): Promise<string>;
  briefing: NativeTeamLifecycleDependencies['briefing'];
  invalidate(teamName: string): void;
  contextInvalidationSignal(expected: AppConnectionContext): AbortSignal;
  withExpectedContext<T>(expected: AppConnectionContext, operation: () => Promise<T>): Promise<T>;
  /** Startup-created registry; the OpenCode entry is selected only when present. */
  runtimeAdapterRegistry?: NativeTeamLifecycleDependencies['runtimeAdapterRegistry'];
  /** Where a failed launch reports why; the shell supplies its logger. */
  log?(message: string): void;
  /** Non-owning OpenCode prompt ledger; enables lane lead delivery and member relay. */
  openCodeMemberDelivery?: NativeTeamLifecycleDependencies['openCodeLeadDelivery'];
  definitions: TeamLaunchRequestPersistence;
  /**
   * Progress for runs the registry no longer holds. Omitted means the shell keeps no
   * such history, which is the only truthful answer: a run that left the registry and
   * was not retained is not answered from a guess.
   */
  progressHistory?: ProvisioningStatusReaderPort;
  bootstrapRuntime?: DesktopTeamRuntimeDependencies['bootstrapRuntime'];
  launchAdmission?: DesktopTeamRuntimeDependencies['launchAdmission'];
  /** Teams to scan for orphaned native run claims at startup. */
  listTeamNames(): Promise<readonly string[]>;
  /** Enables inbox relay polling after launch; omitted keeps relays on-demand. */
  relayIntervalMs?: number;
  now?(): string;
}

export interface NativeDesktopTeamRuntime {
  lifecycle: NativeTeamLifecycle;
  /**
   * The one mutable owner of run/member state this composition created. The
   * lifecycle mutates this exact instance; holding it here lets a caller fence
   * or inspect an exact run without reaching into the lifecycle facade.
   */
  registry: MemberLifecycleRegistry;
  runtime: DesktopTeamRuntime;
  /** Native in-memory logs; persistence across restart is a phase 7 concern. */
  logs: Pick<NativeTeamLifecycle['logs'], 'read'>;
  /** Clears claims whose runs are not alive in this process. */
  recoverStartup(): Promise<OrphanedRunRecovery>;
}

/**
 * One native owner for lifecycle + runtime reads. Transport wiring stays in the
 * cutover commit; this factory only assembles the production dependencies.
 */
export function createNativeDesktopTeamRuntime(
  deps: NativeDesktopTeamRuntimeDependencies
): NativeDesktopTeamRuntime {
  const registry = new MemberLifecycleRegistry(deps.owner);
  const lifecycle = createNativeTeamLifecycle({
    owner: deps.owner,
    registry,
    settings: deps.settings,
    provider: deps.provider,
    runtimeRoot: deps.runtimeRoot,
    workspaceRoot: deps.workspaceRoot,
    teamsRoot: deps.teamsRoot,
    mcp: deps.mcp,
    inbox: deps.inbox,
    controlUrl: deps.controlUrl,
    briefing: deps.briefing,
    invalidate: deps.invalidate,
    contextInvalidationSignal: deps.contextInvalidationSignal,
    withExpectedContext: deps.withExpectedContext,
    ...(deps.runtimeAdapterRegistry ? { runtimeAdapterRegistry: deps.runtimeAdapterRegistry } : {}),
    ...(deps.openCodeMemberDelivery ? { openCodeLeadDelivery: deps.openCodeMemberDelivery } : {}),
    ...(deps.relayIntervalMs ? { relayIntervalMs: deps.relayIntervalMs } : {}),
  });
  const runtime = createDesktopTeamRuntime({
    currentContext: deps.currentContext,
    lifecycle,
    definitions: deps.definitions,
    progressHistory: deps.progressHistory ?? { findByRunId: async () => undefined },
    ...(deps.bootstrapRuntime ? { bootstrapRuntime: deps.bootstrapRuntime } : {}),
    ...(deps.launchAdmission ? { launchAdmission: deps.launchAdmission } : {}),
    ...(deps.log ? { log: deps.log } : {}),
    teamsRootForFailureLog: deps.teamsRoot,
    now: deps.now ?? (() => new Date().toISOString()),
  });
  return {
    lifecycle,
    registry,
    runtime,
    logs: lifecycle.logs,
    recoverStartup: async () => lifecycle.recoverOrphanedRuns(await deps.listTeamNames()),
  };
}
