import * as fs from 'node:fs/promises';
import { createHash, createPublicKey, verify } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopSigningKeyStore } from '@main/services/identity/DesktopSigningKeyStore';
import {
  verifyAndSignTaskArtifact,
  type TaskAttestationCallerContext,
  type TaskAttestationChallengeClient,
} from '@main/services/identity/VerifiedLocalTaskArtifact';

import type { TaskIdentity, TaskPolicy, VerifiedTaskProof } from '@main/services/identity/TaskAttestation';

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text, 'utf8'),
    decryptString: (data: Buffer) => data.toString('utf8'),
  },
}));

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const repeatHash = (char: string) => char.repeat(64);
const identity: TaskIdentity = {
  registry: 'registry.example',
  idp: 'idp.example',
  userId: 'user-1',
  teamId: 'team-1',
  project: 'owner/project',
  spec: 'security-spec',
  taskId: 'TASK-1',
  generation: 'generation-1',
  revision: repeatHash('a'),
};
const policy: TaskPolicy = { required: true, expectedFilename: 'private-result.txt' };

function policyDigestFor(currentPolicy: TaskPolicy): string {
  return hash(JSON.stringify([
    'omp-spec-kit/task-policy@1',
    currentPolicy.required,
    currentPolicy.expectedFilename ?? null,
  ]));
}
const policyDigest = policyDigestFor(policy);

const CONTROLLER_ATTACHMENT_ID = '550e8400-e29b-41d4-a716-446655440000';

function controllerArtifactPath(root: string, attachmentId = CONTROLLER_ATTACHMENT_ID): string {
  return path.join(root, `${attachmentId}--artifact.bin`);
}

function controllerAttachmentInput(
  root: string,
  proof: VerifiedTaskProof,
  filename = policy.expectedFilename!
) {
  return {
    attachment: {
      id: CONTROLLER_ATTACHMENT_ID,
      filename,
      mimeType: 'application/octet-stream' as const,
      size: proof.artifactSize,
      addedAt: '2026-11-08T00:00:00.000Z',
      filePath: controllerArtifactPath(root),
    },
    attachmentProof: {
      attachmentId: CONTROLLER_ATTACHMENT_ID,
      sha256: proof.artifactDigest,
      size: proof.artifactSize,
    },
  };
}

function controllerRequest(
  root: string,
  proof: VerifiedTaskProof,
  callerContext: TaskAttestationCallerContext | null,
  challengeClient: TaskAttestationChallengeClient | null
) {
  return {
    ...controllerAttachmentInput(root, proof),
    allowedRoot: root,
    callerContext,
    challengeClient,
  };
}
const identityTuple = [
  identity.registry,
  identity.idp,
  identity.userId,
  identity.teamId,
  identity.project,
  identity.spec,
  identity.taskId,
  identity.generation,
  identity.revision,
];

function proofFor(bytes: Buffer, currentPolicy: TaskPolicy = policy): VerifiedTaskProof {
  return {
    ...identity,
    fromStatus: 'ready',
    toStatus: 'done',
    policyVersion: 3,
    policyDigest: policyDigestFor(currentPolicy),
    artifactDigest: hash(bytes),
    artifactSize: bytes.length,
  };
}

function contextFor(proof: VerifiedTaskProof, currentPolicy: TaskPolicy = policy): TaskAttestationCallerContext {
  return { callerIdentity: identity, proof, policy: currentPolicy };
}

function challengeFor(proof: VerifiedTaskProof, keyId: string): (string | number | null)[] {
  return [
    'omp-spec-kit/task-attestation@1',
    ...identityTuple,
    proof.fromStatus,
    proof.toStatus,
    proof.policyVersion,
    proof.policyDigest,
    proof.artifactDigest,
    proof.artifactSize,
    repeatHash('c'),
    Date.now() + 60_000,
    keyId,
    'registry-request-1',
  ];
}

