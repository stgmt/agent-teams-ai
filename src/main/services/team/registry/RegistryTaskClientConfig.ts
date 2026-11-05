import { getHomeDir } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { RegistryTaskClientConfigError } from './RegistryTaskClientErrors';

/**
 * Configuration of the spec registry HTTP MCP endpoint.
 *
 * The bearer token is deliberately confined to this module and the transport:
 * it is never logged, never part of an error message, and never returned to
 * the renderer. Missing configuration is a typed failure, not an invitation
 * to fall back to a local task store.
 */
export const SPEC_REGISTRY_URL_ENV = 'OMP_SPEC_REGISTRY_URL';
export const SPEC_REGISTRY_TOKEN_ENV = 'OMP_SPEC_REGISTRY_TOKEN';
export const SPEC_REGISTRY_TOKEN_FILE_ENV = 'OMP_SPEC_REGISTRY_TOKEN_FILE';
export const DEFAULT_SPEC_REGISTRY_URL = 'http://127.0.0.1:8650/mcp';
export const SPEC_REGISTRY_TOKEN_FILE_SEGMENTS = ['.spec-registry', 'mcp-token.txt'] as const;
export const DEFAULT_SPEC_REGISTRY_REQUEST_TIMEOUT_MS = 20_000;

export interface ResolveRegistryTaskClientConfigInput {
  /** Endpoint override; otherwise `OMP_SPEC_REGISTRY_URL`, then the local default. */
  url?: string;
  /**
   * Token override. `undefined` falls through to the env/file chain; an
   * explicit `null` or blank string means "there is no token" and fails.
   */
  token?: string | null;
  /** Override for tests; otherwise `OMP_SPEC_REGISTRY_TOKEN_FILE`, then the default home path. */
  tokenFilePath?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
}

export interface ResolvedRegistryTaskClientConfig {
  url: string;
  token: string;
  requestTimeoutMs: number;
}

/** Location of the bearer token written by `omp-spec-kit` setup. */
export function getRegistryTokenFilePath(): string {
  return path.join(getHomeDir(), ...SPEC_REGISTRY_TOKEN_FILE_SEGMENTS);
}

export async function resolveRegistryTaskClientConfig(
  input: ResolveRegistryTaskClientConfigInput = {}
): Promise<ResolvedRegistryTaskClientConfig> {
  const env = input.env ?? process.env;
  const url = resolveUrl(input.url ?? env[SPEC_REGISTRY_URL_ENV]);
  const requestTimeoutMs = resolveTimeout(input.requestTimeoutMs);
  const token = await resolveToken(input, env);

  return { url, token, requestTimeoutMs };
}

function resolveUrl(rawUrl: string | undefined): string {
  const candidate = rawUrl?.trim() || DEFAULT_SPEC_REGISTRY_URL;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (error) {
    throw new RegistryTaskClientConfigError({
      code: 'INVALID_URL',
      message: `spec registry url is not a valid URL: ${candidate}`,
      cause: error,
      details: { url: candidate },
    });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RegistryTaskClientConfigError({
      code: 'INVALID_URL',
      message: `spec registry url must use http or https, got ${parsed.protocol}`,
      details: { url: candidate },
    });
  }
  return candidate;
}

function resolveTimeout(rawTimeout: number | undefined): number {
  if (rawTimeout === undefined) {
    return DEFAULT_SPEC_REGISTRY_REQUEST_TIMEOUT_MS;
  }
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    throw new RegistryTaskClientConfigError({
      code: 'INVALID_ARGUMENT',
      message: 'spec registry requestTimeoutMs must be a positive finite number',
      details: { requestTimeoutMs: rawTimeout },
    });
  }
  return Math.floor(rawTimeout);
}

async function resolveToken(
  input: ResolveRegistryTaskClientConfigInput,
  env: NodeJS.ProcessEnv
): Promise<string> {
  if (input.token !== undefined) {
    const explicit = input.token?.trim();
    if (explicit) {
      return explicit;
    }
    throw missingTokenError();
  }

  // The on-disk token is the maintained source (setup rewrites it); an inherited
  // env value can be stale and silently point at an expired credential.
  const tokenFilePath =
    input.tokenFilePath ??
    (env[SPEC_REGISTRY_TOKEN_FILE_ENV]?.trim() || getRegistryTokenFilePath());
  let fileToken: string | null = null;
  try {
    fileToken = (await fs.promises.readFile(tokenFilePath, 'utf8')).trim();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw new RegistryTaskClientConfigError({
        code: 'TOKEN_READ_FAILED',
        message: `spec registry token file could not be read (${code ?? 'unknown error'})`,
        cause: error,
        details: { tokenFilePath },
      });
    }
  }

  if (fileToken) {
    return fileToken;
  }

  const envToken = env[SPEC_REGISTRY_TOKEN_ENV]?.trim();
  if (envToken) {
    return envToken;
  }

  throw missingTokenError();
}

function missingTokenError(): RegistryTaskClientConfigError {
  return new RegistryTaskClientConfigError({
    code: 'MISSING_TOKEN',
    message:
      'spec registry bearer token is not configured: set OMP_SPEC_REGISTRY_TOKEN or write ~/.spec-registry/mcp-token.txt',
  });
}
