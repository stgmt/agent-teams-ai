import { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import { ProviderConnectionService } from '@main/services/runtime/ProviderConnectionService';
import { ClaudeBinaryResolver } from '@main/services/team/ClaudeBinaryResolver';
import { readRuntimeProviderLaunchFacts } from '@main/services/team/provisioning/TeamProvisioningLaunchIdentity';
import { isAuthFailureWarning } from '@main/services/team/provisioning/TeamProvisioningOutputErrorPolicy';
import { TeamProvisioningPrepareCoordinator } from '@main/services/team/provisioning/TeamProvisioningPrepareCoordinator';
import {
  createTeamProvisioningProviderDiagnosticsRuntime,
  type TeamProvisioningProviderDiagnosticsRuntime,
} from '@main/services/team/provisioning/TeamProvisioningProviderDiagnosticsPorts';
import {
  type CliHelpOutputCache,
  getCliHelpOutputForProvisioning,
} from '@main/services/team/provisioning/TeamProvisioningProviderPreflight';
import { createInMemoryProviderProbeCachePort } from '@main/services/team/provisioning/TeamProvisioningProviderProbeCache';
import { TeamMemberWorktreeManager } from '@main/services/team/TeamMemberWorktreeManager';
import { execCli } from '@main/utils/childProcess';

import type { NativeConfiguredProviderPorts } from '../adapters/output/NativeConfiguredProvider';
import type { PrepareForProvisioningOptions } from '@main/services/team/provisioning/TeamProvisioningPrepareCoordinator';
import type { TeamProvisioningProbeChild } from '@main/services/team/provisioning/TeamProvisioningProviderDiagnostics';
import type { TeamRuntimeAdapterRegistry } from '@main/services/team/runtime/TeamRuntimeAdapter';
import type { TeamProvisioningPrepareResult } from '@shared/types';

export interface NativeProvisioningPreparationDependencies {
  /** Provider auth/settings composition; owns the env the CLI is probed with. */
  provider: Pick<NativeConfiguredProviderPorts, 'environment' | 'executable'>;
  /** Startup-created adapters; the OpenCode entry answers prepare's adapter probe. */
  runtimeAdapterRegistry: Pick<TeamRuntimeAdapterRegistry, 'has' | 'get'>;
  logger: { info(message: string): void; warn(message: string): void };
  /** Shared with the launch path so one probe result serves both. */
  memberWorktrees?: TeamMemberWorktreeManager;
  diagnostics?: TeamProvisioningProviderDiagnosticsRuntime;
}

export interface NativeProvisioningPreparation {
  /**
   * The CLI help text the launch dialog shows. It comes from the same probe cache
   * and the same process launcher as readiness, so the help a user reads describes
   * the binary the launch will actually use.
   */
  getCliHelpOutput(cwd?: string): Promise<string>;
  /** Primes the CLI/provider probe so the first launch does not pay for it. */
  warmup(): Promise<void>;
  /** Checks the target project, providers and models before a launch begins. */
  prepareForProvisioning(
    cwd?: string,
    options?: PrepareForProvisioningOptions
  ): Promise<TeamProvisioningPrepareResult>;
}

/**
 * Project and provider preparation for a launch: the CLI probe, the selected
 * models, and the project directory. It owns no team runs, so it can answer before
 * any team exists.
 *
 * Every source below is a real one. The coordinator has tolerated empty answers for
 * years, which is why prepare could look successful while nothing was checked; a
 * missing source here is a wiring defect, not a supported state.
 */
export function createNativeProvisioningPreparation(
  deps: NativeProvisioningPreparationDependencies
): NativeProvisioningPreparation {
  const transientProbeProcesses = new Set<TeamProvisioningProbeChild>();
  const diagnostics =
    deps.diagnostics ??
    createTeamProvisioningProviderDiagnosticsRuntime({
      transientProbeProcesses,
      providerConnectionService: new ProviderConnectionService(),
      logger: deps.logger,
      isAuthFailureWarning,
      normalizeApiRetryErrorMessage: (text) => text.trim(),
    });
  const providerStatusBridge = new ClaudeMultimodelBridgeService();
  const memberWorktrees = deps.memberWorktrees ?? new TeamMemberWorktreeManager();
  const providerProbeCache = createInMemoryProviderProbeCachePort();
  const cliHelpCache: CliHelpOutputCache = { output: null, cachedAtMs: 0 };
  const coordinator = new TeamProvisioningPrepareCoordinator({
    providerProbeCache,
    getOpenCodeRuntimeAdapter: () =>
      deps.runtimeAdapterRegistry.has('opencode')
        ? deps.runtimeAdapterRegistry.get('opencode')
        : null,
    buildProvisioningEnv: (providerId, providerBackendId, options) => {
      // The coordinator defaults to Anthropic before calling; no provider here means
      // the caller skipped that default, and an env built for nobody proves nothing.
      if (!providerId) throw new Error('Provisioning environment requires a resolved provider');
      return deps.provider.environment(providerId, providerBackendId, options ?? {});
    },
    runProviderOneShotDiagnostic: (...args) => diagnostics.runProviderOneShotDiagnostic(...args),
    readRuntimeProviderLaunchFacts: (params) =>
      readRuntimeProviderLaunchFacts(params, {
        execCli,
        getCodexModelCatalog: (input) =>
          new ProviderConnectionService().getCodexModelCatalog(input),
        warn: (message) => deps.logger.warn(message),
      }),
    resolveClaudeBinaryPath: () => ClaudeBinaryResolver.resolve(),
    probeClaudeRuntime: (...args) => diagnostics.probeClaudeRuntime(...args),
    ensureMemberWorktree: (input) => memberWorktrees.ensureMemberWorktree(input),
    execCli,
    readOpenCodeProviderStatus: async ({ cwd }) => {
      const binaryPath = await ClaudeBinaryResolver.resolve();
      return binaryPath
        ? providerStatusBridge.getProviderStatus(binaryPath, 'opencode', undefined, {
            projectPath: cwd,
          })
        : null;
    },
    info: (message) => deps.logger.info(message),
    warn: (message) => deps.logger.warn(message),
  });

  return {
    warmup: () => coordinator.warmup(),
    prepareForProvisioning: (cwd, options) => coordinator.prepareForProvisioning(cwd, options),
    getCliHelpOutput: (cwd) =>
      getCliHelpOutputForProvisioning({
        ...(cwd ? { cwd } : {}),
        cache: cliHelpCache,
        ports: {
          // The binary the help text describes is the one readiness probes, resolved
          // by the same resolver; asking for a second one would describe another CLI.
          getCachedOrProbeResult: async () => {
            const claudePath = await ClaudeBinaryResolver.resolve();
            return claudePath ? { claudePath } : null;
          },
          buildProvisioningEnv: async () => ({
            env: (await deps.provider.environment('anthropic', undefined, {})).env,
          }),
          spawnProbe: (claudePath, args, targetCwd, env, timeoutMs) =>
            diagnostics.spawnProbe(claudePath, args, targetCwd, env, timeoutMs),
        },
        now: Date.now,
      }),
  };
}
