import { getAppDataPath } from '@main/utils/pathDecoder';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  sign,
} from 'crypto';
import { safeStorage } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';

// This primitive is deliberately not wired to IPC or task transitions. Protocol validation,
// domain separation, authorization, and trusted-key enrollment belong to its future caller.
function assertProtectedMainProcess(): void {
  if (
    process.platform !== 'win32' ||
    process.type !== 'browser' ||
    !safeStorage.isEncryptionAvailable()
  ) {
    throw new Error('Windows main-process protected storage is unavailable');
  }
}

function defaultKeyPath(): string {
  return path.join(getAppDataPath(), 'identity', 'desktop-signing-key.dpapi');
}

/** A private key never leaves this main-process store. Creation is explicit and never replaces a key. */
export class DesktopSigningKeyStore {
  private constructor(private readonly keyPath: string) {}

  static async create(keyPath = defaultKeyPath()): Promise<DesktopSigningKeyStore> {
    assertProtectedMainProcess();
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    let ciphertext: Buffer;
    try {
      ciphertext = safeStorage.encryptString(pem);
    } catch {
      throw new Error('Protected key encryption failed');
    }
    if (ciphertext.length === 0) throw new Error('Protected key encryption failed');

    await fs.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    // Exclusive creation prevents concurrent creators or a recovery attempt from replacing an
    // enrolled key. A partial write is left in place and causes future reads to fail closed.
    const file = await fs.open(keyPath, 'wx', 0o600);
    try {
      await file.writeFile(ciphertext);
      await file.sync();
    } finally {
      await file.close();
    }
    return new DesktopSigningKeyStore(keyPath);
  }

  static async open(keyPath = defaultKeyPath()): Promise<DesktopSigningKeyStore> {
    const store = new DesktopSigningKeyStore(keyPath);
    await store.readPrivateKey();
    return store;
  }

  private async readPrivateKey(): Promise<KeyObject> {
    assertProtectedMainProcess();
    const ciphertext = await fs.readFile(this.keyPath);
    try {
      if (ciphertext.length === 0) throw new Error('Empty ciphertext');
      const key = createPrivateKey(safeStorage.decryptString(ciphertext));
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Wrong key type');
      return key;
    } catch {
      throw new Error('Protected signing key is unreadable or invalid');
    }
  }

  /** Public identity for out-of-band operator provisioning. */
  async publicIdentity(): Promise<{ publicKey: string; keyId: string }> {
    const privateKey = await this.readPrivateKey();
    const der = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    return {
      publicKey: der.toString('base64url'),
      keyId: createHash('sha256').update(der).digest('hex'),
    };
  }

  /** Signs exact bytes. Callers must define and validate their own domain-separated protocol. */
  async signBytes(bytes: Uint8Array): Promise<string> {
    const input = Buffer.from(bytes);
    const privateKey = await this.readPrivateKey();
    return sign(null, input, privateKey).toString('base64url');
  }
}
