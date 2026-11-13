import { RegistryTaskClientConfigError } from './RegistryTaskClientErrors';
import {
  createElectronCredentialCipher,
  SpecRegistryCredentialStore,
} from './SpecRegistryCredentialStore';

/** MCP child environment keys; the app resolves credentials only from its store. */
export const SPEC_REGISTRY_URL_ENV = 'OMP_SPEC_REGISTRY_URL';
export const SPEC_REGISTRY_TOKEN_ENV = 'OMP_SPEC_REGISTRY_TOKEN';
export const SPEC_REGISTRY_SERVER_NAME = 'omp-spec-kit';
export const DEFAULT_SPEC_REGISTRY_URL = 'http://127.0.0.1:8650/mcp';
export const DEFAULT_SPEC_REGISTRY_REQUEST_TIMEOUT_MS = 20_000;

export interface ResolveRegistryTaskClientConfigInput {
  /** Injected store, otherwise the app's encrypted credential store. */
  credentialStore?: { read(): Promise<{ url: string; token: string } | null> };
  /** Explicit client configuration for dependency-injected callers. */
  url?: string;
  token?: string | null;
  requestTimeoutMs?: number;
}

export interface ResolvedRegistryTaskClientConfig {
  url: string;
  token: string;
  requestTimeoutMs: number;
}

/** Never reads inherited environment variables or legacy credential files. */
export async function resolveRegistryTaskClientConfig(
  input: ResolveRegistryTaskClientConfigInput = {}
): Promise<ResolvedRegistryTaskClientConfig> {
  const requestTimeoutMs = resolveTimeout(input.requestTimeoutMs);
  if (input.token !== undefined) {
    const token = input.token?.trim();
    if (!token) throw missingTokenError();
    return { url: resolveUrl(input.url), token, requestTimeoutMs };
  }

  const store =
    input.credentialStore ??
    (cachedCredentialStore ??= new SpecRegistryCredentialStore(createElectronCredentialCipher()));
  let credential: { url: string; token: string } | null;
  try {
    credential = await store.read();
  } catch (error) {
    throw new RegistryTaskClientConfigError({
      code: 'CREDENTIAL_STORE_UNREADABLE',
      message: 'stored spec registry credential is unreadable',
      cause: error,
    });
  }
  if (!credential?.token.trim()) throw missingTokenError();
  return {
    url: resolveUrl(credential.url),
    token: credential.token.trim(),
    requestTimeoutMs,
  };
}

let cachedCredentialStore: SpecRegistryCredentialStore | undefined;

function resolveUrl(rawUrl: string | undefined): string {
  const candidate = rawUrl?.trim() || DEFAULT_SPEC_REGISTRY_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    throw new RegistryTaskClientConfigError({
      code: 'INVALID_URL',
      message: 'spec registry endpoint is not a valid URL',
      cause: error,
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RegistryTaskClientConfigError({
      code: 'INVALID_URL',
      message: 'spec registry endpoint must use http or https',
    });
  }
  return candidate;
}

function resolveTimeout(rawTimeout: number | undefined): number {
  if (rawTimeout === undefined) return DEFAULT_SPEC_REGISTRY_REQUEST_TIMEOUT_MS;
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    throw new RegistryTaskClientConfigError({
      code: 'INVALID_ARGUMENT',
      message: 'spec registry requestTimeoutMs must be a positive finite number',
      details: { requestTimeoutMs: rawTimeout },
    });
  }
  return Math.floor(rawTimeout);
}

function missingTokenError(): RegistryTaskClientConfigError {
  return new RegistryTaskClientConfigError({
    code: 'MISSING_TOKEN',
    message: 'Connect Spec Kit in the app to configure your registry endpoint and credential',
  });
}
