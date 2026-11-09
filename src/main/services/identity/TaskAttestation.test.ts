// @vitest-environment node
import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DesktopSigningKeyStore } from './DesktopSigningKeyStore';
import {
  digestTaskCreationToken,
  signTaskGenesisAttestation,
  taskGenesisRequestDigest,
  taskLifecycleOperationCompletionDigest,
} from './TaskAttestation';

const POLICY_DIGEST = createHash('sha256')
  .update(JSON.stringify(['omp-spec-kit/task-policy@1', true, 'proof.pdf']), 'utf8')
  .digest('hex');

function setup(now = Date.now()) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const publicKeyBytes = publicKey.export({ type: 'spki', format: 'der' });
  const keyId = createHash('sha256').update(publicKeyBytes).digest('hex');
  const store = {
    publicIdentity: async () => ({
      publicKey: publicKeyBytes.toString('base64url'),
      keyId,
    }),
    signBytes: async (bytes: Uint8Array) =>
      sign(null, Buffer.from(bytes), privateKey).toString('base64url'),
  } as DesktopSigningKeyStore;
  const creationToken = 'opaque-create-token';
  const expected = {
    registryStoreId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    idp: 'idp-1',
    userId: 'user-1',
    teamId: 'team-1',
    project: 'owner/repo',
    spec: 'example-spec',
    taskId: 'TASK-7',
    requestId: '11111111-1111-4111-8111-111111111111',
    payloadDigest: 'a'.repeat(64),
    creationTokenDigest: digestTaskCreationToken(creationToken),
    policy: { required: true, expectedFilename: 'proof.pdf' },
  };
  const challenge: (string | number | null)[] = [
    'omp-spec-kit/task-genesis-attestation@1',
    expected.registryStoreId,
    expected.idp,
    expected.userId,
    expected.teamId,
    'principal-1',
    expected.project,
    expected.spec,
    expected.taskId,
    '22222222-2222-4222-8222-222222222222',
    'owner/repo',
    'refs/heads/main',
    'a'.repeat(40),
    'b'.repeat(40),
    '33333333-3333-4333-8333-333333333333',
    '44444444-4444-4444-8444-444444444444',
    '55555555-5555-4555-8555-555555555555',
    expected.requestId,
    expected.payloadDigest,
    expected.creationTokenDigest,
    'c'.repeat(64),
    POLICY_DIGEST,
    keyId,
    'd'.repeat(64),
    now + 60_000,
  ];
  return { challenge, expected, keyId, now, publicKeyBytes, store };
}

describe('task genesis attestation', () => {
  it('signs the exact validated 25-slot server challenge', async () => {
    const { challenge, expected, now, publicKeyBytes, store } = setup();
    const signed = await signTaskGenesisAttestation(store, expected, challenge, now);
    const publicKey = createPublicKey({ key: publicKeyBytes, type: 'spki', format: 'der' });

    expect(signed.payload).toEqual(challenge);
    expect(
      verify(
        null,
        Buffer.from(JSON.stringify(signed.payload), 'utf8'),
        publicKey,
        Buffer.from(signed.signature, 'base64url')
      )
    ).toBe(true);
  });

  it('rejects noncanonical server scope, policy, and expiry challenges', () => {
    const { challenge, expected, now, store } = setup();

    const wrongTask = [...challenge];
    wrongTask[8] = 'TASK-8';
    expect(() => signTaskGenesisAttestation(store, expected, wrongTask, now)).toThrow(
      'Invalid task attestation input'
    );
    const wrongRef = [...challenge];
    wrongRef[11] = 'refs/heads/../main';
    expect(() => signTaskGenesisAttestation(store, expected, wrongRef, now)).toThrow(
      'Invalid task attestation input'
    );
    const invalidRegistryStore = {
      ...expected,
      registryStoreId: 'registry-store-1',
    };
    expect(() => signTaskGenesisAttestation(store, invalidRegistryStore, challenge, now)).toThrow(
      'Invalid task attestation input'
    );

    const wrongPolicy = {
      ...expected,
      policy: { required: true, expectedFilename: 'other.pdf' },
    };
    expect(() => signTaskGenesisAttestation(store, wrongPolicy, challenge, now)).toThrow(
      'Invalid task attestation input'
    );

    const expired = [...challenge];
    expired[24] = now;
    expect(() => signTaskGenesisAttestation(store, expected, expired, now)).toThrow(
      'Invalid task attestation input'
    );
    expect(() => signTaskGenesisAttestation(store, expected, challenge, -1)).toThrow(
      'Invalid task attestation input'
    );
  });
});

