import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { getAppDataPath } from '@main/utils/pathDecoder';

/**
 * The spec registry credential the app itself holds: endpoint plus bearer token,
 * encrypted with the OS keychain through Electron `safeStorage` (DPAPI on
 * Windows). This is the one place a token is stored; the launch hands it to the
 * app MCP child only.
 */
export interface SpecRegistryCredential {
  readonly url: string;
  readonly token: string;
}

/** Encryption is injected so the store can be tested without Electron. */
export interface SpecRegistryCredentialCipher {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

interface StoredShape {
  readonly version: 1;
  readonly url: string;
  readonly token: string;
}

export class SpecRegistryCredentialStore {
  constructor(
    private readonly cipher: SpecRegistryCredentialCipher,
    private readonly filePath: string = path.join(
      getAppDataPath(),
      'spec-registry',
      'credential.json'
    )
  ) {}

  async read(): Promise<SpecRegistryCredential | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    let stored: StoredShape;
    try {
      stored = JSON.parse(raw) as StoredShape;
    } catch {
      throw new Error('The stored spec registry credential is unreadable');
    }
    if (
      stored.version !== 1 ||
      typeof stored.url !== 'string' ||
      typeof stored.token !== 'string'
    ) {
      throw new Error('The stored spec registry credential has an unknown shape');
    }
    if (!this.cipher.isAvailable()) {
      throw new Error('The OS keychain is unavailable, so the stored credential cannot be read');
    }
    const token = this.cipher.decrypt(Buffer.from(stored.token, 'base64'));
    if (!token) throw new Error('The stored spec registry credential could not be decrypted');
    return { url: stored.url, token };
  }

  async save(credential: SpecRegistryCredential): Promise<void> {
    const url = credential.url.trim();
    const token = credential.token.trim();
    if (!url) throw new Error('A spec registry endpoint is required');
    if (!token) throw new Error('A spec registry token is required');
    if (!this.cipher.isAvailable()) {
      throw new Error('The OS keychain is unavailable, so the credential cannot be stored');
    }
    const stored: StoredShape = {
      version: 1,
      url,
      token: this.cipher.encrypt(token).toString('base64'),
    };
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, this.filePath);
  }

  async clear(): Promise<void> {
    try {
      await fs.rm(this.filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

/** The production cipher: Electron safeStorage from the main process. */
export function createElectronCredentialCipher(): SpecRegistryCredentialCipher {
  const load = (): typeof import('electron').safeStorage => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron');
    return electron.safeStorage;
  };
  return {
    isAvailable: () => load().isEncryptionAvailable(),
    encrypt: (value) => load().encryptString(value),
    decrypt: (value) => load().decryptString(value),
  };
}
