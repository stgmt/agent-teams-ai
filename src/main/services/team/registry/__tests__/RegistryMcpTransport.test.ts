// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { RegistryMcpTransport } from '../RegistryMcpTransport';
import { RegistryTaskProtocolError } from '../RegistryTaskClientErrors';

const requestId = '11111111-1111-4111-8111-111111111111';
const batchId = '22222222-2222-4222-8222-222222222222';
const operationId = '33333333-3333-4333-8333-333333333333';
const generationId = '44444444-4444-4444-8444-444444444444';
const reservationId = '55555555-5555-4555-8555-555555555555';
const keyId = 'a'.repeat(64);
const nonce = 'b'.repeat(64);
const payloadDigest = 'c'.repeat(64);
const teamId = 'team-1';
const project = 'owner/repository';
const spec = 'task-policy';

function challengePayload(): (string | number | null)[] {
  return [
    'omp-spec-kit/task-genesis-attestation@1',
    'security-store',
    'https://identity.example',
    'user-1',
    teamId,
    'owner-principal',
    project,
    spec,
    'TASK-7',
    generationId,
    'repository',
    'refs/heads/main',
    'a'.repeat(40),
    'd'.repeat(40),
    batchId,
    operationId,
    reservationId,
    requestId,
    payloadDigest,
    'e'.repeat(64),
    'f'.repeat(64),
    '0'.repeat(64),
    keyId,
    nonce,
    Date.now() + 60_000,
  ];
}

function challengeEnvelope(payload: unknown): Record<string, unknown> {
  return {
    schemaVersion: 'spec-mcp-operations-patch@1',
    requestId,
    operation: 'spec_patch',
    ok: false,
    data: {
      outcome: 'CHALLENGE_REQUIRED',
      batchId,
      requestId,
      payloadDigest,
      challenges: [{ operationId, nonce, keyId, payload }],
    },
    error: {
      code: 'TASK_GENESIS_CHALLENGE_REQUIRED',
      message: 'A signed initial task policy is required.',
      retryable: false,
    },
  };
}

function makeTransport(envelope: Record<string, unknown>, authorize?: (headers: Headers) => void) {
  const fetchImpl: typeof fetch = async (_input, init) => {
    authorize?.(new Headers(init?.headers));
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          content: [{ type: 'text', text: JSON.stringify(envelope) }],
        },
      }),
      { status: 200 }
    );
  };
  return new RegistryMcpTransport({
    url: 'https://registry.example/mcp',
    token: 'local-test-token',
    requestTimeoutMs: 1_000,
    fetchImpl,
  });
}

const requestArguments: Record<string, unknown> = {
  requestId,
  project,
  spec,
  operations: [
    {
      kind: 'upsert_task',
      teamId,
      localId: '7',
      policy: { required: true },
    },
  ],
};

async function callChallenge(envelope: Record<string, unknown>): Promise<unknown> {
  return makeTransport(envelope).callTool('spec_patch', requestArguments, 'upsertTask', undefined, {
    allowTaskGenesisChallenge: true,
  });
}

describe('Registry MCP transport initial-policy challenges', () => {
  it('accepts a correctly scoped challenge without changing the authenticated transport', async () => {
    let authorization: string | null = null;
    const transport = makeTransport(challengeEnvelope(challengePayload()), (headers) => {
      authorization = headers.get('Authorization');
    });

    const result = await transport.callTool(
      'spec_patch',
      requestArguments,
      'upsertTask',
      undefined,
      { allowTaskGenesisChallenge: true }
    );

    expect(authorization).toBe('Bearer local-test-token');
    expect(result.data).toMatchObject({
      outcome: 'CHALLENGE_REQUIRED',
      requestId,
      payloadDigest,
    });
  });

  it('fails closed when a challenge contains an unknown payload structure', async () => {
    const payload: unknown[] = challengePayload();
    payload[5] = { unexpected: 'object' };

    await expect(callChallenge(challengeEnvelope(payload))).rejects.toBeInstanceOf(
      RegistryTaskProtocolError
    );
  });

  it('fails closed when a challenge adds unrecognized envelope data', async () => {
    const envelope = challengeEnvelope(challengePayload());
    const data = envelope.data;
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new Error('challenge test fixture must carry an object');
    }

    await expect(
      callChallenge({
        ...envelope,
        data: { ...data, unexpected: true },
      })
    ).rejects.toBeInstanceOf(RegistryTaskProtocolError);
  });
});
