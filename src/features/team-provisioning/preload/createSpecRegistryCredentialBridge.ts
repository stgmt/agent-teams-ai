import {
  SPEC_REGISTRY_CLEAR,
  SPEC_REGISTRY_GET_STATUS,
  SPEC_REGISTRY_LOCAL_TOKEN,
  SPEC_REGISTRY_SAVE,
  SPEC_REGISTRY_TEST,
} from '@preload/constants/ipcChannels';

import type { InvokeIpcWithResult } from './createTeamMemberSettingsBridge';
import type {
  SpecRegistryCredentialStatus,
  SpecRegistryLocalTokenResult,
  SpecRegistryProbeResult,
} from '@shared/types';

export interface SpecRegistryCredentialBridge {
  getSpecRegistryCredentialStatus(): Promise<SpecRegistryCredentialStatus>;
  saveSpecRegistryCredential(url: string, token: string): Promise<SpecRegistryProbeResult>;
  clearSpecRegistryCredential(): Promise<void>;
  testSpecRegistryCredential(url?: string, token?: string): Promise<SpecRegistryProbeResult>;
  requestSpecRegistryLocalToken(url: string): Promise<SpecRegistryLocalTokenResult>;
}

export function createSpecRegistryCredentialBridge(
  invoke: InvokeIpcWithResult
): SpecRegistryCredentialBridge {
  return {
    getSpecRegistryCredentialStatus: () =>
      invoke<SpecRegistryCredentialStatus>(SPEC_REGISTRY_GET_STATUS),
    saveSpecRegistryCredential: (url, token) =>
      invoke<SpecRegistryProbeResult>(SPEC_REGISTRY_SAVE, url, token),
    clearSpecRegistryCredential: () => invoke<void>(SPEC_REGISTRY_CLEAR),
    testSpecRegistryCredential: (url, token) =>
      invoke<SpecRegistryProbeResult>(SPEC_REGISTRY_TEST, url, token),
    requestSpecRegistryLocalToken: (url) =>
      invoke<SpecRegistryLocalTokenResult>(SPEC_REGISTRY_LOCAL_TOKEN, url),
  };
}
