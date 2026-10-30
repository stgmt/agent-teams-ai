import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { createAnthropicApiKeyHelperSetupLease } from '@main/services/team/provisioning/TeamProvisioningAnthropicApiKeyHelperLease';
import { applyTeamContextLimitEnv } from '@main/services/team/provisioning/TeamProvisioningEnvGuards';
import { getLaunchModelArg } from '@main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';
import { parseCliArgs } from '@shared/utils/cliArgsParser';
import { isTeamEffortLevel } from '@shared/utils/effortLevels';
import { isTeamProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import { isNativeRuntimeProvider } from '../../infrastructure/nativeRuntimeProvider';
import { ownedCleanup } from '../../infrastructure/ownedCleanup';
import { rejectAfterOwnedCleanup } from '../../infrastructure/rejectAfterOwnedCleanup';
import { withoutParentGitSelection } from '../../infrastructure/workspaceEnvironment';

import type { ConfiguredMemberLaunch } from '../../../core/application/ports/MemberRuntimePorts';
import type { NativeProviderLaunch } from './NativeClaudeLaunchPlanner';
import type {
  BuildProvisioningEnvOptions,
  ProvisioningEnvResolution,
} from '@main/services/team/provisioning/TeamProvisioningEnvBuilder';
import type { ResolveDirectMemberLaunchIdentityInput } from '@main/services/team/provisioning/TeamProvisioningLaunchIdentity';
import type {
  BuildTeamRuntimeLaunchArgsPlanInput,
  TeamRuntimeLaunchArgsPlan,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';
import type { ProviderModelLaunchIdentity, TeamProviderId } from '@shared/types';

export interface NativeConfiguredProviderPorts {
  prepareWorkspaceTrust(
    settings: Readonly<ConfiguredMemberLaunch>,
    signal: AbortSignal
  ): Promise<readonly string[]>;
  executable(): Promise<string>;
  environment(
    provider: TeamProviderId,
    backend: string | undefined,
    options: BuildProvisioningEnvOptions
  ): Promise<ProvisioningEnvResolution>;
  resolveIdentity(
    input: ResolveDirectMemberLaunchIdentityInput
  ): Promise<ProviderModelLaunchIdentity>;
  runtimeArgs(input: BuildTeamRuntimeLaunchArgsPlanInput): Promise<TeamRuntimeLaunchArgsPlan>;
}

/** Reuses provider selection/authentication functions, never the former lifecycle orchestrator. */
export class NativeConfiguredProvider {
  constructor(private readonly ports: NativeConfiguredProviderPorts) {}

  async prepare(
    settings: Readonly<ConfiguredMemberLaunch>,
    signal: AbortSignal
  ): Promise<NativeProviderLaunch> {
    const providerId = normalizeOptionalTeamProviderId(settings.providerId);
    if (!isNativeRuntimeProvider(providerId))
      throw new Error('Configured provider requires another native runtime adapter');
    if (settings.effort && !isTeamEffortLevel(settings.effort))
      throw new Error('Invalid configured reasoning effort');
    if (settings.providerBackendId && !isTeamProviderBackendId(settings.providerBackendId))
      throw new Error('Invalid configured provider backend');
    const providerBackendId = isTeamProviderBackendId(settings.providerBackendId)
      ? settings.providerBackendId
      : undefined;
    signal.throwIfAborted();
    const trustArgs = await this.ports.prepareWorkspaceTrust(settings, signal);
    signal.throwIfAborted();
    const executable = await this.ports.executable();
    signal.throwIfAborted();
    if (!executable.trim()) throw new Error('Configured native runtime executable is unavailable');
    const lease = createAnthropicApiKeyHelperSetupLease();
    let environment: ProvisioningEnvResolution;
    try {
      environment = await this.ports.environment(providerId, providerBackendId, {
        teamRuntimeAuth: {
          teamName: settings.team.teamName,
          memberName: settings.memberName,
          authMaterialId: randomUUID(),
          allowAnthropicApiKeyHelper: true,
          anthropicApiKeyHelperLease: lease,
        },
      });
      lease.coalesce(environment.anthropicApiKeyHelper);
    } catch (error) {
      return rejectAfterOwnedCleanup(error, () => lease.cleanup());
    }
    let argsPlan: TeamRuntimeLaunchArgsPlan | null = null;
    const dispose = ownedCleanup(async () => {
      const results = await Promise.allSettled([
        lease.cleanup(),
        !environment.anthropicApiKeyHelper && argsPlan?.appManagedSettingsPath
          ? rm(dirname(argsPlan.appManagedSettingsPath), {
              recursive: true,
              force: true,
              maxRetries: 20,
              retryDelay: 250,
            })
          : Promise.resolve(),
      ]);
      const errors: unknown[] = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason as unknown] : []
      );
      if (errors.length)
        throw new AggregateError(errors, 'Owned native provider resources could not be removed');
    });
    try {
      signal.throwIfAborted();
      if (environment.warning) throw new Error(environment.warning);
      environment = {
        ...environment,
        env: withoutParentGitSelection(environment.env),
        providerArgs: [...(environment.providerArgs ?? []), ...trustArgs],
      };
      const effort = isTeamEffortLevel(settings.effort) ? settings.effort : undefined;
      const memberSpec = {
        name: settings.memberName,
        providerId,
        providerBackendId,
        model: settings.model ?? undefined,
        effort,
        fastMode: settings.fastMode,
        cwd: settings.workingDirectory,
        agentType: settings.agentType,
      };
      const identity = await this.ports.resolveIdentity({
        claudePath: executable,
        cwd: settings.workingDirectory,
        providerId,
        providerBackendId,
        provisioningEnv: environment,
        memberSpec,
        requestLimitContext: settings.limitContext,
      });
      signal.throwIfAborted();
      argsPlan = await this.ports.runtimeArgs({
        teamName: settings.team.teamName,
        providerId,
        launchIdentity: identity,
        envResolution: environment,
        includeAnthropicHelper: true,
        extraArgs: parseCliArgs(settings.extraCliArgs),
        contextLabel: `Configured native member ${settings.memberName}`,
      });
      signal.throwIfAborted();
      const model = getLaunchModelArg(providerId, settings.model ?? undefined, identity);
      const args = [
        ...(model ? ['--model', model] : []),
        ...(identity.resolvedEffort ? ['--effort', identity.resolvedEffort] : []),
        ...argsPlan.providerArgs,
        ...argsPlan.fastModeArgs,
        ...argsPlan.runtimeTurnSettledHookArgs,
        ...argsPlan.settingsArgs,
        ...argsPlan.extraArgs,
        ...argsPlan.inheritedProviderArgs,
      ];
      const env = { ...environment.env };
      applyTeamContextLimitEnv(env, settings.limitContext);
      if (argsPlan.appManagedSettingsPath)
        env.CLAUDE_TEAM_RUNTIME_SETTINGS_PATH = argsPlan.appManagedSettingsPath;
      return { executable, args, env, dispose };
    } catch (error) {
      return rejectAfterOwnedCleanup(error, dispose);
    }
  }
}
