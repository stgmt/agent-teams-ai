import { DesktopSigningKeyStore } from '@main/services/identity/DesktopSigningKeyStore';
import { signTaskAttestation, signTaskPolicyChange, type VerifiedTaskProof, type PolicyChangeProof } from '@main/services/identity/TaskAttestation';
import { createHash, createPublicKey, verify } from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Emulates Electron storage only; this does not test Windows DPAPI.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text, 'utf8'),
    decryptString: (data: Buffer) => data.toString('utf8'),
  },
}));

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const h = (s: string) => s.repeat(64);
const identity = { registry: 'registry', idp: 'idp', userId: 'user', teamId: 'team', project: 'owner/project', spec: 'спек😀', taskId: 'TASK-1', generation: 'gen', revision: h('a') };
const policy = { required: true, expectedFilename: 'результат.txt' };
const policyHash = hash(JSON.stringify(['omp-spec-kit/task-policy@1', true, policy.expectedFilename]));
const proof: VerifiedTaskProof = { ...identity, fromStatus: 'ready', toStatus: 'done', policyVersion: 1, policyDigest: policyHash, artifactDigest: h('b'), artifactSize: 42 };
const change: PolicyChangeProof = { ...identity, previousVersion: 0, previousDigest: null, nextVersion: 1, policy };
const identityArray = [identity.registry, identity.idp, identity.userId, identity.teamId, identity.project, identity.spec, identity.taskId, identity.generation, identity.revision];
const attestation = (key: string): (string | number | null)[] => ['omp-spec-kit/task-attestation@1', ...identityArray, 'ready', 'done', 1, policyHash, h('b'), 42, h('c'), 2000000000000, key, 'request'];
const policyChange = (key: string): (string | number | null)[] => ['omp-spec-kit/task-policy-change@1', ...identityArray, 0, null, 1, policyHash, h('d'), 2000000000000, key, 'request'];

describe('task attestation protocol primitive', () => {
  let root: string;
  let store: DesktopSigningKeyStore;
  let keyId: string;
  let publicKey: string;
  beforeEach(async () => {
    const original = process;
    vi.stubGlobal('process', new Proxy(original, { get(target, key) {
      if (key === 'platform') return 'win32';
      if (key === 'type') return 'browser';
      return Reflect.get(target, key, target);
    } }));
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-attestation-'));
    store = await DesktopSigningKeyStore.create(path.join(root, 'key'));
    ({ keyId, publicKey } = await store.publicIdentity());
  });
  afterEach(async () => { vi.unstubAllGlobals(); await fs.rm(root, { recursive: true, force: true }); });

  it('signs the exact UTF-8 arrays with the enrolled Ed25519 SPKI identity', async () => {
    const der = Buffer.from(publicKey, 'base64url');
    expect(keyId).toBe(createHash('sha256').update(der).digest('hex'));
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    for (const signed of [await signTaskAttestation(store, proof, attestation(keyId)), await signTaskPolicyChange(store, change, policyChange(keyId))]) {
      expect(Object.isFrozen(signed.payload)).toBe(true);
      expect(verify(null, Buffer.from(JSON.stringify(signed.payload), 'utf8'), key, Buffer.from(signed.signature, 'base64url'))).toBe(true);
      expect(signed.signature).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(JSON.stringify(signed)).not.toContain(policy.expectedFilename);
    }
  });

  it('rejects mismatches, invalid bounds, malformed strings and unsafe arrays', async () => {
    const bad: [number, unknown][] = [[1, '\ud800'], [7, 'TASK-01'], [9, h('A')], [10, 'Ready'], [12, 0], [15, -1], [15, 20 * 1024 * 1024 + 1], [15, 1.5], [16, ''], [17, Number.MAX_SAFE_INTEGER + 1], [18, h('e')], [19, 'x'.repeat(4097)]];
    for (const [index, value] of bad) {
      const a = attestation(keyId); a[index] = value as string;
      await expect(async () => signTaskAttestation(store, proof, a)).rejects.toThrow();
    }
    await expect(async () => signTaskAttestation(store, { ...proof, artifactSize: 43 }, attestation(keyId))).rejects.toThrow();
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) {
      const a = attestation(keyId);
      a[index] = index === 7 ? 'TASK-2' : index === 9 || index === 13 || index === 14 ? h('f') :
        index === 10 ? 'todo' : index === 11 ? 'blocked' : index === 12 || index === 15 ? 2 : 'other';
      await expect(async () => signTaskAttestation(store, proof, a)).rejects.toThrow();
    }
    const sparse = attestation(keyId); delete sparse[3];
    await expect(async () => signTaskAttestation(store, proof, sparse)).rejects.toThrow();
    const extra = attestation(keyId) as (string | number | null)[] & { toJSON?: () => unknown };
    extra.toJSON = () => [];
    await expect(async () => signTaskAttestation(store, proof, extra)).rejects.toThrow();
    const getter = attestation(keyId); Object.defineProperty(getter, 3, { get: () => 'user' });
    await expect(async () => signTaskAttestation(store, proof, getter)).rejects.toThrow();
    for (const [index, value] of [[10, 1], [11, h('a')], [12, 2], [13, h('f')], [14, 'bad'], [15, 0]] as [number, unknown][]) {
      const a = policyChange(keyId); a[index] = value as string;
      await expect(async () => signTaskPolicyChange(store, change, a)).rejects.toThrow();
    }
    for (const name of ['', ' x', '..', 'x/y', 'x\\y', 'x:y', '\ud800', 'x'.repeat(256)]) {
      await expect(async () => signTaskPolicyChange(store, { ...change, policy: { required: true, expectedFilename: name } }, policyChange(keyId))).rejects.toThrow();
    }
  });

  it('accepts exact size and safe integer boundaries without normalizing Unicode', async () => {
    const p = { ...proof, artifactSize: 20 * 1024 * 1024 };
    const a = attestation(keyId); a[15] = p.artifactSize; a[17] = Number.MAX_SAFE_INTEGER;
    expect((await signTaskAttestation(store, p, a)).payload).toEqual(a);
    const zero = { ...proof, artifactSize: 0 }; const z = attestation(keyId); z[15] = 0;
    expect((await signTaskAttestation(store, zero, z)).payload).toEqual(z);
  });

});
