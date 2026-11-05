import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  applyLocalModelRouterCredential,
  applyLocalModelRouterEnv,
  detectLocalModelRouter,
  type LocalModelRouter,
} from '../../../../src/main/services/team/provisioning/localModelRouter';

const roots: string[] = [];

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'TEST-router-home-'));
  roots.push(root);
  return root;
}

async function writeSettings(root: string, env: Record<string, string>): Promise<void> {
  await mkdir(join(root, '.claude'), { recursive: true });
  await writeFile(join(root, '.claude', 'settings.json'), JSON.stringify({ env }), 'utf8');
}

async function writeRouterConfig(root: string, port: number): Promise<void> {
  await mkdir(join(root, '.clauderipple'), { recursive: true });
  await writeFile(
    join(root, '.clauderipple', 'config.json'),
    JSON.stringify({
      listen: { host: '127.0.0.1', port },
      providers: { codex: { models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-terra' }] } },
    }),
    'utf8'
  );
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('local model router detection', () => {
  it('reports the loopback router the CLI already uses and its CA', async () => {
    const root = await home();
    const caPath = join(root, '.clauderipple', 'ca.pem');
    await mkdir(join(root, '.clauderipple'), { recursive: true });
    await writeFile(caPath, 'TEST-ca', 'utf8');
    await writeSettings(root, {
      HTTPS_PROXY: 'http://127.0.0.1:8790',
      NODE_EXTRA_CA_CERTS: caPath,
    });
    await writeRouterConfig(root, 8790);

    const router = await detectLocalModelRouter({
      homeDir: root,
      env: {},
      isPortOpen: async () => true,
    });

    expect(router).toMatchObject({
      kind: 'clauderipple',
      proxyUrl: 'http://127.0.0.1:8790',
      caPath,
    });
    expect(router?.models).toEqual(['gpt-6.1-sol', 'gpt-6.1-terra']);
  });

  it('stays silent while the configured router is not listening', async () => {
    const root = await home();
    await writeSettings(root, { HTTPS_PROXY: 'http://127.0.0.1:8790' });
    await writeRouterConfig(root, 8790);
    const isPortOpen = vi.fn(async () => false);

    await expect(
      detectLocalModelRouter({ homeDir: root, env: {}, isPortOpen })
    ).resolves.toBeNull();
    expect(isPortOpen).toHaveBeenCalledWith('127.0.0.1', 8790);
  });

  it('does not mistake another loopback proxy for the model router', async () => {
    const root = await home();
    await writeSettings(root, { HTTPS_PROXY: 'http://127.0.0.1:3128' });
    const isPortOpen = vi.fn(async () => true);

    await expect(
      detectLocalModelRouter({ homeDir: root, env: {}, isPortOpen })
    ).resolves.toBeNull();
    expect(isPortOpen).not.toHaveBeenCalled();
  });

  it('never treats a remote proxy as the local model router', async () => {
    const root = await home();
    await writeSettings(root, { HTTPS_PROXY: 'http://proxy.example.com:3128' });
    const isPortOpen = vi.fn(async () => true);

    await expect(
      detectLocalModelRouter({ homeDir: root, env: {}, isPortOpen })
    ).resolves.toBeNull();
    expect(isPortOpen).not.toHaveBeenCalled();
  });
});

describe('local model router environment', () => {
  const router: LocalModelRouter = Object.freeze({
    kind: 'clauderipple',
    proxyUrl: 'http://127.0.0.1:8790',
    caPath: 'C:/TEST/ca.pem',
    markerToken: 'local-model-router',
    models: Object.freeze([]),
  });

  it('adds egress proxy settings without overriding what the user already set', () => {
    const env = applyLocalModelRouterEnv({ HTTPS_PROXY: 'http://corp:8080' }, router);
    expect(env.HTTPS_PROXY).toBe('http://corp:8080');
    expect(env.HTTP_PROXY).toBe('http://127.0.0.1:8790');
    expect(env.NO_PROXY).toBe('127.0.0.1,localhost,::1');
    expect(env.NODE_EXTRA_CA_CERTS).toBe('C:/TEST/ca.pem');
  });

  it('keeps the exclusions a user already had while adding loopback', () => {
    const env = applyLocalModelRouterEnv({ NO_PROXY: 'example.com,localhost' }, router);
    expect(env.NO_PROXY).toBe('example.com,localhost,127.0.0.1,::1');
  });

  it('supplies a marker credential only when no real one exists', () => {
    expect(applyLocalModelRouterCredential({}, router).ANTHROPIC_AUTH_TOKEN).toBe(
      'local-model-router'
    );
    expect(
      applyLocalModelRouterCredential({ ANTHROPIC_AUTH_TOKEN: '  ' }, router).ANTHROPIC_AUTH_TOKEN
    ).toBe('local-model-router');
    expect(
      applyLocalModelRouterCredential({ ANTHROPIC_API_KEY: 'sk-ant-real' }, router).ANTHROPIC_API_KEY
    ).toBe('sk-ant-real');
    expect(
      applyLocalModelRouterCredential({ ANTHROPIC_API_KEY: 'sk-ant-real' }, router)
    ).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
  });
});
