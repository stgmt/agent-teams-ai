import { RegistryMcpTransport } from './RegistryMcpTransport';
import {
  SpecRegistryCredentialStore,
  createElectronCredentialCipher,
} from './SpecRegistryCredentialStore';
import {
  getRegistryTokenFilePath,
  resolveRegistryTaskClientConfig,
} from './RegistryTaskClientConfig';

import type { SpecRegistryCredential } from './SpecRegistryCredentialStore';
import type { SpecRegistryCredentialStatus, SpecRegistryProbeResult } from '@shared/types';

const PROBE_TIMEOUT_MS = 10_000;

function store(): SpecRegistryCredentialStore {
  return new SpecRegistryCredentialStore(createElectronCredentialCipher());
}

/** Never returns the token; the renderer only learns whether one exists. */
export async function readSpecRegistryCredentialStatus(): Promise<SpecRegistryCredentialStatus> {
  const credentialStore = store();
  const stored = await credentialStore.read();
  if (stored) return { configured: true, url: stored.url, source: 'store' };
  try {
    const resolved = await resolveRegistryTaskClientConfig({ credentialStore });
    const source = process.env.OMP_SPEC_REGISTRY_TOKEN?.trim()
      ? 'environment'
      : getRegistryTokenFilePath()
        ? 'file'
        : 'none';
    return { configured: true, url: resolved.url, source };
  } catch {
    return { configured: false, url: null, source: 'none' };
  }
}

async function probe(url: string, token: string): Promise<SpecRegistryProbeResult> {
  try {
    const transport = new RegistryMcpTransport({ url, token, requestTimeoutMs: PROBE_TIMEOUT_MS });
    const result = await transport.listTools();
    const tools = Array.isArray(result.tools) ? result.tools : [];
    return { ok: true, url, toolCount: tools.length, errorCode: null };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return {
      ok: false,
      url,
      toolCount: null,
      errorCode: typeof code === 'string' ? code : 'UNREACHABLE',
    };
  }
}

/** Validates a candidate credential without storing it. */
export async function testSpecRegistryCredential(input: {
  url?: string;
  token?: string;
}): Promise<SpecRegistryProbeResult> {
  const url = input.url?.trim();
  const token = input.token?.trim();
  if (url && token) return probe(url, token);
  const resolved = await resolveRegistryTaskClientConfig();
  return probe(resolved.url, resolved.token);
}

/**
 * Stores the credential the launch will use. The probe runs first, so an
 * unusable endpoint or token is refused instead of being saved.
 */
export async function saveSpecRegistryCredential(input: {
  url: string;
  token: string;
}): Promise<SpecRegistryProbeResult> {
  const url = input.url.trim();
  const token = input.token.trim();
  const result = await probe(url, token);
  if (!result.ok) return result;
  await store().save({ url, token });
  return result;
}

export async function clearSpecRegistryCredential(): Promise<void> {
  await store().clear();
}

export type { SpecRegistryCredential };
