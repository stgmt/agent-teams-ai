// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { NativeConfiguredProvider } from '../../../../src/features/team-provisioning/main/adapters/output/NativeConfiguredProvider';
import { createNativeProviderPorts } from '../../../../src/features/team-provisioning/main/composition/createNativeProviderPorts';

import type { prepareAgentChildProcessWritableEnv } from '../../../../src/main/services/runtime/agentChildProcessPreflight';
import type { ProviderAwareCliEnvOptions } from '../../../../src/main/services/runtime/providerAwareCliEnv';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) =>
        rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
      )
  );
});

// РИСК: controlled provider facts/auth avoid real credentials and model calls; no CLI is launched.
async function setup(customProfile = true, stateEnvironment: NodeJS.ProcessEnv = {}) {
  const root = await mkdtemp(join(tmpdir(), 'TEST-native-provider-ports-'));
  directories.push(root);
  const homeDirectory = join(root, 'home');
  const autoDetectedClaudeConfigDirectory = join(homeDirectory, '.claude');
  const profile = {
    homeDirectory,
    claudeConfigDirectory: customProfile
      ? join(root, 'selected-profile')
      : autoDetectedClaudeConfigDirectory,
    autoDetectedClaudeConfigDirectory,
    attachmentRoot: join(root, 'attachments'),
  };
  await mkdir(homeDirectory);
  const commands: string[][] = [];
  const hookSettings = vi.fn(() =>
    Promise.resolve<Record<string, unknown> | null>({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'TEST-owned-hook' }] }] },
    })
  );
  const turnEnvironment = vi.fn(() =>
    Promise.resolve<Record<string, string> | null>({
      AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: join(root, 'spool'),
    })
  );
  const providerEnvironment = vi.fn((options: ProviderAwareCliEnvOptions = {}) =>
    Promise.resolve({
      env: { ...options.env },
      connectionIssues: {},
      providerArgs: ['--provider', String(options.providerId)],
    })
  );
  const writableEnvironment = vi.fn<typeof prepareAgentChildProcessWritableEnv>(() =>
    Promise.resolve({ applied: false })
  );
  const executable = vi.fn(() => Promise.resolve('TEST-runtime.exe'));
  const controlUrl = vi.fn(() => Promise.resolve('http://127.0.0.1:9999'));
  const pendingShellEnvironment = vi.fn(() => Promise.resolve<NodeJS.ProcessEnv | null>(null));
  const ports = createNativeProviderPorts({
    profile,
    executable,
    controlUrl,
    environment: {
      providerConnectionService: {
        augmentConfiguredConnectionEnv: (env) => Promise.resolve(env),
        getConfiguredAnthropicApiKeyForTeamRuntime: () => Promise.resolve(null),
      },
      logger: { warn: vi.fn(), error: vi.fn() },
      processEnv: {
        PATH: 'TEST-path',
        HOME: 'TEST-foreign-home',
        CLAUDE_CONFIG_DIR: 'TEST-foreign-profile',
        ...stateEnvironment,
      },
      platform: 'win32',
      resolveInteractiveShellEnvBestEffort: () =>
        Promise.resolve({ HOME: 'TEST-shell-home', CLAUDE_CONFIG_DIR: 'TEST-shell-profile' }),
      waitForPendingShellEnv: pendingShellEnvironment,
      buildProviderAwareCliEnv: providerEnvironment,
      prepareAgentChildProcessWritableEnv: writableEnvironment,
      resolveGeminiRuntimeAuth: () =>
        Promise.resolve({
          authenticated: true,
          authMethod: 'TEST',
          resolvedBackend: 'api',
          projectId: null,
          statusMessage: null,
        }),
      getOsUsername: () => 'TEST-user',
    },
    identity: {
      execCli: (_binary, args) => {
        commands.push(args);
        return Promise.resolve({
          stdout: JSON.stringify({
            providers: { gemini: { defaultModel: 'TEST-gemini', models: ['TEST-gemini'] } },
          }),
          stderr: '',
        });
      },
      providerConnectionService: { getCodexModelCatalog: () => Promise.resolve(null) },
      getAnthropicFastModeDefault: () => false,
      getProviderLabel: (provider) => provider,
      logger: { warn: vi.fn() },
    },
    workSync: {
      buildRuntimeTurnSettledHookSettings: hookSettings,
      buildRuntimeTurnSettledEnvironment: turnEnvironment,
    },
  });
  return {
    root,
    profile,
    ports,
    commands,
    hookSettings,
    turnEnvironment,
    providerEnvironment,
    executable,
    controlUrl,
    writableEnvironment,
    pendingShellEnvironment,
  };
}

