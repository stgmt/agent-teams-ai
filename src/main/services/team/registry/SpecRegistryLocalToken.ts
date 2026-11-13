import { specRegistryLocalTokenUrl } from '@shared/utils/specRegistryEndpoint';

import type { SpecRegistryLocalTokenResult } from '@shared/types';

const LOCAL_TOKEN_TIMEOUT_MS = 5_000;

/**
 * Ask a registry running on this machine for an agent token.
 *
 * The dialog offers this only for a loopback endpoint, and the guard is
 * repeated here: a configured remote endpoint must never be posted to, not even
 * by a compromised renderer. Redirects are refused so the credential cannot be
 * handed to another origin, and the token is returned to the caller only — it
 * is not stored, logged or audited here.
 */
export async function requestLocalSpecRegistryToken(input: {
  url: string;
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
}): Promise<SpecRegistryLocalTokenResult> {
  const endpoint = specRegistryLocalTokenUrl(input.url);
  if (endpoint === null) return { ok: false, code: 'LOCAL_BOOTSTRAP_NOT_LOOPBACK' };
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(input.timeoutMs ?? LOCAL_TOKEN_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: 'LOCAL_BOOTSTRAP_UNREACHABLE' };
  }
  const body = (await response.json().catch(() => null)) as {
    token?: unknown;
    error?: unknown;
  } | null;
  if (response.ok) {
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    return token.length > 0 ? { ok: true, token } : { ok: false, code: 'LOCAL_BOOTSTRAP_FAILED' };
  }
  // 403 and 409 are the two answers the user can act on: the endpoint is not
  // loopback, or the registry's operator has not enabled the bootstrap.
  if (response.status === 403) return { ok: false, code: 'LOCAL_BOOTSTRAP_FORBIDDEN' };
  if (response.status === 409) return { ok: false, code: 'LOCAL_BOOTSTRAP_DISABLED' };
  return {
    ok: false,
    code:
      typeof body?.error === 'string' && body.error.length > 0
        ? body.error
        : 'LOCAL_BOOTSTRAP_FAILED',
  };
}
