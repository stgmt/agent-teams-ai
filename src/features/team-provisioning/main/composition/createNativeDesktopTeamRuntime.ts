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
  definitions: TeamLaunchRequestPersistence;
  progressHistory: ProvisioningStatusReaderPort;
  bootstrapRuntime?: DesktopTeamRuntimeDependencies['bootstrapRuntime'];
  /** Teams to scan for orphaned native run claims at startup. */
  listTeamNames(): Promise<readonly string[]>;
  now?(): string;
}

export interface NativeDesktopTeamRuntime {
  lifecycle: NativeTeamLifecycle;
  runtime: DesktopTeamRuntime;
  /** Clears claims whose runs are not alive in this process. */
  recoverStartup(): Promise<readonly string[]>;
}

/**
 * One native owner for lifecycle + runtime reads. Transport wiring stays in the
 * cutover commit; this factory only assembles the production dependencies.
 */
export function createNativeDesktopTeamRuntime(
  deps: NativeDesktopTeamRuntimeDependencies
): NativeDesktopTeamRuntime {
  const lifecycle = createNativeTeamLifecycle({
    owner: deps.owner,
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
  });
  const runtime = createDesktopTeamRuntime({
    currentContext: deps.currentContext,
    lifecycle,
    definitions: deps.definitions,
    progressHistory: deps.progressHistory,
    ...(deps.bootstrapRuntime ? { bootstrapRuntime: deps.bootstrapRuntime } : {}),
    now: deps.now ?? (() => new Date().toISOString()),
  });
  return {
    lifecycle,
    runtime,
    recoverStartup: async () => lifecycle.recoverOrphanedRuns(await deps.listTeamNames()),
  };
}