describe('verified local task artifact attestation', () => {
  let tempRoot: string;
  let allowedRoot: string;
  let signingRoot: string;
  let store: DesktopSigningKeyStore;
  let keyId: string;
  let publicKey: string;

  beforeEach(async () => {
    const originalProcess = process;
    vi.stubGlobal('process', new Proxy(originalProcess, {
      get(target, key) {
        if (key === 'platform') return 'win32';
        if (key === 'type') return 'browser';
        return Reflect.get(target, key, target);
      },
    }));
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'verified-local-task-artifact-'));
    allowedRoot = path.join(tempRoot, 'task-attachments', 'TASK-1');
    signingRoot = path.join(tempRoot, 'identity');
    await fs.mkdir(allowedRoot, { recursive: true });
    await fs.mkdir(signingRoot, { recursive: true });
    store = await DesktopSigningKeyStore.create(path.join(signingRoot, 'key.dpapi'));
    ({ keyId, publicKey } = await store.publicIdentity());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('hashes a real local file, asks only for its proof tuple, and signs the exact challenge', async () => {
    const filePath = controllerArtifactPath(allowedRoot);
    const bytes = Buffer.from('local-only-artifact-content:do-not-send', 'utf8');
    await fs.writeFile(filePath, bytes);
    const proof = proofFor(bytes);

    let requestedProof: VerifiedTaskProof | undefined;
    const challenge = challengeFor(proof, keyId);
    const challengeClient: TaskAttestationChallengeClient = {
      async requestChallenge(requested) {
        requestedProof = requested;
        return challenge;
      },
    };

    const signed = await verifyAndSignTaskArtifact(
      store,
      controllerRequest(allowedRoot, proof, contextFor(proof), challengeClient)
    );

    expect(requestedProof).toEqual(proof);
    expect(signed.payload).toEqual(challenge);
    expect(Object.isFrozen(signed.payload)).toBe(true);
    const der = Buffer.from(publicKey, 'base64url');
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    expect(verify(
      null,
      Buffer.from(JSON.stringify(signed.payload), 'utf8'),
      key,
      Buffer.from(signed.signature, 'base64url'),
    )).toBe(true);

    const serverRequest = JSON.stringify(requestedProof ?? null);
    const result = JSON.stringify(signed);
    expect(serverRequest).not.toContain(filePath);
    expect(serverRequest).not.toContain(policy.expectedFilename);
    expect(serverRequest).not.toContain(bytes.toString('utf8'));
    expect(result).not.toContain(filePath);
    expect(result).not.toContain(policy.expectedFilename);
    expect(result).not.toContain(bytes.toString('utf8'));
    expect(signed.payload).toContain(hash(bytes));
    expect(signed.payload).toContain(bytes.length);
  });

  it('fails closed without both caller context and the challenge client', async () => {
    const filePath = controllerArtifactPath(allowedRoot);
    const bytes = Buffer.from('local bytes');
    await fs.writeFile(filePath, bytes);
    const proof = proofFor(bytes);
    const challengeClient: TaskAttestationChallengeClient = {
      requestChallenge: async (requested) => challengeFor(requested, keyId),
    };

    await expect(verifyAndSignTaskArtifact(
      store,
      controllerRequest(allowedRoot, proof, null, challengeClient)
    )).rejects.toThrow('Local task artifact attestation was refused');
    await expect(verifyAndSignTaskArtifact(
      store,
      controllerRequest(allowedRoot, proof, contextFor(proof), null)
    )).rejects.toThrow('Local task artifact attestation was refused');
  });

  it('rejects mismatched controller attachment metadata, proof, and challenges', async () => {
    const bytes = Buffer.from('controller artifact bytes');
    const filePath = controllerArtifactPath(allowedRoot);
    await fs.writeFile(filePath, bytes);
    const proof = proofFor(bytes);
    const requestChallenge = vi.fn(async (requested: VerifiedTaskProof) => challengeFor(requested, keyId));
    const challengeClient: TaskAttestationChallengeClient = { requestChallenge };
    const validInput = controllerRequest(allowedRoot, proof, contextFor(proof), challengeClient);

    await expect(verifyAndSignTaskArtifact(store, {
      ...validInput,
      attachment: { ...validInput.attachment, id: '550e8400-e29b-41d4-a716-446655440001' },
    })).rejects.toThrow();
    await expect(verifyAndSignTaskArtifact(store, {
      ...validInput,
      attachment: { ...validInput.attachment, id: 'not-a-uuid' },
    })).rejects.toThrow();
    await expect(verifyAndSignTaskArtifact(store, {
      ...validInput,
      attachment: {
        ...validInput.attachment,
        filePath: path.join(allowedRoot, '550e8400-e29b-41d4-a716-446655440001--artifact.bin'),
      },
    })).rejects.toThrow();
    await expect(verifyAndSignTaskArtifact(store, {
      ...validInput,
      attachment: { ...validInput.attachment, filename: 'different-result.txt' },
    })).rejects.toThrow();
    await expect(verifyAndSignTaskArtifact(store, {
      ...validInput,
      attachmentProof: { ...validInput.attachmentProof, sha256: repeatHash('f') },
    })).rejects.toThrow();
    await expect(verifyAndSignTaskArtifact(store, {
      ...validInput,
      attachment: { ...validInput.attachment, size: proof.artifactSize + 1 },
    })).rejects.toThrow();
    await expect(verifyAndSignTaskArtifact(store, {
      ...validInput,
      attachmentProof: { ...validInput.attachmentProof, size: proof.artifactSize + 1 },
    })).rejects.toThrow();
    await expect(verifyAndSignTaskArtifact(store, {
      ...validInput,
      filePath: path.join(tempRoot, 'untrusted-path'),
      filename: 'untrusted-name.txt',
    } as never)).rejects.toThrow();
    expect(requestChallenge).not.toHaveBeenCalled();

    const badDigestProof = { ...proof, artifactDigest: repeatHash('f') };
    await expect(verifyAndSignTaskArtifact(store, controllerRequest(
      allowedRoot,
      proof,
      contextFor(badDigestProof),
      challengeClient
    ))).rejects.toThrow();
    expect(requestChallenge).not.toHaveBeenCalled();

    const mismatchedPolicyContext = {
      ...contextFor(proof),
      policy: { required: true, expectedFilename: 'different-result.txt' },
    };
    await expect(verifyAndSignTaskArtifact(store, controllerRequest(
      allowedRoot,
      proof,
      mismatchedPolicyContext,
      challengeClient
    ))).rejects.toThrow();
    const mismatchedCallerIdentity = {
      ...contextFor(proof),
      callerIdentity: { ...identity, userId: 'other-user' },
    };
    await expect(verifyAndSignTaskArtifact(store, controllerRequest(
      allowedRoot,
      proof,
      mismatchedCallerIdentity,
      challengeClient
    ))).rejects.toThrow();
    expect(requestChallenge).not.toHaveBeenCalled();

    const expiredClient: TaskAttestationChallengeClient = {
      requestChallenge: async (requested) => {
        const challenge = challengeFor(requested, keyId);
        challenge[17] = Date.now() - 1;
        return challenge;
      },
    };
    await expect(verifyAndSignTaskArtifact(store, controllerRequest(
      allowedRoot,
      proof,
      contextFor(proof),
      expiredClient
    ))).rejects.toThrow();

    const invalidNonceClient: TaskAttestationChallengeClient = {
      requestChallenge: async (requested) => {
        const challenge = challengeFor(requested, keyId);
        challenge[16] = 'not-a-sha256-nonce';
        return challenge;
      },
    };
    await expect(verifyAndSignTaskArtifact(store, controllerRequest(
      allowedRoot,
      proof,
      contextFor(proof),
      invalidNonceClient
    ))).rejects.toThrow();

    const wrongIdentityClient: TaskAttestationChallengeClient = {
      requestChallenge: async (requested) => {
        const challenge = challengeFor(requested, keyId);
        challenge[3] = 'other-user';
        return challenge;
      },
    };
    await expect(verifyAndSignTaskArtifact(store, controllerRequest(
      allowedRoot,
      proof,
      contextFor(proof),
      wrongIdentityClient
    ))).rejects.toThrow();
  });

  it('accepts exactly 20 MB and binds the computed digest and size into the signed challenge', async () => {
    const filePath = controllerArtifactPath(allowedRoot);
    const bytes = Buffer.alloc(20 * 1024 * 1024, 0x51);
    await fs.writeFile(filePath, bytes);
    const proof = proofFor(bytes);
    const requestChallenge = vi.fn(async (requested: VerifiedTaskProof) => challengeFor(requested, keyId));

    const signed = await verifyAndSignTaskArtifact(
      store,
      controllerRequest(allowedRoot, proof, contextFor(proof), { requestChallenge })
    );

    expect(requestChallenge).toHaveBeenCalledWith(proof);
    expect(signed.payload[14]).toBe(hash(bytes));
    expect(signed.payload[15]).toBe(20 * 1024 * 1024);
  });

  it('rejects required artifact policies without a resolved expected filename', async () => {
    const bytes = Buffer.from('local-only artifact');
    const filePath = controllerArtifactPath(allowedRoot);
    await fs.writeFile(filePath, bytes);
    const requestChallenge = vi.fn(async (requested: VerifiedTaskProof) => challengeFor(requested, keyId));
    const challengeClient: TaskAttestationChallengeClient = { requestChallenge };
    const policies: TaskPolicy[] = [
      { required: true, expectedFilename: null },
      { required: true },
    ];
    for (const currentPolicy of policies) {
      const proof = proofFor(bytes, currentPolicy);
      await expect(verifyAndSignTaskArtifact(store, controllerRequest(
        allowedRoot,
        proof,
        contextFor(proof, currentPolicy),
        challengeClient
      ))).rejects.toThrow('Local task artifact attestation was refused');
    }
    expect(requestChallenge).not.toHaveBeenCalled();
  });

  it('rejects directories rather than treating them as regular artifact files', async () => {
    const filePath = controllerArtifactPath(allowedRoot);
    await fs.mkdir(filePath);
    const proof = proofFor(Buffer.alloc(0));
    const requestChallenge = vi.fn(async (requested: VerifiedTaskProof) => challengeFor(requested, keyId));

    await expect(verifyAndSignTaskArtifact(
      store,
      controllerRequest(allowedRoot, proof, contextFor(proof), { requestChallenge })
    )).rejects.toThrow();
    expect(requestChallenge).not.toHaveBeenCalled();
  });

  it('rejects artifacts over 20 MB before requesting a challenge', async () => {
    const filePath = controllerArtifactPath(allowedRoot);
    await fs.writeFile(filePath, Buffer.alloc(0));
    await fs.truncate(filePath, 20 * 1024 * 1024 + 1);
    const proof: VerifiedTaskProof = {
      ...identity,
      fromStatus: 'ready',
      toStatus: 'done',
      policyVersion: 3,
      policyDigest,
      artifactDigest: repeatHash('b'),
      artifactSize: 20 * 1024 * 1024,
    };
    const requestChallenge = vi.fn(async (requested: VerifiedTaskProof) => challengeFor(requested, keyId));

    await expect(verifyAndSignTaskArtifact(
      store,
      controllerRequest(allowedRoot, proof, contextFor(proof), { requestChallenge })
    )).rejects.toThrow();
    expect(requestChallenge).not.toHaveBeenCalled();
  });

  it('rejects controller artifact symlinks that escape the task attachment root', async () => {
    const outside = path.join(tempRoot, 'outside');
    await fs.mkdir(outside);
    const outsideFile = path.join(outside, 'outside.txt');
    const bytes = Buffer.from('must remain local');
    await fs.writeFile(outsideFile, bytes);
    const filePath = controllerArtifactPath(allowedRoot);
    let fileSymlinkCreated = false;
    try {
      await fs.symlink(outsideFile, filePath, 'file');
      fileSymlinkCreated = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'ENOSYS') throw error;
    }
    const proof = proofFor(bytes);
    const requestChallenge = vi.fn(async (requested: VerifiedTaskProof) => challengeFor(requested, keyId));
    if (fileSymlinkCreated) {
      await expect(verifyAndSignTaskArtifact(
        store,
        controllerRequest(allowedRoot, proof, contextFor(proof), { requestChallenge })
      )).rejects.toThrow();
      expect(requestChallenge).not.toHaveBeenCalled();
    }
  });

  it('rejects in-place mutation performed by the challenge client while the file handle stays open', async () => {
    const filePath = controllerArtifactPath(allowedRoot);
    const initialBytes = Buffer.alloc(1024 * 1024, 0x31);
    const changedBytes = Buffer.from('mutated while challenge was pending');
    await fs.writeFile(filePath, initialBytes);
    const proof = proofFor(initialBytes);
    const serverChallengeFixture = challengeFor(proof, keyId);
    let changed = false;
    const challengeClient: TaskAttestationChallengeClient = {
      async requestChallenge() {
        await fs.writeFile(filePath, changedBytes);
        changed = true;
        return serverChallengeFixture;
      },
    };

    await expect(verifyAndSignTaskArtifact(
      store,
      controllerRequest(allowedRoot, proof, contextFor(proof), challengeClient)
    )).rejects.toThrow();
    expect(changed).toBe(true);
    expect(await fs.readFile(filePath)).toEqual(changedBytes);
  });

  it('rejects attachment-path replacement performed by the challenge client with the file handle open', async () => {
    const filePath = controllerArtifactPath(allowedRoot);
    const initialBytes = Buffer.alloc(1024 * 1024, 0x31);
    const replacementBytes = Buffer.from('replacement bytes');
    await fs.writeFile(filePath, initialBytes);
    const replacementPath = path.join(allowedRoot, 'replacement.tmp');
    await fs.writeFile(replacementPath, replacementBytes);
    const proof = proofFor(initialBytes);
    const serverChallengeFixture = challengeFor(proof, keyId);
    let replaced = false;
    const challengeClient: TaskAttestationChallengeClient = {
      async requestChallenge() {
        await fs.unlink(filePath);
        await fs.rename(replacementPath, filePath);
        replaced = true;
        return serverChallengeFixture;
      },
    };

    await expect(verifyAndSignTaskArtifact(
      store,
      controllerRequest(allowedRoot, proof, contextFor(proof), challengeClient)
    )).rejects.toThrow();
    expect(replaced).toBe(true);
    expect(await fs.readFile(filePath)).toEqual(replacementBytes);
  });
});
