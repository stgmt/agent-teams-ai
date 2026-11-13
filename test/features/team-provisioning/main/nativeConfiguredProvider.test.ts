// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import {
  NativeConfiguredProvider,
  type NativeConfiguredProviderPorts,
} from '../../../../src/features/team-provisioning/main/adapters/output/NativeConfiguredProvider';

import type { ProvisioningEnvResolution } from '../../../../src/main/services/team/provisioning/TeamProvisioningEnvBuilder';
import type { ProviderModelLaunchIdentity } from '../../../../src/shared/types';

const team = {
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: 1,
  teamName: 'TEST-team',
  runId: 'TEST-run',
};
const settings = {
  team,
  memberName: 'builder',
  role: 'member' as const,
  configurationRevision: 'TEST-revision',
  specIntegration: {
    scope: { projects: ['TEST/project'], bindings: [] },
    environment: {
      OMP_SPEC_REGISTRY_URL: 'http://127.0.0.1:8090',
      OMP_SPEC_REGISTRY_TOKEN: 'TEST-registry-credential',
    },
  },
  providerId: 'anthropic',
  model: 'TEST-model',
  effort: 'high',
  workingDirectory: process.cwd(),
  instructions: 'TEST',
};
const identity = {
  providerId: 'anthropic',
  resolvedLaunchModel: 'TEST-resolved-model',
  resolvedEffort: 'high',
} as ProviderModelLaunchIdentity;

function setup() {
  const prepareWorkspaceTrust = vi.fn(async () => [] as string[]);
  const environment = vi.fn(
    async (): Promise<ProvisioningEnvResolution> => ({
      env: { TEST_AUTH: 'TEST-key' },
      authSource: 'none' as const,
      geminiRuntimeAuth: null,
      providerArgs: [],
    })
  );
  const resolveIdentity = vi.fn<NativeConfiguredProviderPorts['resolveIdentity']>(
    async () => identity
  );
  const runtimeArgs = vi.fn<NativeConfiguredProviderPorts['runtimeArgs']>(async (input) => ({
    providerArgs: ['--provider', 'anthropic', ...(input.envResolution.providerArgs ?? [])],
    fastModeArgs: [],
    runtimeTurnSettledHookArgs: [],
    settingsArgs: [],
    extraArgs: [],
    inheritedProviderArgs: [],
    appManagedSettingsPath: null,
  }));
  const provider = new NativeConfiguredProvider({
    executable: async () => 'TEST-claude.exe',
    environment,
    resolveIdentity,
    runtimeArgs,
    prepareWorkspaceTrust,
  });
  return { provider, environment, resolveIdentity, runtimeArgs, prepareWorkspaceTrust };
}

