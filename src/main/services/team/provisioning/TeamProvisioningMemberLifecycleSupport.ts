import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { cleanupAnthropicTeamApiKeyHelperMaterial } from '../../runtime/anthropicTeamApiKeyHelper';
import { getConfiguredCliFlavor } from '../cliFlavor';

import type { TeamLaunchRuntimeAdapter } from '../runtime';
import type {
  ProvisioningEnvResolution,
  TeamProvisioningMemberLifecycleHost,
} from './TeamProvisioningMemberLifecycleHostPorts';

const logger = createLogger('Service:TeamProvisioning');

export type RuntimeAdapterRunEntry = NonNullable<
  ReturnType<TeamProvisioningMemberLifecycleHost['runtimeAdapterRunByTeam']['get']>
>;

export type MemberLifecycleOpenCodeRuntimeAdapter = Exclude<
  ReturnType<TeamProvisioningMemberLifecycleHost['getOpenCodeRuntimeAdapter']>,
  null
> &
  Pick<TeamLaunchRuntimeAdapter, 'preflightLocalModels'>;

export function nowIso(): string {
  return new Date().toISOString();
}

export function getTeamRuntimeEventsDir(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, 'runtime');
}

export function buildMissingCliError(): Error {
  if (getConfiguredCliFlavor() === 'agent_teams_orchestrator') {
    return new Error(
      'Multimodel runtime not found. The packaged app must include resources/runtime/claude-multimodel, or development must provide CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH.'
    );
  }
  return new Error('Claude CLI not found; install it or provide a valid path');
}

export async function ensureCwdExists(cwd: string): Promise<void> {
  const stat = await fs.promises.stat(cwd).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Project path is not available for teammate restart: ${cwd}`);
  }
}

export async function cleanupPendingAnthropicApiKeyHelper(
  envResolution: ProvisioningEnvResolution,
  contextLabel: string
): Promise<void> {
  const helper = (
    envResolution as ProvisioningEnvResolution & {
      anthropicApiKeyHelper?: { directory: string } | null;
    }
  ).anthropicApiKeyHelper;
  if (!helper) {
    return;
  }
  // Cleanup stays best-effort so the original provisioning failure remains authoritative.
  await cleanupAnthropicTeamApiKeyHelperMaterial({
    directory: helper.directory,
    skipIfLiveProcessReferences: true,
  }).catch((cleanupError: unknown) => {
    logger.warn(
      `[${contextLabel}] Failed to clean pending Anthropic API-key helper: ${
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }`
    );
  });
}
