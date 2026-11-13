import {
  clearSpecRegistryCredential,
  readSpecRegistryCredentialStatus,
  saveSpecRegistryCredential,
  testSpecRegistryCredential,
} from '@main/services/team/registry/SpecRegistryCredentialOnboarding';
import { requestLocalSpecRegistryToken } from '@main/services/team/registry/SpecRegistryLocalToken';
import { SPEC_REGISTRY_NOT_CONFIGURED_CODE } from '@shared/constants/specRegistry';
import { type IpcMainInvokeEvent } from 'electron';

import { validateTeamName } from '../guards';

import type { TeamDataService } from '@main/services';
import type {
  SpecRegistryCredentialStatus,
  SpecRegistryLocalTokenResult,
  SpecRegistryProbeResult,
} from '@shared/types';
import type {
  IpcResult,
  SpecRegistryDiscovery,
  TeamSpecBinding,
  TeamSpecScope,
} from '@shared/types';

export interface TeamRegistryIntegrationDependencies {
  getTeamDataService(): Pick<
    TeamDataService,
    'discoverSpecRegistry' | 'listTeamSpecBindings' | 'linkTeamSpec' | 'unlinkTeamSpec'
  >;
  validateTeamSpecBindingInput(
    value: unknown,
    teamName: string
  ): { valid: true; value: TeamSpecBinding } | { valid: false; error: string };
  wrapTeamHandler<T>(operation: string, handler: () => Promise<T>): Promise<IpcResult<T>>;
}

/** Credentials, discovery and launch admission all use the persisted registry authority. */
export function createTeamRegistryIntegrationHandlers(deps: TeamRegistryIntegrationDependencies) {
  const { getTeamDataService, validateTeamSpecBindingInput, wrapTeamHandler } = deps;
  async function handleDiscoverSpecRegistry(
    _event: IpcMainInvokeEvent
  ): Promise<IpcResult<SpecRegistryDiscovery>> {
    return wrapTeamHandler('discoverSpecRegistry', () =>
      getTeamDataService().discoverSpecRegistry()
    );
  }

  async function handleSpecRegistryGetStatus(
    _event: IpcMainInvokeEvent
  ): Promise<IpcResult<SpecRegistryCredentialStatus>> {
    return wrapTeamHandler('specRegistryGetStatus', () => readSpecRegistryCredentialStatus());
  }

  async function handleSpecRegistrySave(
    _event: IpcMainInvokeEvent,
    url: unknown,
    token: unknown
  ): Promise<IpcResult<SpecRegistryProbeResult>> {
    if (typeof url !== 'string' || !url.trim()) {
      return { success: false, error: 'Registry endpoint is required' };
    }
    if (typeof token !== 'string' || !token.trim()) {
      return { success: false, error: 'Registry token is required' };
    }
    return wrapTeamHandler('specRegistrySave', () => saveSpecRegistryCredential({ url, token }));
  }

  async function handleSpecRegistryClear(_event: IpcMainInvokeEvent): Promise<IpcResult<void>> {
    return wrapTeamHandler('specRegistryClear', () => clearSpecRegistryCredential());
  }

  async function handleSpecRegistryTest(
    _event: IpcMainInvokeEvent,
    url: unknown,
    token: unknown
  ): Promise<IpcResult<SpecRegistryProbeResult>> {
    const candidate = {
      ...(typeof url === 'string' && url.trim() ? { url } : {}),
      ...(typeof token === 'string' && token.trim() ? { token } : {}),
    };
    return wrapTeamHandler('specRegistryTest', () => testSpecRegistryCredential(candidate));
  }

  /**
   * Loopback "Get token": mint this machine's registry credential so the user
   * does not have to paste one. The loopback guard rides the service call — a
   * remote endpoint is refused before any request leaves the app.
   */
  async function handleSpecRegistryLocalToken(
    _event: IpcMainInvokeEvent,
    url: unknown
  ): Promise<IpcResult<SpecRegistryLocalTokenResult>> {
    if (typeof url !== 'string' || !url.trim()) {
      return { success: false, error: 'Registry endpoint is required' };
    }
    return wrapTeamHandler('specRegistryLocalToken', () => requestLocalSpecRegistryToken({ url }));
  }

  async function handleListTeamSpecBindings(
    _event: IpcMainInvokeEvent,
    teamName: unknown
  ): Promise<IpcResult<TeamSpecBinding[]>> {
    const validated = validateTeamName(teamName);
    if (!validated.valid) {
      return { success: false, error: validated.error ?? 'Invalid teamName' };
    }
    return wrapTeamHandler('listTeamSpecBindings', () =>
      getTeamDataService().listTeamSpecBindings(validated.value!)
    );
  }

  async function handleLinkTeamSpec(
    _event: IpcMainInvokeEvent,
    teamName: unknown,
    rawBinding: unknown
  ): Promise<IpcResult<TeamSpecBinding[]>> {
    const validated = validateTeamName(teamName);
    if (!validated.valid) {
      return { success: false, error: validated.error ?? 'Invalid teamName' };
    }
    const binding = validateTeamSpecBindingInput(rawBinding, validated.value!);
    if (!binding.valid) return { success: false, error: binding.error };
    return wrapTeamHandler('linkTeamSpec', () =>
      getTeamDataService().linkTeamSpec(validated.value!, binding.value)
    );
  }

  async function handleUnlinkTeamSpec(
    _event: IpcMainInvokeEvent,
    teamName: unknown,
    rawBinding: unknown
  ): Promise<IpcResult<TeamSpecBinding[]>> {
    const validated = validateTeamName(teamName);
    if (!validated.valid) {
      return { success: false, error: validated.error ?? 'Invalid teamName' };
    }
    const binding = validateTeamSpecBindingInput(rawBinding, validated.value!);
    if (!binding.valid) return { success: false, error: binding.error };
    return wrapTeamHandler('unlinkTeamSpec', () =>
      getTeamDataService().unlinkTeamSpec(validated.value!, binding.value)
    );
  }
  /** Launch requires stored credentials, usable published tools and every permitted project. */
  async function assertSpecRegistryReadyForTeam(
    scope: TeamSpecScope | null | undefined
  ): Promise<string | null> {
    if (!scope?.projects.length) return 'SPEC_PROJECT_REQUIRED';
    try {
      const credential = await readSpecRegistryCredentialStatus();
      if (!credential.configured) return SPEC_REGISTRY_NOT_CONFIGURED_CODE;
      const probe = await testSpecRegistryCredential({});
      if (!probe.ok) return probe.errorCode ?? 'SPEC_REGISTRY_NOT_READY';
      const discovery = await getTeamDataService().discoverSpecRegistry();
      for (const project of scope.projects) {
        const entry = discovery.projects.find((candidate) => candidate.id === project);
        if (!entry) return 'PROJECT_NOT_ALLOWED';
        if (entry.unavailable) return 'REGISTRY_UNAVAILABLE';
      }
      return null;
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : null;
      return typeof code === 'string' ? code : 'SPEC_REGISTRY_PREFLIGHT_FAILED';
    }
  }
  return {
    handleDiscoverSpecRegistry,
    handleSpecRegistryGetStatus,
    handleSpecRegistrySave,
    handleSpecRegistryClear,
    handleSpecRegistryTest,
    handleSpecRegistryLocalToken,
    handleListTeamSpecBindings,
    handleLinkTeamSpec,
    handleUnlinkTeamSpec,
    assertSpecRegistryReadyForTeam,
  };
}
