import { createNativeProviderPorts } from './createNativeProviderPorts';

import type { NativeProviderProfile } from './createNativeProviderPorts';
import type { NativeProvisioningPreparationDependencies } from './createNativeProvisioningPreparation';
import type { TeamProvisioningEnvBuilderPorts } from '@main/services/team/provisioning/TeamProvisioningEnvBuilder';
import type { TeamProvisioningLaunchIdentityBoundaryDeps } from '@main/services/team/provisioning/TeamProvisioningLaunchIdentityBoundaryFactory';
import type { TeamRuntimeAdapterRegistry } from '@main/services/team/runtime/TeamRuntimeAdapter';

/** The environment builder's own ports, minus the five the provider composition fills. */
export type NativeProviderEnvironmentSources = Omit<
  TeamProvisioningEnvBuilderPorts,
  | 'buildRuntimeTurnSettledEnvironment'
  | 'resolveControlApiBaseUrl'
  | 'getHomeDir'
  | 'getAttachmentRoot'
  | 'getClaudeBasePath'
  | 'getAutoDetectedClaudeBasePath'
  | 'buildProviderAwareCliEnv'
> & { buildProviderAwareCliEnv: NonNullable<TeamProvisioningEnvBuilderPorts['buildProviderAwareCliEnv']> };

/**
 * What the provider composition needs from the shell. Paths and getters are passed
 * as values, never resolved here, so the composition has no ambient knowledge of
 * where the application keeps its directories.
 */
export interface NativeProviderProductionSources {
  profile: Readonly<NativeProviderProfile>;
  executable(): Promise<string>;
  controlUrl(): Promise<string>;
  environment: NativeProviderEnvironmentSources;
  identity: TeamProvisioningLaunchIdentityBoundaryDeps;
  workSync: {
    buildRuntimeTurnSettledHookSettings(input: {
      provider: 'claude';
    }): Promise<Record<string, unknown> | null>;
    buildRuntimeTurnSettledEnvironment(input: {
      provider: 'codex';
    }): Promise<Record<string, string> | null>;
  };
}

export interface NativeProvisioningSupportSources {
  provider: NativeProviderProductionSources;
  runtimeAdapterRegistry: Pick<TeamRuntimeAdapterRegistry, 'has' | 'get'>;
  logger: { info(message: string): void; warn(message: string): void };
}

export interface NativeProvisioningSupport {
  /** Provider auth/settings ports; the same instance feeds preparation and launch. */
  providerPorts: ReturnType<typeof createNativeProviderPorts>;
  preparation: NativeProvisioningPreparationDependencies;
}

/**
 * Preparation and launch must probe with the same provider ports; building them
 * twice would let the readiness answer describe a different environment than the
 * launch that follows it.
 */
export function createNativeProvisioningSupport(
  sources: NativeProvisioningSupportSources
): NativeProvisioningSupport {
  const providerPorts = createNativeProviderPorts({
    profile: sources.provider.profile,
    executable: () => sources.provider.executable(),
    controlUrl: () => sources.provider.controlUrl(),
    environment: sources.provider.environment,
    identity: sources.provider.identity,
    workSync: sources.provider.workSync,
  });
  return {
    providerPorts,
    preparation: {
      provider: providerPorts,
      runtimeAdapterRegistry: sources.runtimeAdapterRegistry,
      logger: sources.logger,
    },
  };
}
