// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SpecRegistryCredentialStore,
  type SpecRegistryCredentialCipher,
} from '../SpecRegistryCredentialStore';
import { resolveRegistryTaskClientConfig } from '../RegistryTaskClientConfig';

const directories: string[] = [];
afterEach(() => {
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
    await expect(store.save({ url: 'http://x/mcp', token: 't' })).rejects.toThrow('keychain');
  });

  it('clears the stored credential', async () => {
    const { store } = storeWith();
    await store.save({ url: 'http://x/mcp', token: 't' });
    await store.clear();
    await expect(store.read()).resolves.toBeNull();
  });

  it('rejects an unknown stored shape instead of guessing', async () => {
    const { store, file } = storeWith();
    await store.save({ url: 'http://x/mcp', token: 't' });
    const broken = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    require('node:fs').writeFileSync(file, JSON.stringify({ ...broken, version: 9 }));
    await expect(store.read()).rejects.toThrow('unknown shape');
  });
});

describe('registry credential resolution order', () => {
  it('prefers the app store over environment variables', async () => {
    const { store } = storeWith();
    await store.save({ url: 'http://stored.example/mcp', token: 'stored-token' });
    const resolved = await resolveRegistryTaskClientConfig({
      credentialStore: store,
      env: {
        OMP_SPEC_REGISTRY_URL: 'http://env.example/mcp',
        OMP_SPEC_REGISTRY_TOKEN: 'env-token',
      },
    });
    expect(resolved.url).toBe('http://stored.example/mcp');
    expect(resolved.token).toBe('stored-token');
  });

  it('falls back to the environment only when the store is empty', async () => {
    const { store } = storeWith();
    const resolved = await resolveRegistryTaskClientConfig({
      credentialStore: store,
      env: {
        OMP_SPEC_REGISTRY_URL: 'http://env.example/mcp',
        OMP_SPEC_REGISTRY_TOKEN: 'env-token',
      },
    });
    expect(resolved.url).toBe('http://env.example/mcp');
    expect(resolved.token).toBe('env-token');
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
        env: { OMP_SPEC_REGISTRY_TOKEN: 'env-token' },
      })
    ).rejects.toThrow('unreadable');
  });
});
