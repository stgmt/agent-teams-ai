// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { createNativeProvisioningPreparation } from '../../../../src/features/team-provisioning/main/composition/createNativeProvisioningPreparation';

import type { TeamProvisioningProviderDiagnosticsRuntime } from '../../../../src/main/services/team/provisioning/TeamProvisioningProviderDiagnosticsPorts';
import type { TeamRuntimeAdapterRegistry } from '../../../../src/main/services/team/runtime/TeamRuntimeAdapter';

function preparation(options: {
  probe?: () => Promise<{ warning?: string }>;
  logger?: { info: (message: string) => void; warn: (message: string) => void };
} = {}) {
  const registry = { has: () => false, get: () => null } as unknown as Pick<
    TeamRuntimeAdapterRegistry,
    'has' | 'get'
  >;
  const probe = options.probe ?? (async () => ({}));
  const diagnostics = {
    getBasePorts: () => ({}) as never,
    getPorts: () => ({}) as never,
    probeClaudeRuntime: probe,
    probeProviderRuntimeControlPlane: async () => ({}),
    runProviderOneShotDiagnostic: probe,
  } as unknown as TeamProvisioningProviderDiagnosticsRuntime;
  return createNativeProvisioningPreparation({
    provider: {
      environment: async () => ({
        env: {},
        authSource: 'none',
        geminiRuntimeAuth: null,
        providerArgs: [],
      }),
      executable: async () => '/TEST/claude',
    },
    runtimeAdapterRegistry: registry,
    diagnostics,
    logger: options.logger ?? { info: () => undefined, warn: () => undefined },
  });
}

describe('native provisioning preparation', () => {
  it('warms up without failing the app when the CLI probe throws', async () => {
    const warn = vi.fn();
    const subject = preparation({
      probe: async () => {
        throw new Error('cli is not installed');
      },
      logger: { info: () => undefined, warn },
    });

    await expect(subject.warmup()).resolves.toBeUndefined();
  });

  it('refuses to prepare a relative project path instead of guessing one', async () => {
    await expect(preparation().prepareForProvisioning('relative/project')).rejects.toThrow(
      /absolute path/i
    );
  });

});
