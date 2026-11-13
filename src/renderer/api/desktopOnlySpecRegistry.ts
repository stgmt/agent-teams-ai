import type {
  SpecRegistryCredentialStatus,
  SpecRegistryDiscovery,
  SpecRegistryLocalTokenResult,
  SpecRegistryProbeResult,
  TeamSpecBinding,
} from '@shared/types';

const REGISTRY_DISCOVERY_ONLY =
  'Specification registry discovery is only available in the desktop app';
const REGISTRY_ONBOARDING_ONLY =
  'Specification registry onboarding is only available in the desktop app';
const SPEC_BINDINGS_ONLY = 'Specification bindings are only available in the desktop app';

export interface DesktopOnlySpecRegistryApi {
  discoverSpecRegistry: () => Promise<SpecRegistryDiscovery>;
  getSpecRegistryCredentialStatus(): Promise<SpecRegistryCredentialStatus>;
  saveSpecRegistryCredential(url: string, token: string): Promise<SpecRegistryProbeResult>;
  clearSpecRegistryCredential(): Promise<void>;
  testSpecRegistryCredential(url?: string, token?: string): Promise<SpecRegistryProbeResult>;
  requestSpecRegistryLocalToken(url: string): Promise<SpecRegistryLocalTokenResult>;
  listTeamSpecBindings: (teamName: string) => Promise<TeamSpecBinding[]>;
  linkTeamSpec: (teamName: string, binding: TeamSpecBinding) => Promise<TeamSpecBinding[]>;
  unlinkTeamSpec: (teamName: string, binding: TeamSpecBinding) => Promise<TeamSpecBinding[]>;
}

/** Browser mode has no spec registry transport: every call fails instead of silently succeeding. */
export function createDesktopOnlySpecRegistryApi(): DesktopOnlySpecRegistryApi {
  return {
    discoverSpecRegistry: () => Promise.reject(new Error(REGISTRY_DISCOVERY_ONLY)),
    getSpecRegistryCredentialStatus: () => Promise.reject(new Error(REGISTRY_ONBOARDING_ONLY)),
    saveSpecRegistryCredential: () => Promise.reject(new Error(REGISTRY_ONBOARDING_ONLY)),
    clearSpecRegistryCredential: () => Promise.reject(new Error(REGISTRY_ONBOARDING_ONLY)),
    testSpecRegistryCredential: () => Promise.reject(new Error(REGISTRY_ONBOARDING_ONLY)),
    requestSpecRegistryLocalToken: () => Promise.reject(new Error(REGISTRY_ONBOARDING_ONLY)),
    listTeamSpecBindings: () => Promise.reject(new Error(SPEC_BINDINGS_ONLY)),
    linkTeamSpec: () => Promise.reject(new Error(SPEC_BINDINGS_ONLY)),
    unlinkTeamSpec: () => Promise.reject(new Error(SPEC_BINDINGS_ONLY)),
  };
}