describe('task genesis request digest', () => {
  const token = `12345678-1234-4234-8234-123456789abc.${'a'.repeat(64)}`;
  const args = {
    spec: 'demo',
    intent: 'patch',
    requestId: 'req-1',
    reason: 'создать',
    actorRef: null,
    operations: [
      {
        title: 'Привет',
        localId: 'TASK-1',
        document: 'TASKS.md',
        kind: 'upsert_task',
        creationToken: token,
      },
    ],
  };

  it('matches the server canonical vectors and preserves missing versus null', () => {
    expect(taskGenesisRequestDigest('req-1', 'owner/проект', args)).toBe(
      '4cd5fe90ed02394f8c359a2fabe211286c89c7147a3820b0867bb84ef080bf2d'
    );
    expect(
      taskGenesisRequestDigest('req-1', 'owner/проект', {
        ...args,
        project: 'owner/проект',
      })
    ).toBe('4cd5fe90ed02394f8c359a2fabe211286c89c7147a3820b0867bb84ef080bf2d');
    const withoutActorRef: Record<string, unknown> = { ...args };
    delete withoutActorRef.actorRef;
    expect(taskGenesisRequestDigest('req-1', 'owner/проект', withoutActorRef)).toBe(
      'c34131dd880b159dc1d91410c7728e9cf5f06e19f62d5b565ad7d08198dfd3a8'
    );
    expect(
      taskGenesisRequestDigest('req-1', 'owner/проект', {
        ...args,
        genesisAttestations: [{ operationId: 'ignored-by-the-digest' }],
      })
    ).toBe('4cd5fe90ed02394f8c359a2fabe211286c89c7147a3820b0867bb84ef080bf2d');
    const reordered = {
      operations: [
        {
          creationToken: token,
          kind: 'upsert_task',
          document: 'TASKS.md',
          localId: 'TASK-1',
          title: 'Привет',
        },
      ],
      actorRef: null,
      reason: 'создать',
      requestId: 'req-1',
      intent: 'patch',
      spec: 'demo',
    };
    expect(taskGenesisRequestDigest('req-1', 'owner/проект', reordered)).toBe(
      '4cd5fe90ed02394f8c359a2fabe211286c89c7147a3820b0867bb84ef080bf2d'
    );

    expect(taskGenesisRequestDigest('req-1', 'owner/проект', { ...args, force: false })).toBe(
      '8d760550be1f2a50681594753e57987405b91f63a00778ba188a433a29b52efe'
    );
    expect(taskGenesisRequestDigest('req-1', 'owner/проект', { ...args, force: true })).toBe(
      '018d8d8749b6c5c6fa3987d4aa4d906aa4dd13634e1065f9f8284650d28bb95e'
    );
    expect(taskGenesisRequestDigest('req-1', 'owner/проект', { ...args, schemaVersion: '1' })).toBe(
      '3a3334fa659c1e80250641dba6563c28b011de59471cb9cd23c1acd8cc1225ce'
    );

    const numericKeys = { requestId: 'req-1', '2': 'two', '10': 'ten' };
    const reorderedNumericKeys = { '10': 'ten', '2': 'two', requestId: 'req-1' };
    expect(taskGenesisRequestDigest('req-1', 'owner/проект', numericKeys)).toBe(
      taskGenesisRequestDigest('req-1', 'owner/проект', reorderedNumericKeys)
    );
  });

  it('hashes the exact creation token and detects token changes', () => {
    expect(
      taskGenesisRequestDigest('req-1', 'owner/проект', {
        ...args,
        operations: [
          {
            ...args.operations[0],
            creationToken: `${token.slice(0, -1)}b`,
          },
        ],
      })
    ).toBe('6c263fb7348c39c12b995178166276aa28b52bda870085611d38c5b9d92c748c');
  });
});

describe('task lifecycle completion digest', () => {
  it('matches the server canonical-operation digest vector', () => {
    const operation = {
      createdAt: '2026-01-02T03:04:05.000Z',
      generationId: '22222222-2222-4222-8222-222222222222',
      kind: 'GENESIS',
      operationId: '44444444-4444-4444-8444-444444444444',
      ownerPrincipal: 'principal-1',
      project: 'owner/repo',
      reservationId: '55555555-5555-4555-8555-555555555555',
      sequence: 0,
      spec: 'example-spec',
      taskId: 'TASK-7',
      teamId: 'team-1',
      creationTokenDigest: 'a'.repeat(64),
      genesisExpiresAt: 1767323045000,
      genesisKeyId: 'b'.repeat(64),
      genesisNonce: 'c'.repeat(64),
      genesisOrigin: 'SIGNED_GENESIS',
      policy: { expectedFilename: 'proof.pdf', required: true },
      policyDigest: 'd'.repeat(64),
      taskRevisionSha256: 'e'.repeat(64),
    };
    expect(
      taskLifecycleOperationCompletionDigest(
        '33333333-3333-4333-8333-333333333333',
        'f'.repeat(40),
        operation
      )
    ).toBe('d81c4bbb1f37cbfe79512aec131ae7c8134521171ca4ba1b508ba8e152d45d9e');
  });
});
