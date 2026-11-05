import { describe, expect, it } from 'vitest';

import {
  getAvailableTeamProviderModelOptions,
  getTeamModelSelectionError,
  isTeamModelAvailableForUi,
} from '../teamModelAvailability';

import type { CliProviderStatus } from '@shared/types';

function createAnthropicProviderStatus(
  overrides: Partial<CliProviderStatus> = {}
): CliProviderStatus {
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: true,
    authMethod: 'api_key',
    verificationState: 'verified',
    models: ['claude-sonnet-5-5'],
    defaultModel: 'gpt-6.1-terra',
    modelCatalog: null,
    modelAvailability: [],
    runtimeCapabilities: null,
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        mcp: true,
        skills: true,
        hooks: true,
        plugins: true,
        subagents: true,
      },
    },
    connection: {
      compatibleEndpoint: { enabled: false, baseUrl: '', tokenConfigured: false },
    },
    ...overrides,
  } as CliProviderStatus;
}

describe('anthropic model availability with a local model router', () => {
  it('offers router-served models the first-party catalog does not list', () => {
    const status = createAnthropicProviderStatus({
      localRouterModelIds: ['gpt-6.1-sol', 'gpt-6.1-terra'],
    });

    expect(isTeamModelAvailableForUi('anthropic', 'gpt-6.1-terra', status)).toBe(true);
    expect(getTeamModelSelectionError('anthropic', 'gpt-6.1-terra', status)).toBeNull();
    expect(
      getAvailableTeamProviderModelOptions('anthropic', status, 'gpt-6.1-terra').map(
        (option) => option.value
      )
    ).toEqual(expect.arrayContaining(['gpt-6.1-sol', 'gpt-6.1-terra']));
  });

  it('still rejects the same model when no router is detected', () => {
    const status = createAnthropicProviderStatus();

    expect(isTeamModelAvailableForUi('anthropic', 'gpt-6.1-terra', status)).toBe(false);
    expect(getTeamModelSelectionError('anthropic', 'gpt-6.1-terra', status)).toBe(
      'Model "gpt-6.1-terra" is not available for the current Anthropic runtime. Pick one of the listed models or use Default.'
    );
  });
});
