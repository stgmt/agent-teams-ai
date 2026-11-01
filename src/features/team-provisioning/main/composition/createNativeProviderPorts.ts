import { isAbsolute } from 'node:path';

import { createNativeWorkspaceTrust } from '@features/workspace-trust/main';
import { prepareAgentChildProcessWritableEnv } from '@main/services/runtime/agentChildProcessPreflight';
import { buildProvisioningEnv } from '@main/services/team/provisioning/TeamProvisioningEnvBuilder';
import { createTeamProvisioningLaunchIdentityBoundary } from '@main/services/team/provisioning/TeamProvisioningLaunchIdentityBoundaryFactory';
import { buildTeamRuntimeLaunchArgsPlan } from '@main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';
import { resolveInteractiveShellEnvBestEffort, waitForPendingShellEnv } from '@main/utils/shellEnv';

import { isNativeRuntimeProvider } from '../infrastructure/nativeRuntimeProvider';

import type { NativeConfiguredProviderPorts } from '../adapters/output/NativeConfiguredProvider';
import type { TeamProvisioningEnvBuilderPorts } from '@main/services/team/provisioning/TeamProvisioningEnvBuilder';
import type { TeamProvisioningLaunchIdentityBoundaryDeps } from '@main/services/team/provisioning/TeamProvisioningLaunchIdentityBoundaryFactory';

export interface NativeProviderProfile {
  homeDirectory: string;
  claudeConfigDirectory: string;
  autoDetectedClaudeConfigDirectory: string;
  attachmentRoot: string;
}

interface Dependencies {
  profile: Readonly<NativeProviderProfile>;
  executable(): Promise<string>;
  controlUrl(): Promise<string>;
  environment: Omit<
    TeamProvisioningEnvBuilderPorts,
    | 'buildRuntimeTurnSettledEnvironment'
    | 'resolveControlApiBaseUrl'
    | 'getHomeDir'
    | 'getClaudeBasePath'
    | 'getAutoDetectedClaudeBasePath'
    | 'buildProviderAwareCliEnv'
  > & {
    buildProviderAwareCliEnv: NonNullable<
      TeamProvisioningEnvBuilderPorts['buildProviderAwareCliEnv']
    >;
  };
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

/** Provider/auth/settings composition only: it owns no team runs or process registry. */
export function createNativeProviderPorts(deps: Dependencies): NativeConfiguredProviderPorts {
  const profile = Object.freeze({ ...deps.profile });
  if (Object.values(profile).some((value) => !isAbsolute(value)))
    throw new Error('Native provider profile paths must be absolute');
  const selectedEnvironment = deps.environment.processEnv ?? process.env;
  const stateEnvironment = Object.freeze({
    CLAUDE_CODE_CUSTOM_OAUTH_URL: selectedEnvironment.CLAUDE_CODE_CUSTOM_OAUTH_URL,
    USER_TYPE: selectedEnvironment.USER_TYPE,
    USE_LOCAL_OAUTH: selectedEnvironment.USE_LOCAL_OAUTH,
    USE_STAGING_OAUTH: selectedEnvironment.USE_STAGING_OAUTH,
  });
  const customProfile = profile.claudeConfigDirectory !== profile.autoDetectedClaudeConfigDirectory;
  const profileEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...env,
    HOME: profile.homeDirectory,
    USERPROFILE: profile.homeDirectory,
    // An explicit default directory changes the native credential namespace.
    CLAUDE_CONFIG_DIR: customProfile ? profile.claudeConfigDirectory : undefined,
    // Trust preparation and the CLI must select the same state-file namespace.
    ...stateEnvironment,
  });
  const workspaceTrust = createNativeWorkspaceTrust({
    homeDirectory: profile.homeDirectory,
    env: profileEnvironment({}),
  });
  const resolveShellEnv =
    deps.environment.resolveInteractiveShellEnvBestEffort ?? resolveInteractiveShellEnvBestEffort;
  const waitForShellEnv =
    deps.environment.waitForPendingShellEnv ??
    (deps.environment.resolveInteractiveShellEnvBestEffort ? undefined : waitForPendingShellEnv);
  const identity = createTeamProvisioningLaunchIdentityBoundary(deps.identity);
  const hookSettings = async (): Promise<Record<string, unknown>> => {
    const settings = await deps.workSync.buildRuntimeTurnSettledHookSettings({
      provider: 'claude',
    });
    if (!settings) throw new Error('Native Claude turn-settled hook settings are unavailable');
    return settings;
  };
  return {
    prepareWorkspaceTrust: (launch, signal) => {
      if (!isNativeRuntimeProvider(launch.providerId))
        throw new Error('Provider requires a non-native workspace trust adapter');
      return workspaceTrust.prepare(launch.providerId, launch.workingDirectory, signal);
    },
    executable: () => deps.executable(),
    resolveIdentity: (input) => identity.resolveDirectMemberLaunchIdentity(input),
    environment: async (providerId, providerBackendId, options) => {
      const result = await buildProvisioningEnv({
        providerId,
        providerBackendId,
        options,
        ports: {
          ...deps.environment,
          processEnv: profileEnvironment(deps.environment.processEnv ?? process.env),
          resolveInteractiveShellEnvBestEffort: async (...args) =>
            profileEnvironment(await resolveShellEnv(...args)),
          waitForPendingShellEnv: async () => {
            const env = await waitForShellEnv?.();
            return env ? profileEnvironment(env) : null;
          },
          getHomeDir: () => profile.homeDirectory,
          getClaudeBasePath: () => profile.claudeConfigDirectory,
          getAutoDetectedClaudeBasePath: () => profile.autoDetectedClaudeConfigDirectory,
          prepareAgentChildProcessWritableEnv: async (env, preparationOptions) => {
            const prepare =
              deps.environment.prepareAgentChildProcessWritableEnv ??
              prepareAgentChildProcessWritableEnv;
            const prepared = await prepare(env, preparationOptions);
            if (prepared.warning) throw new Error(prepared.warning);
            return prepared;
          },
          resolveControlApiBaseUrl: async () => {
            const url = await deps.controlUrl();
            if (!url) throw new Error('Bound desktop control URL is required');
            return url;
          },
          buildProviderAwareCliEnv: async (input) => {
            const provider = await deps.environment.buildProviderAwareCliEnv({
              ...input,
              env: profileEnvironment(input?.env ?? {}),
            });
            return { ...provider, env: profileEnvironment(provider.env) };
          },
          buildRuntimeTurnSettledEnvironment: async (provider) => {
            if (provider !== 'codex') return {};
            const env = await deps.workSync.buildRuntimeTurnSettledEnvironment({
              provider: 'codex',
            });
            if (!env) throw new Error('Native Codex turn-settled environment is unavailable');
            return env;
          },
        },
      });
      return { ...result, env: profileEnvironment(result.env) };
    },
    runtimeArgs: (input) =>
      buildTeamRuntimeLaunchArgsPlan(input, {
        buildRuntimeTurnSettledHookSettingsObject: (provider) =>
          provider === 'anthropic' ? hookSettings() : Promise.resolve(null),
        buildRuntimeTurnSettledHookSettingsArgs: async (provider) =>
          provider === 'anthropic' ? ['--settings', JSON.stringify(await hookSettings())] : [],
      }),
  };
}
