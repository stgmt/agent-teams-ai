// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolveRegistryTaskClientConfig } from '../RegistryTaskClientConfig';
import {
  type SpecRegistryCredentialCipher,
  SpecRegistryCredentialStore,
} from '../SpecRegistryCredentialStore';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true, maxRetries: 20 });
});

function cipher(available = true): SpecRegistryCredentialCipher {
  return {
    isAvailable: () => available,
    encrypt: (value) => Buffer.from(`enc:${value}`, 'utf8'),
    decrypt: (value) => {
      const text = value.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not encrypted by this cipher');
      return text.slice(4);
    },
  };
}

function storeWith(cipherImpl = cipher()): { store: SpecRegistryCredentialStore; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'spec-credential-'));
  directories.push(directory);
  const file = join(directory, 'credential.json');
  return { store: new SpecRegistryCredentialStore(cipherImpl, file), file };
}

describe('spec registry credential store', () => {
  it('stores the token encrypted and reads it back', async () => {
    const { store, file } = storeWith();
    await store.save({ url: 'http://127.0.0.1:8650/mcp', token: 'TEST-token' });

    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain('TEST-token');
    await expect(store.read()).resolves.toEqual({
      url: 'http://127.0.0.1:8650/mcp',
      token: 'TEST-token',
    });
  });

  it('reports an absent credential as null', async () => {
    const { store } = storeWith();
    await expect(store.read()).resolves.toBeNull();
  });

  it('refuses to store or read when the OS keychain is unavailable', async () => {
    const { store } = storeWith(cipher(false));
    await expect(store.save({ url: 'https://x/mcp', token: 't' })).rejects.toThrow('keychain');
  });

  it('clears the stored credential', async () => {
    const { store } = storeWith();
    await store.save({ url: 'https://x/mcp', token: 't' });
    await store.clear();
    await expect(store.read()).resolves.toBeNull();
  });

  it('rejects an unknown stored shape instead of guessing', async () => {
    const { store, file } = storeWith();
    await store.save({ url: 'https://x/mcp', token: 't' });
    const broken = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    require('node:fs').writeFileSync(file, JSON.stringify({ ...broken, version: 9 }));
    await expect(store.read()).rejects.toThrow('unknown shape');
  });
});

describe('registry credential resolution order', () => {
  it('uses the saved connection without consulting inherited environment variables', async () => {
    const { store } = storeWith();
    await store.save({ url: 'http://stored.example/mcp', token: 'stored-token' });
    vi.stubEnv('OMP_SPEC_REGISTRY_URL', 'http://env.example/mcp');
    vi.stubEnv('OMP_SPEC_REGISTRY_TOKEN', 'env-token');
    const resolved = await resolveRegistryTaskClientConfig({
      credentialStore: store,
    });
    expect(resolved.url).toBe('http://stored.example/mcp');
    expect(resolved.token).toBe('stored-token');
  });

  it('requires app setup when only inherited environment credentials exist', async () => {
    const { store } = storeWith();
    vi.stubEnv('OMP_SPEC_REGISTRY_URL', 'https://inherited.unit.invalid/mcp');
    vi.stubEnv('OMP_SPEC_REGISTRY_TOKEN', 'unit-inherited-token');
    await expect(
      resolveRegistryTaskClientConfig({
        credentialStore: store,
      })
    ).rejects.toThrow();
  });

  it('does not recover an absent app credential from a legacy token file', async () => {
    const { store, file } = storeWith();
    const tokenFilePath = join(file, '..', 'legacy-token.txt');
    require('node:fs').writeFileSync(tokenFilePath, 'unit-legacy-token');
    vi.stubEnv('OMP_SPEC_REGISTRY_TOKEN_FILE', tokenFilePath);
    await expect(resolveRegistryTaskClientConfig({ credentialStore: store })).rejects.toThrow();
  });

  it('reloads the saved endpoint and credential through a fresh store instance', async () => {
    const { store, file } = storeWith();
    await store.save({ url: 'https://saved.unit.invalid/mcp', token: 'unit-saved-token' });
    const freshStore = new SpecRegistryCredentialStore(cipher(), file);
    const resolved = await resolveRegistryTaskClientConfig({
      credentialStore: freshStore,
    });
    expect(resolved.url).toBe('https://saved.unit.invalid/mcp');
    expect(resolved.token === 'unit-saved-token').toBe(true);
  });

  it('surfaces an unreadable store instead of using a weaker source', async () => {
    const broken = {
      read: async () => {
        throw new Error('cannot decrypt');
      },
    };
    await expect(
      resolveRegistryTaskClientConfig({
        credentialStore: broken,
      })
    ).rejects.toThrow('unreadable');
  });

  it('preserves explicitly injected client configuration without opening the OS credential store', async () => {
    const read = vi.fn(async () => {
      throw new Error('must not read injected store');
    });
    const config = await resolveRegistryTaskClientConfig({
      url: 'https://injected.unit.invalid/mcp',
      token: 'unit-injected-token',
      credentialStore: { read },
    });
    expect(config.url).toBe('https://injected.unit.invalid/mcp');
    expect(config.token === 'unit-injected-token').toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
});
