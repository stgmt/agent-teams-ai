import fs from 'node:fs/promises';
import path from 'node:path';

import {
  applyWorkspaceTrustLaunchArgPatches,
  buildWorkspaceTrustPathCandidates,
} from '../../core/domain';
import { FileClaudeStateProbe } from '../adapters/output/ClaudeStateProbe';
import { FileClaudeTrustPersister } from '../adapters/output/ClaudeTrustPersister';
import {
  resolveWorkspaceTrustCanonicalGitRoot,
  resolveWorkspaceTrustFilesystemGitRoot,
} from '../infrastructure/WorkspaceTrustCanonicalGitRoot';
import { resolveWorkspaceTrustFeatureFlags } from '../infrastructure/WorkspaceTrustFeatureFlags';
import { createWorkspaceTrustCoordinator } from './createWorkspaceTrustCoordinator';

import type {
  WorkspaceTrustProvider,
  WorkspaceTrustWorkspace,
} from '../../core/domain';

/**
 * Workspace trust for native provider spawns.
 *
 * The trust state namespace is derived from the home directory and process
 * environment, so the state written here is the state file the CLI reads.
 * Claude-family providers get their project entry written before any provider
 * probe; providers that take trust through launch arguments get the planned
 * argument patch instead.
 */
export interface NativeWorkspaceTrustPreparation {
  prepare(providerId: string, workingDirectory: string, signal?: AbortSignal): Promise<string[]>;
}

const NATIVE_TRUST_PROVIDERS: readonly WorkspaceTrustProvider[] = [
  'anthropic',
  'claude',
  'codex',
  'gemini',
  'opencode',
];

const ARGUMENT_TRUST_PROVIDERS: readonly WorkspaceTrustProvider[] = ['codex'];

function isTrustProvider(providerId: string): providerId is WorkspaceTrustProvider {
  return (NATIVE_TRUST_PROVIDERS as readonly string[]).includes(providerId);
}

export function createNativeWorkspaceTrust(input: {
  homeDirectory: string;
  env?: NodeJS.ProcessEnv;
  claudeConfigDir?: string;
  globalConfigFilePath?: string;
}): NativeWorkspaceTrustPreparation {
  const env = input.env ?? process.env;
  const claudeConfigDir =
    input.claudeConfigDir ?? env.CLAUDE_CONFIG_DIR ?? path.join(input.homeDirectory, '.claude');
  // Local OAuth launches keep their trust state inside the selected profile, so trust written
  // here is exactly the state file the CLI reads for that profile.
  const globalConfigFilePath =
    input.globalConfigFilePath ??
    (env.USE_LOCAL_OAUTH === 'true'
      ? path.join(claudeConfigDir, '.claude-local-oauth.json')
      : path.join(input.homeDirectory, '.claude.json'));
  const coordinator = createWorkspaceTrustCoordinator({ claudeConfigDir, globalConfigFilePath });
  const stateProbe = new FileClaudeStateProbe({ claudeConfigDir, globalConfigFilePath });
  const trustPersister = new FileClaudeTrustPersister({
    claudeConfigDir,
    globalConfigFilePath,
    homeDir: input.homeDirectory,
  });
  const featureFlags = resolveWorkspaceTrustFeatureFlags(env);

  const workspaceFor = async (workingDirectory: string): Promise<WorkspaceTrustWorkspace> => {
    const cwd = workingDirectory.trim();
    if (!cwd) throw new Error('Workspace trust requires a working directory');
    const realCwd = await fs.realpath(cwd);
    const filesystemGitRoot = await resolveWorkspaceTrustFilesystemGitRoot(cwd);
    const gitRoot = filesystemGitRoot
      ? await resolveWorkspaceTrustCanonicalGitRoot(filesystemGitRoot)
      : null;
    const [workspace] = buildWorkspaceTrustPathCandidates({
      cwd,
      realCwd,
      gitRoot,
      homeDir: input.homeDirectory,
      source: 'team-root',
      platform: process.platform === 'win32' ? 'win32' : 'posix',
    });
    if (!workspace) throw new Error('Workspace trust candidates are unavailable');
    return workspace;
  };

  return {
    async prepare(providerId, workingDirectory, signal) {
      if (!featureFlags.enabled) return [];
      if (!isTrustProvider(providerId))
        throw new Error(`Provider requires a non-native workspace trust adapter: ${providerId}`);
      signal?.throwIfAborted();
      const workspace = await workspaceFor(workingDirectory);
      signal?.throwIfAborted();
      if (ARGUMENT_TRUST_PROVIDERS.includes(providerId)) {
        const plan = await coordinator.planArgsOnly({
          providers: [providerId],
          workspaces: [workspace],
          targetSurfaces: ['primary_provider_args'],
          featureFlags,
        });
        signal?.throwIfAborted();
        return applyWorkspaceTrustLaunchArgPatches({
          args: [],
          patches: plan.launchArgPatches,
          targetProvider: providerId,
          targetSurface: 'primary_provider_args',
        }).args;
      }
      if ((await stateProbe.readTrustState(workspace)).status !== 'trusted') {
        const result = await trustPersister.persistTrustState(workspace);
        if (!result.ok)
          throw new Error(
            `Workspace trust could not be prepared for ${workspace.displayCwd}: ${result.message}`
          );
      }
      signal?.throwIfAborted();
      return [];
    },
  };
}
