import { DesktopSigningKeyStore } from '@main/services/identity/DesktopSigningKeyStore';
import {
  createCipheriv,
  createHash,
  createDecipheriv,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify,
} from 'crypto';
import { safeStorage } from 'electron';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This emulates the safeStorage API for behavioral tests, not Windows DPAPI itself.
const state = vi.hoisted(() => ({ available: true, failEncrypt: false, platform: 'win32', type: 'browser' }));
vi.mock('electron', () => {
  let key: Buffer | undefined;
  return {
    safeStorage: {
      isEncryptionAvailable: () => state.available,
      encryptString: (value: string) => {
        if (state.failEncrypt) throw new Error('test encryption failure');
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', (key ??= randomBytes(32)), iv);
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
      },
      decryptString: (value: Buffer) => {
        if (!key) throw new Error('No test encryption key');
        const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
        decipher.setAuthTag(value.subarray(12, 28));
        return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
      },
    },
  };
});

describe('DesktopSigningKeyStore', () => {
  let root: string;
  let keyPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-signing-'));
    keyPath = path.join(root, 'identity', 'key.dpapi');
    state.available = true;
    state.failEncrypt = false;
    state.platform = 'win32';
    state.type = 'browser';
    const realProcess = process;
    vi.stubGlobal('process', new Proxy(realProcess, {
      get(target, property) {
        if (property === 'platform') return state.platform;
        if (property === 'type') return state.type;
        return Reflect.get(target, property, target);
      },
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists an encrypted key and deterministically signs exact bytes after reopening', async () => {
    const created = await DesktopSigningKeyStore.create(keyPath);
    const identity = await created.publicIdentity();
    const { publicKey } = identity;
    expect(identity.keyId).toBe(createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex'));
    const bytes = Buffer.from('example domain-separated bytes\0', 'utf8');
    const signature = await created.signBytes(bytes);
    const disk = await fs.readFile(keyPath);
    expect(disk.toString('utf8')).not.toContain('PRIVATE KEY');
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);

    const reopened = await DesktopSigningKeyStore.open(keyPath);
    expect(await reopened.publicIdentity()).toEqual(identity);
    expect(await reopened.signBytes(bytes)).toBe(signature);
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' });
    expect(verify(null, bytes, key, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(verify(null, Buffer.from('different'), key, Buffer.from(signature, 'base64url'))).toBe(false);
    const mutable = Buffer.from(bytes);
    const pending = reopened.signBytes(mutable);
    mutable.fill(0);
    expect(await pending).toBe(signature);
  });

  it('does not replace a key on repeated or concurrent creation', async () => {
    const attempts = await Promise.allSettled([
      DesktopSigningKeyStore.create(keyPath),
      DesktopSigningKeyStore.create(keyPath),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const before = await (await DesktopSigningKeyStore.open(keyPath)).publicIdentity();
    await expect(DesktopSigningKeyStore.create(keyPath)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await (await DesktopSigningKeyStore.open(keyPath)).publicIdentity()).toEqual(before);
  });

  it('does not create a replacement when the key is missing, damaged or not Ed25519', async () => {
    await expect(DesktopSigningKeyStore.open(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await DesktopSigningKeyStore.create(keyPath);
    const corrupt = Buffer.from('corrupt encrypted data');
    await fs.writeFile(keyPath, corrupt);
    await expect(DesktopSigningKeyStore.open(keyPath)).rejects.toThrow('unreadable or invalid');
    expect(await fs.readFile(keyPath)).toEqual(corrupt);

    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    const wrongKey = safeStorage.encryptString(rsa.export({ type: 'pkcs8', format: 'pem' }).toString());
    await fs.writeFile(keyPath, wrongKey);
    await expect(DesktopSigningKeyStore.open(keyPath)).rejects.toThrow('unreadable or invalid');
    expect(await fs.readFile(keyPath)).toEqual(wrongKey);
  });

  it('fails closed when protected storage is unavailable even after opening', async () => {
    state.available = false;
    await expect(DesktopSigningKeyStore.create(keyPath)).rejects.toThrow('protected storage is unavailable');
    await expect(fs.stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    state.available = true;
    state.failEncrypt = true;
    await expect(DesktopSigningKeyStore.create(keyPath)).rejects.toThrow('Protected key encryption failed');
    await expect(fs.stat(keyPath)).rejects.toMatchObject({ code: 'ENOENT' });
    state.failEncrypt = false;
    state.available = true;
    const store = await DesktopSigningKeyStore.create(keyPath);
    state.available = false;
    await expect(store.signBytes(Buffer.from('bytes'))).rejects.toThrow('protected storage is unavailable');
    await expect(store.publicIdentity()).rejects.toThrow('protected storage is unavailable');
  });

  it('rejects non-Windows and non-main processes', async () => {
    state.platform = 'linux';
    await expect(DesktopSigningKeyStore.create(keyPath)).rejects.toThrow('protected storage is unavailable');
    state.platform = 'win32';
    state.type = 'renderer';
    await expect(DesktopSigningKeyStore.create(keyPath)).rejects.toThrow('protected storage is unavailable');
  });
});
