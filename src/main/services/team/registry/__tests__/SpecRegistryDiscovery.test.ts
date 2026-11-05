// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { discoverSpecRegistry } from '../SpecRegistryDiscovery';

function registryResponse(data: unknown): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [{ type: 'text', text: JSON.stringify({ ok: true, data }) }],
      },
    }),
    { status: 200 }
  );
}

describe('specification registry discovery', () => {
  it('returns only real project/spec choices and never exposes URL credentials', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      registryResponse({
        projects: [
          {
            id: 'owner/app',
            specs: [{ slug: 'first', owner: 'private metadata' }, { slug: 'second' }],
          },
          { id: 'owner/empty', specs: [] },
        ],
      })
    );

    const result = await discoverSpecRegistry({
      url: 'https://user:password@registry.example/mcp?token=private#fragment',
      token: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(result).toEqual({
      url: 'https://registry.example/mcp',
      projects: [
        { id: 'owner/app', specs: [{ slug: 'first' }, { slug: 'second' }] },
        { id: 'owner/empty', specs: [] },
      ],
    });
    const request = fetchImpl.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body)).params.name).toBe('spec_registry');
    expect(request.headers).toMatchObject({ Authorization: 'Bearer test-token' });
  });

  it('keeps reachable projects usable when another project cannot be read', async () => {
    const fetchImpl = vi.fn(async () =>
      registryResponse({
        projects: [
          { id: 'owner/available', specs: [{ slug: 'requirements' }] },
          { id: 'owner/unavailable', error: 'REPO_BINDING_REQUIRED' },
        ],
      })
    );
    const result = await discoverSpecRegistry({
      url: 'http://localhost/mcp',
      token: 'test-token',
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(result.projects).toEqual([
      { id: 'owner/available', specs: [{ slug: 'requirements' }] },
      { id: 'owner/unavailable', specs: [], unavailable: true },
    ]);
    expect(JSON.stringify(result)).not.toContain('REPO_BINDING_REQUIRED');
  });

  it('reports authentication failure instead of inventing project choices', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    await expect(
      discoverSpecRegistry({
        url: 'http://localhost/mcp',
        token: 'test-token',
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toThrow('UNAUTHORIZED');
  });

  it('rejects malformed registry choices', async () => {
    const fetchImpl = vi.fn(async () =>
      registryResponse({ projects: [{ id: 'owner/app', specs: [null] }] })
    );
    await expect(
      discoverSpecRegistry({
        url: 'http://localhost/mcp',
        token: 'test-token',
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).rejects.toThrow('INVALID_RESPONSE');
  });
});