describe('native provider dependency composition', () => {
  it.each([true, false])(
    'pins auth and child environment to the selected profile, custom=%s',
    async (custom) => {
      const { ports, profile, providerEnvironment, writableEnvironment } = await setup(custom);
      const result = await ports.environment('gemini', undefined, {});
      expect(result.env.HOME).toBe(profile.homeDirectory);
      expect(result.env.USERPROFILE).toBe(profile.homeDirectory);
      expect(result.env.CLAUDE_CONFIG_DIR).toBe(custom ? profile.claudeConfigDirectory : undefined);
      expect(result.env.CLAUDE_AGENT_TEAMS_ATTACHMENT_ROOT).toBe(profile.attachmentRoot);
      expect(writableEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          HOME: profile.homeDirectory,
          USERPROFILE: profile.homeDirectory,
        }),
        { home: profile.homeDirectory }
      );
      expect(providerEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({
          env: expect.objectContaining({
            HOME: profile.homeDirectory,
            USERPROFILE: profile.homeDirectory,
            CLAUDE_CONFIG_DIR: custom ? profile.claudeConfigDirectory : undefined,
          }),
        })
      );
    }
  );

  it('keeps the trust-state namespace identical before auth, after discovery and in the final child environment', async () => {
    const selected = {
      CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://TEST.invalid/oauth',
      USER_TYPE: 'ant',
      USE_LOCAL_OAUTH: 'false',
      USE_STAGING_OAUTH: 'true',
    };
    const { ports, providerEnvironment, writableEnvironment, pendingShellEnvironment } =
      await setup(true, selected);
    pendingShellEnvironment.mockResolvedValueOnce({
      CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://TEST-foreign.invalid/oauth',
      USER_TYPE: 'TEST-foreign',
      USE_LOCAL_OAUTH: 'true',
      USE_STAGING_OAUTH: 'false',
    });
    providerEnvironment.mockImplementationOnce((options = {}) =>
      Promise.resolve({
        env: {
          ...options.env,
          CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://TEST-provider.invalid/oauth',
          USER_TYPE: 'TEST-provider',
          USE_LOCAL_OAUTH: 'true',
          USE_STAGING_OAUTH: 'false',
        },
        connectionIssues: {},
        providerArgs: [],
      })
    );
    const result = await ports.environment('anthropic', undefined, {});
    expect(providerEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining(selected),
        shellEnv: expect.objectContaining(selected),
      })
    );
    expect(writableEnvironment).toHaveBeenCalledWith(
      expect.objectContaining(selected),
      expect.any(Object)
    );
    expect(result.env).toMatchObject(selected);
  });

  it('does not import a discovered OAuth namespace when the selected environment has none', async () => {
    const { ports, providerEnvironment, pendingShellEnvironment } = await setup(true, {
      CLAUDE_CODE_CUSTOM_OAUTH_URL: undefined,
      USER_TYPE: undefined,
      USE_LOCAL_OAUTH: undefined,
      USE_STAGING_OAUTH: undefined,
    });
    pendingShellEnvironment.mockResolvedValueOnce({
      CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://TEST-foreign.invalid/oauth',
      USER_TYPE: 'ant',
      USE_LOCAL_OAUTH: 'yes',
      USE_STAGING_OAUTH: 'on',
    });
    const result = await ports.environment('anthropic', undefined, {});
    for (const key of [
      'CLAUDE_CODE_CUSTOM_OAUTH_URL',
      'USER_TYPE',
      'USE_LOCAL_OAUTH',
      'USE_STAGING_OAUTH',
    ]) {
      expect(providerEnvironment.mock.calls[0][0]?.env?.[key]).toBeUndefined();
      expect(result.env[key]).toBeUndefined();
    }
  });

  it('pins completed shell discovery before provider auth and writable preparation', async () => {
    const { ports, profile, providerEnvironment, writableEnvironment, pendingShellEnvironment } =
      await setup();
    pendingShellEnvironment.mockResolvedValueOnce({
      HOME: 'TEST-pending-home',
      USERPROFILE: 'TEST-pending-home',
      CLAUDE_CONFIG_DIR: 'TEST-pending-profile',
      ANTHROPIC_MODEL: 'TEST-shell-model',
    });
    const result = await ports.environment('anthropic', undefined, {});
    expect(pendingShellEnvironment).toHaveBeenCalledOnce();
    expect(providerEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        shellEnv: expect.objectContaining({
          HOME: profile.homeDirectory,
          CLAUDE_CONFIG_DIR: profile.claudeConfigDirectory,
          ANTHROPIC_MODEL: 'TEST-shell-model',
        }),
      })
    );
    expect(writableEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ HOME: profile.homeDirectory }),
      { home: profile.homeDirectory }
    );
    expect(result.env.ANTHROPIC_MODEL).toBe('TEST-shell-model');
  });

  it('keeps the selected profile at writable preparation even if provider enrichment returns other paths', async () => {
    const { ports, profile, providerEnvironment, writableEnvironment } = await setup();
    providerEnvironment.mockImplementationOnce((options = {}) =>
      Promise.resolve({
        env: {
          ...options.env,
          HOME: 'TEST-provider-home',
          USERPROFILE: 'TEST-provider-home',
          CLAUDE_CONFIG_DIR: 'TEST-provider-profile',
        },
        connectionIssues: {},
        providerArgs: ['--provider', 'gemini'],
      })
    );
    await ports.environment('gemini', undefined, {});
    expect(writableEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        HOME: profile.homeDirectory,
        USERPROFILE: profile.homeDirectory,
        CLAUDE_CONFIG_DIR: profile.claudeConfigDirectory,
      }),
      { home: profile.homeDirectory }
    );
  });

  it('uses the provider factory namespace for trust preparation before any executable or auth probe', async () => {
    const { ports, root, profile, executable, providerEnvironment } = await setup(true, {
      USER_TYPE: 'ant',
      USE_LOCAL_OAUTH: 'true',
    });
    await mkdir(profile.claudeConfigDirectory);
    const cwd = join(root, 'TEST-project');
    await mkdir(cwd);
    const selected = join(profile.claudeConfigDirectory, '.claude-local-oauth.json');
    executable.mockImplementationOnce(async () => {
      const saved = JSON.parse(await readFile(selected, 'utf8'));
      expect(Object.values(saved.projects)).toEqual([{ hasTrustDialogAccepted: true }]);
      throw new Error('TEST boundary before CLI or provider call');
    });
    const provider = new NativeConfiguredProvider(ports);
    await expect(
      provider.prepare(
        {
          team: {
            appInstanceId: 'TEST-app',
            dataRootFingerprint: 'TEST-root',
            connectionGeneration: 1,
            teamName: 'test-profile-team',
            runId: 'TEST-run',
          },
          memberName: 'builder',
          configurationRevision: 'TEST-revision',
          providerId: 'anthropic',
          model: null,
          workingDirectory: cwd,
          instructions: 'TEST',
        },
        new AbortController().signal
      )
    ).rejects.toThrow('TEST boundary before CLI or provider call');
    expect(executable).toHaveBeenCalledOnce();
    expect(providerEnvironment).not.toHaveBeenCalled();
    await expect(
      readFile(join(profile.claudeConfigDirectory, '.claude.json'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(join(profile.homeDirectory, '.claude.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects failed child environment preparation instead of starting with a warning', async () => {
    const { ports, writableEnvironment } = await setup();
    writableEnvironment.mockResolvedValueOnce({
      applied: false,
      warning: 'TEST home is not writable',
    });
    await expect(ports.environment('gemini', undefined, {})).rejects.toThrow(
      'TEST home is not writable'
    );
  });

  it('uses the focused launch identity implementation without a provisioning host', async () => {
    const { ports, root, commands, executable } = await setup();
    expect(executable).not.toHaveBeenCalled();
    const binary = await ports.executable();
    const identity = await ports.resolveIdentity({
      claudePath: binary,
      cwd: root,
      providerId: 'gemini',
      provisioningEnv: { env: {}, providerArgs: ['--provider', 'gemini'] },
      memberSpec: { name: 'builder', model: 'TEST-gemini' },
    });
    expect(identity).toMatchObject({ providerId: 'gemini', resolvedLaunchModel: 'TEST-gemini' });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain('list');
  });

  it('materializes the actual Claude turn-settled hook into the owned runtime settings', async () => {
    const { ports, hookSettings, turnEnvironment } = await setup();
    const plan = await ports.runtimeArgs({
      teamName: 'test-team',
      providerId: 'anthropic',
      envResolution: {},
      includeAnthropicHelper: false,
      contextLabel: 'TEST',
    });
    expect(hookSettings).toHaveBeenCalledWith({ provider: 'claude' });
    expect(turnEnvironment).not.toHaveBeenCalled();
    expect(plan.appManagedSettingsPath).toBeTruthy();
    try {
      const saved = JSON.parse(await readFile(plan.appManagedSettingsPath!, 'utf8'));
      expect(saved.hooks.Stop[0].hooks[0].command).toBe('TEST-owned-hook');
    } finally {
      if (plan.appManagedSettingsPath) directories.push(join(plan.appManagedSettingsPath, '..'));
    }
  });

  it('propagates hook setup failure instead of producing an uninstrumented launch', async () => {
    const { ports, hookSettings } = await setup();
    hookSettings.mockRejectedValueOnce(new Error('TEST hook unavailable'));
    await expect(
      ports.runtimeArgs({
        teamName: 'test-team',
        providerId: 'anthropic',
        envResolution: {},
        includeAnthropicHelper: false,
        contextLabel: 'TEST',
      })
    ).rejects.toThrow('TEST hook unavailable');
    hookSettings.mockResolvedValueOnce(null);
    await expect(
      ports.runtimeArgs({
        teamName: 'test-team',
        providerId: 'anthropic',
        envResolution: {},
        includeAnthropicHelper: false,
        contextLabel: 'TEST',
      })
    ).rejects.toThrow('turn-settled');
  });

  it('requires Codex turn-settled environment and does not apply it to Gemini', async () => {
    const { ports, turnEnvironment, profile } = await setup();
    const codex = await ports.environment('codex', undefined, {});
    expect(codex.env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT).toBe(
      join(profile.attachmentRoot, '..', 'spool')
    );
    expect(turnEnvironment).toHaveBeenCalledWith({ provider: 'codex' });
    turnEnvironment.mockRejectedValueOnce(new Error('TEST spool unavailable'));
    await expect(ports.environment('codex', undefined, {})).rejects.toThrow(
      'TEST spool unavailable'
    );
    turnEnvironment.mockResolvedValueOnce(null);
    await expect(ports.environment('codex', undefined, {})).rejects.toThrow('turn-settled');
    const gemini = await ports.environment('gemini', undefined, {});
    expect(gemini.env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT).toBeUndefined();
    expect(turnEnvironment).toHaveBeenCalledTimes(3);
  });

  it('rejects absent control authority before returning an environment', async () => {
    const { ports, controlUrl } = await setup();
    controlUrl.mockResolvedValueOnce('');
    await expect(ports.environment('gemini', undefined, {})).rejects.toThrow(
      'Bound desktop control URL'
    );
  });
});
