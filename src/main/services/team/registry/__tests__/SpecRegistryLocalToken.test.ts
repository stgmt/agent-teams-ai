/* eslint-disable sonarjs/no-clear-text-protocols -- the loopback plain-http shape IS the subject of these cases */
import { specRegistryLocalTokenUrl } from '@shared/utils/specRegistryEndpoint';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { requestLocalSpecRegistryToken } from '../SpecRegistryLocalToken';

const LOCAL_ENDPOINT = 'http://127.0.0.1:8643/mcp';

function reply(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { calls, fetchImpl: fetchImpl as unknown as typeof globalThis.fetch };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loopback endpoint resolution', () => {
  it('drops /mcp and any trailing slash to reach the bootstrap beside it', () => {
    expect(specRegistryLocalTokenUrl('http://127.0.0.1:8643/mcp')).toBe(
      'http://127.0.0.1:8643/local/token'
    );
    expect(specRegistryLocalTokenUrl('http://localhost:8643/mcp/')).toBe(
      'http://localhost:8643/local/token'
    );
    expect(specRegistryLocalTokenUrl('http://[::1]:8643/mcp')).toBe(
      'http://[::1]:8643/local/token'
    );
    expect(specRegistryLocalTokenUrl('http://127.0.0.1:8643')).toBe(
      'http://127.0.0.1:8643/local/token'
    );
  });

  it('refuses any endpoint that is not on this machine', () => {
    for (const url of [
      'https://registry.example.com/mcp',
      'http://10.0.0.5:8643/mcp',
      'http://registry.internal/mcp',
      'not a url',
      '',
    ]) {
      expect(specRegistryLocalTokenUrl(url)).toBeNull();
    }
  });
});

describe('requestLocalSpecRegistryToken', () => {
  it('returns the minted token and never redirects', async () => {
    const { calls, fetchImpl } = reply(200, { token: '  unit-local-token  ', login: 'alice' });
    await expect(
      requestLocalSpecRegistryToken({ url: LOCAL_ENDPOINT, fetchImpl })
    ).resolves.toEqual({ ok: true, token: 'unit-local-token' });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('http://127.0.0.1:8643/local/token');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.redirect).toBe('error');
  });

  it('refuses a remote endpoint without making a request', async () => {
    const { calls, fetchImpl } = reply(200, { token: 'never-used' });
    await expect(
      requestLocalSpecRegistryToken({ url: 'https://registry.example.com/mcp', fetchImpl })
    ).resolves.toEqual({ ok: false, code: 'LOCAL_BOOTSTRAP_NOT_LOOPBACK' });
    expect(calls).toHaveLength(0);
  });

  it.each([
    [403, { error: 'LOCAL_BOOTSTRAP_FORBIDDEN' }, 'LOCAL_BOOTSTRAP_FORBIDDEN'],
    [409, { error: 'LOCAL_BOOTSTRAP_DISABLED' }, 'LOCAL_BOOTSTRAP_DISABLED'],
    [500, { error: 'UPSTREAM_ERROR' }, 'UPSTREAM_ERROR'],
    [500, {}, 'LOCAL_BOOTSTRAP_FAILED'],
  ])('maps HTTP %s to the refusal the dialog explains', async (status, body, code) => {
    const { fetchImpl } = reply(status, body);
    await expect(
      requestLocalSpecRegistryToken({ url: LOCAL_ENDPOINT, fetchImpl })
    ).resolves.toEqual({
      ok: false,
      code,
    });
  });

  it('reports an unreachable registry and an empty token as failures', async () => {
    const unreachable = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(
      requestLocalSpecRegistryToken({
        url: LOCAL_ENDPOINT,
        fetchImpl: unreachable as unknown as typeof globalThis.fetch,
      })
    ).resolves.toEqual({ ok: false, code: 'LOCAL_BOOTSTRAP_UNREACHABLE' });

    const empty = reply(200, { token: '   ' });
    await expect(
      requestLocalSpecRegistryToken({ url: LOCAL_ENDPOINT, fetchImpl: empty.fetchImpl })
    ).resolves.toEqual({ ok: false, code: 'LOCAL_BOOTSTRAP_FAILED' });
  });
});

/* eslint-enable sonarjs/no-clear-text-protocols */