describe('native configured provider launch selection', () => {
  it('uses the validated resolved model and effort rather than historical process or hardcoded model settings', async () => {
    const { provider, resolveIdentity, runtimeArgs } = setup();
    const launch = await provider.prepare(settings, new AbortController().signal);
    expect(launch.executable).toBe('TEST-claude.exe');
    expect(launch.args).toEqual([
      '--model',
      'TEST-resolved-model',
      '--effort',
      'high',
      '--provider',
      'anthropic',
    ]);
    expect(resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'anthropic',
        memberSpec: expect.objectContaining({
          name: 'builder',
          model: 'TEST-model',
          effort: 'high',
        }),
      })
    );
    expect(runtimeArgs).toHaveBeenCalledWith(expect.objectContaining({ launchIdentity: identity }));
    expect(launch.env.TEST_AUTH).toBe('TEST-key');
    expect(process.env.TEST_AUTH).toBeUndefined();
    await launch.dispose?.();
  });

  it('parses canonical extra arguments through the existing settings materializer', async () => {
    const { provider, runtimeArgs } = setup();
    const launch = await provider.prepare(
      {
        ...settings,
        extraCliArgs: '--max-turns 12 --append-system-prompt "TEST configured prompt"',
      },
      new AbortController().signal
    );
    expect(runtimeArgs).toHaveBeenCalledWith(
      expect.objectContaining({
        extraArgs: ['--max-turns', '12', '--append-system-prompt', 'TEST configured prompt'],
      })
    );
    await launch.dispose?.();
  });

  it('prepares configured Gemini through the native runtime with its own authentication, model and provider arguments', async () => {
    const { provider, environment, resolveIdentity, runtimeArgs } = setup();
    environment.mockResolvedValueOnce({
      env: { TEST_GEMINI_AUTH: 'TEST-key' },
      authSource: 'gemini_runtime',
      geminiRuntimeAuth: {
        authenticated: true,
        authMethod: 'TEST',
        resolvedBackend: 'api',
        projectId: null,
        statusMessage: null,
      },
      providerArgs: ['--provider', 'gemini'],
    });
    resolveIdentity.mockResolvedValueOnce({
      ...identity,
      providerId: 'gemini',
      resolvedLaunchModel: 'TEST-gemini-model',
    });
    runtimeArgs.mockResolvedValueOnce({
      providerArgs: ['--provider', 'gemini'],
      fastModeArgs: [],
      runtimeTurnSettledHookArgs: [],
      settingsArgs: [],
      extraArgs: [],
      inheritedProviderArgs: [],
      appManagedSettingsPath: null,
    });
    const launch = await provider.prepare(
      { ...settings, providerId: 'gemini', model: 'TEST-gemini-model' },
      new AbortController().signal
    );
    expect(environment).toHaveBeenCalledWith('gemini', undefined, expect.any(Object));
    expect(launch.args).toEqual([
      '--model',
      'TEST-gemini-model',
      '--effort',
      'high',
      '--provider',
      'gemini',
    ]);
    expect(launch.env.TEST_GEMINI_AUTH).toBe('TEST-key');
    expect(launch.env.TEST_AUTH).toBeUndefined();
    await launch.dispose?.();
  });

  it('prepares trust for the resolved directory before provider probes and carries its arguments through launch materialization', async () => {
    const { provider, prepareWorkspaceTrust, resolveIdentity, runtimeArgs } = setup();
    const args = ['--settings', JSON.stringify({ codex: { TEST_workspace: 'TEST-resolved' } })];
    prepareWorkspaceTrust.mockResolvedValueOnce(args);
    const configured = { ...settings, workingDirectory: 'TEST-resolved-workspace' };
    const signal = new AbortController().signal;
    const launch = await provider.prepare(configured, signal);
    expect(prepareWorkspaceTrust).toHaveBeenCalledWith(configured, signal);
    expect(prepareWorkspaceTrust.mock.invocationCallOrder[0]).toBeLessThan(
      resolveIdentity.mock.invocationCallOrder[0]
    );
    expect(resolveIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: configured.workingDirectory,
        provisioningEnv: expect.objectContaining({ providerArgs: args }),
      })
    );
    expect(runtimeArgs).toHaveBeenCalledWith(
      expect.objectContaining({ envResolution: expect.objectContaining({ providerArgs: args }) })
    );
    expect(launch.args).toEqual(expect.arrayContaining(args));
    await launch.dispose?.();
  });

  it('does not let a parent Git environment redirect provider probes or the model child', async () => {
    const { provider, environment, resolveIdentity } = setup();
    environment.mockResolvedValueOnce({
      env: { TEST_AUTH: 'TEST-key', GIT_DIR: 'TEST-parent', GIT_INDEX_FILE: 'TEST-parent-index' },
      authSource: 'none',
      geminiRuntimeAuth: null,
      providerArgs: [],
    });
    const launch = await provider.prepare(settings, new AbortController().signal);
    const probe = resolveIdentity.mock.calls[0][0];
    expect(probe.provisioningEnv.env.GIT_DIR).toBeUndefined();
    expect(probe.provisioningEnv.env.GIT_INDEX_FILE).toBeUndefined();
    expect(launch.env.GIT_DIR).toBeUndefined();
    expect(launch.env.TEST_AUTH).toBe('TEST-key');
    await launch.dispose?.();
  });

  it('does not allocate authentication or probe a model after trust refusal', async () => {
    const { provider, prepareWorkspaceTrust, environment, resolveIdentity, runtimeArgs } = setup();
    prepareWorkspaceTrust.mockRejectedValueOnce(new Error('TEST workspace trust refused'));
    await expect(provider.prepare(settings, new AbortController().signal)).rejects.toThrow(
      'TEST workspace trust refused'
    );
    expect(environment).not.toHaveBeenCalled();
    expect(resolveIdentity).not.toHaveBeenCalled();
    expect(runtimeArgs).not.toHaveBeenCalled();
  });

  it('awaits trust preparation at cancellation without continuing into authentication', async () => {
    const { provider, prepareWorkspaceTrust, environment } = setup();
    let finish!: () => void;
    prepareWorkspaceTrust.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          finish = () => resolve([]);
        })
    );
    const abort = new AbortController();
    const preparing = provider.prepare(settings, abort.signal);
    const rejected = expect(preparing).rejects.toThrow('TEST cancel trust');
    await expect.poll(() => prepareWorkspaceTrust.mock.calls.length).toBe(1);
    abort.abort(new Error('TEST cancel trust'));
    expect(environment).not.toHaveBeenCalled();
    finish();
    await rejected;
    expect(environment).not.toHaveBeenCalled();
  });

  it('does not silently default an absent provider or cross the native runtime boundary', async () => {
    const { provider, environment } = setup();
    for (const providerId of ['', 'opencode', 'invented']) {
      await expect(
        provider.prepare({ ...settings, providerId }, new AbortController().signal)
      ).rejects.toThrow('native');
    }
    expect(environment).not.toHaveBeenCalled();
  });

  it('stops preparation at cancellation and at configured authentication errors before resolving launch selection', async () => {
    const { provider, environment, resolveIdentity } = setup();
    const abort = new AbortController();
    abort.abort();
    await expect(provider.prepare(settings, abort.signal)).rejects.toThrow();
    expect(environment).not.toHaveBeenCalled();
    environment.mockResolvedValueOnce({
      env: {},
      authSource: 'none',
      geminiRuntimeAuth: null,
      providerArgs: [],
      warning: 'TEST authentication unavailable',
    } as Awaited<ReturnType<typeof environment>>);
    await expect(provider.prepare(settings, new AbortController().signal)).rejects.toThrow(
      'TEST authentication unavailable'
    );
    expect(resolveIdentity).not.toHaveBeenCalled();
  });
});
