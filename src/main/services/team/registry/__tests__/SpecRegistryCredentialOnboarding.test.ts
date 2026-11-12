// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ directory: '' }));
vi.mock('@main/utils/pathDecoder', () => ({
  getAppDataPath: () => fixture.directory,
  getHomeDir: () => fixture.directory,
}));
vi.mock('../SpecRegistryCredentialStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../SpecRegistryCredentialStore')>()),
  createElectronCredentialCipher: () => ({
    isAvailable: () => true,
    encrypt: (value: string) => Buffer.from(value, 'utf8'),
    decrypt: (value: Buffer) => value.toString('utf8'),
  }),
}));

const endpoint = 'https://registry.unit.invalid/mcp';
// Synthetic unit credential only; never an operator credential.
const credential = { url: endpoint, token: 'unit-onboarding-credential' };
const usableTools = [
  {
    name: 'spec_catalog',
    description: 'Discover projects and specifications',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

function replyWith(result: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as { id: number; method: string };
      if (request.method !== 'tools/list') throw new Error('Unexpected registry operation');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    })
  );
}

beforeEach(() => {
  fixture.directory = mkdtempSync(join(tmpdir(), 'registry-onboarding-'));
  vi.resetModules();
  vi.stubEnv('OMP_SPEC_REGISTRY_URL', 'https://inherited.unit.invalid/mcp');
  vi.stubEnv('OMP_SPEC_REGISTRY_TOKEN', 'unit-inherited-credential');
  vi.stubEnv('OMP_SPEC_REGISTRY_TOKEN_FILE', join(fixture.directory, 'absent-token.txt'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(fixture.directory, { recursive: true, force: true, maxRetries: 20 });
});

describe('app-owned registry credential onboarding', () => {
  it('requires user setup rather than reporting inherited environment as configured', async () => {
    const { readSpecRegistryCredentialStatus } =
      await import('../SpecRegistryCredentialOnboarding');
    await expect(readSpecRegistryCredentialStatus()).resolves.toEqual({
      configured: false,
      url: null,
      source: 'none',
    });
  });

  it('preserves the user endpoint and credential across a fresh app module and store instance', async () => {
    replyWith({ tools: usableTools });
    const firstApp = await import('../SpecRegistryCredentialOnboarding');
    expect((await firstApp.saveSpecRegistryCredential(credential)).ok).toBe(true);
    vi.resetModules();
    const freshApp = await import('../SpecRegistryCredentialOnboarding');
    const status = await freshApp.readSpecRegistryCredentialStatus();
    expect(status).toEqual({ configured: true, url: endpoint, source: 'store' });
    expect(Object.keys(status).sort()).toEqual(['configured', 'source', 'url']);
    const { resolveRegistryTaskClientConfig } = await import('../RegistryTaskClientConfig');
    const resolved = await resolveRegistryTaskClientConfig();
    expect(resolved.url).toBe(endpoint);
    expect(resolved.token === credential.token).toBe(true);
  });

  it.each([
    ['missing tools', {}],
    ['empty tools', { tools: [] }],
    ['names without schemas', { tools: [{ name: 'spec_catalog' }] }],
    ['invalid schema', { tools: [{ name: 'spec_catalog', inputSchema: { type: 'string' } }] }],
    ['non-descriptors', { tools: ['spec_catalog', null] }],
  ])(
    'refuses save for tools/list with %s and preserves the existing credential',
    async (_label, result) => {
      replyWith({ tools: usableTools });
      const onboarding = await import('../SpecRegistryCredentialOnboarding');
      expect((await onboarding.saveSpecRegistryCredential(credential)).ok).toBe(true);
      replyWith(result);
      const refused = await onboarding.saveSpecRegistryCredential({
        url: 'https://unusable.unit.invalid/mcp',
        token: 'unit-replacement-credential',
      });
      expect(refused.ok).toBe(false);
      const status = await onboarding.readSpecRegistryCredentialStatus();
      expect(status).toEqual({ configured: true, url: endpoint, source: 'store' });
      const { resolveRegistryTaskClientConfig } = await import('../RegistryTaskClientConfig');
      expect((await resolveRegistryTaskClientConfig()).token === credential.token).toBe(true);
    }
  );
});
