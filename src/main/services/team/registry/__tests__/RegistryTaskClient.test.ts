// @vitest-environment node
import * as http from 'node:http';

import {
  digestTaskCreationToken,
  taskGenesisRequestDigest,
  taskLifecycleOperationCompletionDigest,
  taskPolicyDigest,
} from '@main/services/identity/TaskAttestation';
import { afterEach, describe, expect, it } from 'vitest';

import { isRecord } from '../RegistryJson';
import { RegistryTaskClient } from '../RegistryTaskClient';
import {
  RegistryStatusConflictError,
  RegistryTaskAuthenticationError,
  RegistryTaskClientConfigError,
  RegistryTaskClientError,
  RegistryTaskTimeoutError,
} from '../RegistryTaskClientErrors';

import type {
  RegistryTaskCompletionReplayRecord,
  RegistryTaskGenesisAttestation,
  RegistryTaskGenesisReplayRecord,
  RegistryTaskLifecycleReceipt,
  RegistryTaskPolicyChangeReplayRecord,
} from '../RegistryTaskClientTypes';

interface RecordedCall {
  authorization: string | undefined;
  toolName: string;
  args: Record<string, unknown>;
}

interface FakeReply {
  status?: number;
  /** Full MCP tool envelope to serialise inside a JSON-RPC result. */
  envelope?: unknown;
  /** Raw body, used for non-JSON failures. */
  bodyText?: string;
  delayMs?: number;
}

interface FakeRegistry {
  url: string;
  calls: RecordedCall[];
  close(): Promise<void>;
}

const openServers: FakeRegistry[] = [];
const TEAM_ID = 'registry-team-alpha';

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
});

function baseEnvelope(data: unknown, page: unknown = null): Record<string, unknown> {
  return {
    schemaVersion: 'spec-kernel@2',
    requestId: null,
    operation: 'test',
    ok: true,
    graph: null,
    page,
    data,
    error: null,
    diagnostics: [],
    provenance: null,
  };
}

function taskEntry(spec: string, id: string, title: string, status: string) {
  return {
    canonicalId: `${spec}:TASK-${id}`,
    specSlug: spec,
    localId: `TASK-${id}`,
    title,
    description: null,
    status,
    estimate: null,
    doneWhen: [],
    refs: [],
    requirements: [],
    dependsOn: [],
    blocks: [],
    blockedBy: [],
    creationToken: null,
    phase: null,
    owner: null,
    tracking: null,
    contentHash: null,
    source: { path: null, startLine: null, startColumn: null, endLine: null, endColumn: null },
  };
}

async function startFakeRegistry(
  handler: (call: RecordedCall) => FakeReply,
  supportsExtendedTasks = true
): Promise<FakeRegistry> {
  const calls: RecordedCall[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed.params)) {
        response.writeHead(400).end('bad rpc request');
        return;
      }
      if (parsed.method === 'tools/list') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: parsed.id,
            result: {
              tools: [
                {
                  name: 'spec_patch',
                  inputSchema: {
                    properties: {
                      operations: {},
                      ...(supportsExtendedTasks
                        ? {
                            force: { type: 'boolean' },
                            genesisAttestations: {
                              type: 'array',
                              items: { type: 'object' },
                            },
                          }
                        : {}),
                    },
                    oneOf: [
                      {
                        properties: {
                          intent: { enum: ['patch'] },
                          operations: {
                            items: {
                              properties: supportsExtendedTasks
                                ? {
                                    description: { type: 'string' },
                                    creationToken: { type: 'string' },
                                    policy: {
                                      type: 'object',
                                      properties: {
                                        required: { type: 'boolean' },
                                        expectedFilename: { type: ['string', 'null'] },
                                      },
                                    },
                                    owner: { type: ['string', 'null'] },
                                    status: { enum: ['deleted'] },
                                    expectedStatus: { enum: ['deleted'] },
                                  }
                                : {
                                    owner: { type: 'string' },
                                    status: { enum: ['todo'] },
                                    expectedStatus: { enum: ['todo'] },
                                  },
                            },
                          },
                        },
                      },
                      { properties: { intent: { enum: ['confirmTaskCreation'] } } },
                    ],
                  },
                },
              ],
            },
          })
        );
        return;
      }
      const call: RecordedCall = {
        authorization: request.headers.authorization,
        toolName: String(parsed.params.name),
        args: isRecord(parsed.params.arguments) ? parsed.params.arguments : {},
      };
      calls.push(call);
      const reply = handler(call);
      const rpcId = parsed.id;
      // Real wall-clock delay: the timeout case must exercise the client's
      // actual deadline, which fake timers cannot do against a live socket.
      setTimeout(() => {
        response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json' });
        if (reply.bodyText !== undefined) {
          response.end(reply.bodyText);
          return;
        }
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: rpcId,
            result: { content: [{ type: 'text', text: JSON.stringify(reply.envelope) }] },
          })
        );
      }, reply.delayMs ?? 0);
    });
  });

  const listening = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  await listening;
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake registry has no port');
  }

  const fake: FakeRegistry = {
    url: `http://127.0.0.1:${address.port}/mcp`,
    calls,
    close: async () => {
      server.closeAllConnections();
      // The project lib is ES2023, so `Promise.withResolvers` is not typed.
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  openServers.push(fake);
  return fake;
}

function makeClient(registry: FakeRegistry, requestTimeoutMs = 2_000): Promise<RegistryTaskClient> {
  return RegistryTaskClient.create({
    url: registry.url,
    token: 'test-token',
    requestTimeoutMs,
  });
}

describe('RegistryTaskClient.listTasks', () => {
  it('fails closed against old registries before writes or deleted reads', async () => {
    const registry = await startFakeRegistry(() => ({ envelope: baseEnvelope({}) }), false);
    const client = await makeClient(registry);
    const scope = { project: 'stgmt/tokenplan', spec: 'spec-a', teamId: TEAM_ID };
    await expect(client.listTasks({ ...scope, statuses: ['deleted'] })).rejects.toThrow('deleted');
    await expect(
      client.upsertTask({
        ...scope,
        localId: '1',
        title: 'Task',
        requirements: ['FR-1'],
        description: 'text',
      })
    ).rejects.toThrow('description');
    await expect(client.replaceTaskOwner({ ...scope, entity: '1', owner: null })).rejects.toThrow(
      'clearOwner'
    );
    await expect(
      client.replaceTaskStatus({ ...scope, entity: '1', status: 'deleted', expectedStatus: 'todo' })
    ).rejects.toThrow('deleted');
    expect(registry.calls).toEqual([]);
  });

  it('returns the registry description and the requested raw body', async () => {
    const description = ' first\n## TASK-99: text\n**Status:** done\n';
    const body = `- **Status:** deleted\n${description}`;
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({
        kind: 'tasks',
        spec: 'spec-a',
        tasks: [
          {
            ...taskEntry('spec-a', '1', 'Task', 'deleted'),
            owner: null,
            description,
            body,
            requirements: [],
            dependsOn: [],
            blocks: [],
            blockedBy: [],
            refs: [],
          },
        ],
      }),
    }));
    const client = await makeClient(registry);
    const tasks = await client.listTasks({
      project: 'stgmt/tokenplan',
      spec: 'spec-a',
      includeBodies: true,
    });
    expect(tasks[0]).toMatchObject({ status: 'deleted', description, body });
    expect(registry.calls.map((call) => call.toolName)).toEqual(['spec_tasks']);
  });

  it('rejects a review value the canonical contract does not define', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({
        kind: 'tasks',
        spec: 'balancer-consistency-hardening',
        count: 1,
        tasks: [
          {
            ...taskEntry(
              'balancer-consistency-hardening',
              '7',
              'Pin the PAYG price rule',
              'in-progress'
            ),
            review: 'almost-approved',
          },
        ],
      }),
    }));
    const client = await makeClient(registry);

    await expect(
      client.listTasks({ project: 'stgmt/tokenplan', spec: 'balancer-consistency-hardening' })
    ).rejects.toThrow(/task review has an unknown value/u);
  });

  it('reads every task field and forwards the scope to spec_tasks', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({
        kind: 'tasks',
        spec: 'balancer-consistency-hardening',
        count: 1,
        tasks: [
          {
            ...taskEntry(
              'balancer-consistency-hardening',
              '7',
              'Pin the PAYG price rule',
              'in-progress'
            ),
            owner: 'balancer',
            tracking: 'agent-teams/alpha/8f1d',
            requirements: ['balancer-consistency-hardening:FR-6'],
            dependsOn: ['balancer-consistency-hardening:TASK-3'],
            blocks: ['balancer-consistency-hardening:TASK-9'],
            blockedBy: [],
            refs: ['balancer-consistency-hardening:AC-2'],
            contentHash: 'abc123',
            review: 'approved',
          },
        ],
      }),
    }));
    const client = await makeClient(registry);

    const tasks = await client.listTasks({
      project: 'stgmt/tokenplan',
      spec: 'balancer-consistency-hardening',
      statuses: ['todo', 'in-progress'],
    });

    expect(tasks).toEqual([
      {
        ...taskEntry(
          'balancer-consistency-hardening',
          '7',
          'Pin the PAYG price rule',
          'in-progress'
        ),
        owner: 'balancer',
        tracking: 'agent-teams/alpha/8f1d',
        requirements: ['balancer-consistency-hardening:FR-6'],
        dependsOn: ['balancer-consistency-hardening:TASK-3'],
        blocks: ['balancer-consistency-hardening:TASK-9'],
        blockedBy: [],
        refs: ['balancer-consistency-hardening:AC-2'],
        contentHash: 'abc123',
        review: 'approved',
      },
    ]);
    expect(registry.calls).toHaveLength(1);
    expect(registry.calls[0]?.toolName).toBe('spec_tasks');
    expect(registry.calls[0]?.authorization).toBe('Bearer test-token');
    expect(registry.calls[0]?.args).toMatchObject({
      schemaVersion: 'spec-kernel@2',
      project: 'stgmt/tokenplan',
      spec: 'balancer-consistency-hardening',
      statuses: ['todo', 'in-progress'],
    });
  });

  it('follows the registry cursor to the last page', async () => {
    const registry = await startFakeRegistry((call) => {
      if (call.args.cursor === undefined) {
        return {
          envelope: baseEnvelope(
            {
              kind: 'tasks',
              spec: 'spec-a',
              count: 1,
              tasks: [taskEntry('spec-a', '1', 'first', 'todo')],
            },
            {
              limit: 50,
              returned: 1,
              totalMatched: 2,
              cursor: null,
              nextCursor: 'page-2',
              truncated: false,
            }
          ),
        };
      }
      return {
        envelope: baseEnvelope(
          {
            kind: 'tasks',
            spec: 'spec-a',
            count: 1,
            tasks: [taskEntry('spec-a', '2', 'second', 'done')],
          },
          {
            limit: 50,
            returned: 1,
            totalMatched: 2,
            cursor: 'page-2',
            nextCursor: null,
            truncated: false,
          }
        ),
      };
    });
    const client = await makeClient(registry);

    const tasks = await client.listTasks({ project: 'stgmt/tokenplan', spec: 'spec-a' });

    expect(tasks.map((task) => task.localId)).toEqual(['TASK-1', 'TASK-2']);
    expect(registry.calls).toHaveLength(2);
    expect(registry.calls[1]?.args.cursor).toBe('page-2');
  });

  it('loads raw task bodies from paginated spec_tasks responses', async () => {
    const registry = await startFakeRegistry((call) => {
      const second = call.args.cursor === 'next';
      return {
        envelope: baseEnvelope(
          {
            kind: 'tasks',
            spec: 'spec-a',
            count: 1,
            tasks: [
              {
                ...taskEntry(
                  'spec-a',
                  second ? '2' : '1',
                  second ? 'second' : 'first',
                  second ? 'done' : 'todo'
                ),
                body: second
                  ? '- **Status:** done'
                  : '- **Done When:** Keep commas, semicolons; and text.',
              },
            ],
          },
          { nextCursor: second ? null : 'next' }
        ),
      };
    });
    const client = await makeClient(registry);
    const tasks = await client.listTasks({
      project: 'stgmt/tokenplan',
      spec: 'spec-a',
      includeBodies: true,
    });
    expect(tasks.map((task) => task.body)).toEqual([
      '- **Done When:** Keep commas, semicolons; and text.',
      '- **Status:** done',
    ]);
    expect(registry.calls).toHaveLength(2);
    expect(registry.calls[0]).toMatchObject({
      toolName: 'spec_tasks',
      args: { includeComments: true },
    });
    expect(registry.calls[1]).toMatchObject({
      toolName: 'spec_tasks',
      args: { cursor: 'next', includeComments: true },
    });
  });

  it('rejects a missing raw task body when includeComments was requested', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({
        kind: 'tasks',
        spec: 'spec-a',
        tasks: [taskEntry('spec-a', '1', 'first', 'todo')],
      }),
    }));
    const client = await makeClient(registry);
    await expect(
      client.listTasks({
        project: 'stgmt/tokenplan',
        spec: 'spec-a',
        includeBodies: true,
      })
    ).rejects.toThrow('omitted raw task body');
  });
});

describe('RegistryTaskClient failures', () => {
  it('maps HTTP 401 to a typed authentication error', async () => {
    const registry = await startFakeRegistry(() => ({
      status: 401,
      bodyText: 'unauthorized',
    }));
    const client = await makeClient(registry);

    const failure = await client
      .listTasks({ project: 'stgmt/tokenplan', spec: 'spec-a' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RegistryTaskAuthenticationError);
    expect((failure as RegistryTaskAuthenticationError).code).toBe('UNAUTHORIZED');
    expect((failure as RegistryTaskAuthenticationError).status).toBe(401);
  });

  it('fails closed with a typed timeout instead of waiting forever', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({ kind: 'tasks', spec: 'spec-a', count: 0, tasks: [] }),
      delayMs: 300,
    }));
    const client = await makeClient(registry, 50);

    const failure = await client
      .listTasks({ project: 'stgmt/tokenplan', spec: 'spec-a' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RegistryTaskTimeoutError);
    expect((failure as RegistryTaskTimeoutError).code).toBe('TIMEOUT');
    expect((failure as RegistryTaskTimeoutError).timeoutMs).toBe(50);
  });

  it('refuses to run without a token and never touches the network', async () => {
    const failure = await RegistryTaskClient.create({
      token: null,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RegistryTaskClientConfigError);
    expect((failure as RegistryTaskClientConfigError).code).toBe('MISSING_TOKEN');
  });

  it('uses explicitly injected client credentials without a runtime token-file lookup', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({ kind: 'tasks', spec: 'spec-a', count: 0, tasks: [] }),
    }));
    const client = await RegistryTaskClient.create({
      url: registry.url,
      token: 'unit-injected-token',
    });
    await client.listTasks({ project: 'sandbox/demo', spec: 'spec-a' });
    expect(registry.calls[0].authorization).toBe('Bearer unit-injected-token');
  });
});

describe('RegistryTaskClient writes', () => {
  it('reads the tasks document preimage and rejects malformed hashes', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({ sha256: 'b'.repeat(64) }),
    }));
    const client = await makeClient(registry);
    await expect(
      client.readTasksDocumentSha({ project: 'stgmt/tokenplan', spec: 'spec-a' })
    ).resolves.toBe('b'.repeat(64));
    expect(registry.calls[0]).toMatchObject({
      toolName: 'spec_documents',
      args: {
        action: 'read',
        project: 'stgmt/tokenplan',
        spec: 'spec-a',
        doc: 'TASKS.md',
      },
    });
    const badRegistry = await startFakeRegistry(() => ({ envelope: baseEnvelope({ sha256: '' }) }));
    const badClient = await makeClient(badRegistry);
    await expect(
      badClient.readTasksDocumentSha({ project: 'stgmt/tokenplan', spec: 'spec-a' })
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('returns APPLIED with the registry transition receipt for upsertTask', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: {
        ...baseEnvelope({
          schemaVersion: 'spec-mcp-operations-patch@1',
          requestId: 'req-1',
          dryRun: false,
          proposalHash: 'hash-1',
          outcome: 'APPLIED',
          transitions: [
            {
              requestId: 'req-1',
              localId: 'TASK-9',
              from: null,
              to: 'todo',
              actor: 'admin',
              at: '2026-11-05T00:00:00.000Z',
            },
          ],
          receipt: { outcome: 'APPLIED' },
        }),
      },
    }));
    const client = await makeClient(registry);

    const result = await client.upsertTask({
      teamId: TEAM_ID,
      project: 'stgmt/tokenplan',
      spec: 'spec-a',
      localId: 'TASK-9',
      title: 'Wire the registry task store',
      requirements: ['spec-a:FR-1'],
      body: 'The kanban reflects the registry task.',
      description: ' first\n## TASK-99\n',
      status: 'todo',
      owner: 'lead',
      tracking: 'agent-teams/alpha/8f1d',
      dependsOn: ['spec-a:TASK-3'],
      refs: ['spec-a:TASK-4'],
      expectedSha: 'a'.repeat(64),
    });

    expect(result).toEqual({
      outcome: 'APPLIED',
      transitions: [
        {
          localId: 'TASK-9',
          from: null,
          to: 'todo',
          requestId: 'req-1',
          actor: 'admin',
          at: '2026-11-05T00:00:00.000Z',
        },
      ],
      refusal: null,
    });
    const writeCall = registry.calls[0];
    expect(writeCall?.toolName).toBe('spec_patch');
    expect(writeCall?.args).toMatchObject({
      schemaVersion: 'spec-kernel@2',
      intent: 'patch',
      project: 'stgmt/tokenplan',
      spec: 'spec-a',
      dryRun: false,
    });
    expect(typeof writeCall?.args.requestId).toBe('string');
    expect(writeCall?.args.reason).toContain('upsert_task');
    expect(writeCall?.args.operations).toEqual([
      {
        kind: 'upsert_task',
        teamId: TEAM_ID,
        document: 'TASKS.md',
        localId: 'TASK-9',
        title: 'Wire the registry task store',
        requirements: ['spec-a:FR-1'],
        body: 'The kanban reflects the registry task.',
        description: ' first\n## TASK-99\n',
        status: 'todo',
        owner: 'lead',
        tracking: 'agent-teams/alpha/8f1d',
        dependsOn: ['spec-a:TASK-3'],
        refs: ['spec-a:TASK-4'],
        expectedSha: 'a'.repeat(64),
      },
    ]);
  });

  it('binds a signed GENESIS replay to the exact transported request and final lifecycle receipt', async () => {
    const identity = {
      securityStoreId: '10000000-0000-4000-8000-000000000001',
      idp: 'local-idp',
      userId: 'operator',
    };
    const scope = { project: 'stgmt/tokenplan', spec: 'spec-a', teamId: TEAM_ID };
    const policy = { required: true, expectedFilename: 'proof.pdf' };
    const requestId = '20000000-0000-4000-8000-000000000002';
    const batchId = '30000000-0000-4000-8000-000000000003';
    const operationId = '40000000-0000-4000-8000-000000000004';
    const generationId = '50000000-0000-4000-8000-000000000005';
    const reservationId = '60000000-0000-4000-8000-000000000006';
    const keyId = 'e'.repeat(64);
    const nonce = 'f'.repeat(64);
    const parentOid = '1'.repeat(40);
    const commitOid = '2'.repeat(40);
    const taskRevisionSha256 = 'a'.repeat(64);
    const creationToken = 'opaque-genesis-token';
    const taskId = 'TASK-8';
    let requestDigest = '';
    let genesisPayload: readonly (string | number | null)[] | undefined;
    let signedAttempts = 0;
    let finalized = false;
    const registry = await startFakeRegistry((call) => {
      const currentRequestId = String(call.args.requestId);
      const currentProject = String(call.args.project);
      requestDigest = taskGenesisRequestDigest(currentRequestId, currentProject, call.args);
      if (Array.isArray(call.args.genesisAttestations)) {
        signedAttempts += 1;
        if (signedAttempts === 1) {
          finalized = true;
          return { bodyText: 'reply lost after registry commit' };
        }
        if (!finalized || !genesisPayload) {
          throw new Error('expected an exact replay of the finalized GENESIS request');
        }
        const operation = {
          createdAt: '2026-11-08T00:00:00.000Z',
          generationId,
          kind: 'GENESIS' as const,
          operationId,
          ownerPrincipal: 'owner-principal',
          project: scope.project,
          reservationId,
          sequence: 0,
          spec: scope.spec,
          taskId,
          teamId: TEAM_ID,
          creationTokenDigest: digestTaskCreationToken(creationToken),
          genesisExpiresAt: genesisPayload[24] as number,
          genesisKeyId: keyId,
          genesisNonce: nonce,
          genesisOrigin: 'SIGNED_GENESIS' as const,
          policy,
          policyDigest: taskPolicyDigest(policy),
          taskRevisionSha256,
        };
        const completionDigest = taskLifecycleOperationCompletionDigest(
          batchId,
          commitOid,
          operation
        );
        return {
          envelope: {
            ...baseEnvelope({
              schemaVersion: 'spec-mcp-operations-patch@1',
              requestId: currentRequestId,
              dryRun: false,
              proposalHash: 'proposal',
              outcome: 'APPLIED',
              transitions: [],
              taskLifecycleReceipt: {
                schemaVersion: 'omp-spec-kit/task-lifecycle-receipt@1',
                kind: 'TASK_LIFECYCLE_FINALIZATION_RECEIPT',
                batchId,
                project: scope.project,
                repo: 'repository',
                ref: 'refs/heads/main',
                expectedParent: parentOid,
                commit: commitOid,
                observedCommit: commitOid,
                requestId: currentRequestId,
                payloadDigest: requestDigest,
                operations: [
                  {
                    sequence: 0,
                    operationId,
                    kind: 'GENESIS',
                    commit: commitOid,
                    digest: completionDigest,
                    outcome: 'FINALIZED',
                    project: scope.project,
                    spec: scope.spec,
                    taskId,
                    teamId: TEAM_ID,
                    generationId,
                    policyDigest: taskPolicyDigest(policy),
                    creationTokenDigest: digestTaskCreationToken(creationToken),
                    operation,
                  },
                ],
              },
            }),
            operation: 'spec_patch',
            requestId: currentRequestId,
          },
        };
      }
      const operation = Array.isArray(call.args.operations) ? call.args.operations[0] : null;
      if (!isRecord(operation) || !isRecord(operation.policy)) {
        throw new Error('expected one policy-bearing upsert operation');
      }
      const payload = [
        'omp-spec-kit/task-genesis-attestation@1',
        identity.securityStoreId,
        identity.idp,
        identity.userId,
        TEAM_ID,
        'owner-principal',
        scope.project,
        scope.spec,
        taskId,
        generationId,
        'repository',
        'refs/heads/main',
        parentOid,
        commitOid,
        batchId,
        operationId,
        reservationId,
        currentRequestId,
        requestDigest,
        digestTaskCreationToken(creationToken),
        taskRevisionSha256,
        taskPolicyDigest(
          operation.policy as { required: boolean; expectedFilename?: string | null }
        ),
        keyId,
        nonce,
        Date.now() + 60_000,
      ];
      genesisPayload = payload;
      return {
        envelope: {
          ...baseEnvelope({
            outcome: 'CHALLENGE_REQUIRED',
            batchId,
            requestId: currentRequestId,
            payloadDigest: requestDigest,
            challenges: [{ operationId, nonce, keyId, payload }],
          }),
          ok: false,
          operation: 'spec_patch',
          requestId: currentRequestId,
          error: {
            code: 'TASK_GENESIS_CHALLENGE_REQUIRED',
            message: 'A signed initial task policy is required.',
            retryable: false,
          },
        },
      };
    });
    const client = await makeClient(registry);
    const input = {
      ...scope,
      localId: '8',
      title: 'Protected task',
      requirements: ['FR-1'],
      creationToken,
      requestId,
      policy,
      expectedRegistrationIdentity: identity,
      expectedSha: 'b'.repeat(64),
      force: false,
    };

    const challengeResult = await client.upsertTask(input);
    if (challengeResult.outcome !== 'CHALLENGE_REQUIRED') {
      throw new Error('expected the registry to reserve a GENESIS challenge');
    }
    const challenge = challengeResult.challenge.challenges[0];
    expect(challenge).toBeDefined();
    expect(challengeResult.expected.payloadDigest).toBe(requestDigest);
    expect(challengeResult.challenge.payloadDigest).toBe(requestDigest);
    const signature = Buffer.alloc(64, 7).toString('base64url');
    const attestation: RegistryTaskGenesisAttestation = {
      ...challenge,
      signature,
    };
    const replayRecords: RegistryTaskGenesisReplayRecord[] = [];
    await expect(
      client.upsertTask({
        ...input,
        genesisChallenge: challengeResult.challenge,
        beforeGenesisAttestationSend: (record) => {
          replayRecords.push(record);
        },
        genesisAttestations: [attestation],
      })
    ).rejects.toBeInstanceOf(RegistryTaskClientError);
    expect(replayRecords).toHaveLength(1);
    const replay = replayRecords[0];
    const replayOperation = (
      replay.requestArguments.operations as Array<Record<string, unknown>>
    )[0];
    expect(replayOperation.expectedSha).toBe(input.expectedSha);
    const completion = await client.replayTaskGenesisRequest({
      replay,
      expectedRegistrationIdentity: identity,
    });

    expect(completion.outcome).toBe('APPLIED');
    const successfulReceipt = completion.taskLifecycleReceipt;
    if (!successfulReceipt) throw new Error('expected final lifecycle receipt');
    const forgedReceipt = JSON.parse(
      JSON.stringify(successfulReceipt)
    ) as RegistryTaskLifecycleReceipt;
    const forgedOperation = forgedReceipt.operations[0] as unknown as { digest: string };
    forgedOperation.digest = '0'.repeat(64);
    const expectInvalidReceipt = async (
      invalidReceipt: RegistryTaskLifecycleReceipt
    ): Promise<void> => {
      const invalidRegistry = await startFakeRegistry((call) => ({
        envelope: {
          ...baseEnvelope({
            schemaVersion: 'spec-mcp-operations-patch@1',
            requestId: String(call.args.requestId),
            dryRun: false,
            proposalHash: 'proposal',
            outcome: 'APPLIED',
            transitions: [],
            taskLifecycleReceipt: invalidReceipt,
          }),
          operation: 'spec_patch',
          requestId: String(call.args.requestId),
        },
      }));
      const invalidClient = await makeClient(invalidRegistry);
      await expect(
        invalidClient.replayTaskGenesisRequest({
          replay,
          expectedRegistrationIdentity: identity,
        })
      ).rejects.toBeInstanceOf(RegistryTaskClientError);
    };
    await expectInvalidReceipt(forgedReceipt);
    const mismatchedProjection = JSON.parse(
      JSON.stringify(successfulReceipt)
    ) as RegistryTaskLifecycleReceipt;
    const mismatchedOperation = mismatchedProjection.operations[0] as unknown as {
      digest: string;
      operation: Record<string, unknown>;
    };
    mismatchedOperation.operation.taskId = 'TASK-99';
    mismatchedOperation.digest = taskLifecycleOperationCompletionDigest(
      mismatchedProjection.batchId,
      mismatchedProjection.commit,
      mismatchedOperation.operation
    );
    await expectInvalidReceipt(mismatchedProjection);
    expect(completion.taskLifecycleReceipt).toMatchObject({
      batchId,
      commit: commitOid,
      operations: [
        {
          kind: 'GENESIS',
          spec: scope.spec,
          taskId,
          teamId: TEAM_ID,
          outcome: 'FINALIZED',
        },
      ],
    });
    const [firstCall, signedCall, replayCall] = registry.calls;
    expect(firstCall?.args.schemaVersion).toBe('spec-kernel@2');
    expect(firstCall?.args.force).toBe(false);
    expect(signedCall?.args.requestId).toBe(firstCall?.args.requestId);
    expect(signedCall?.args).toEqual(replay.requestArguments);
    expect(replayCall?.args).toEqual(signedCall?.args);
    for (const call of [firstCall, signedCall, replayCall]) {
      expect(
        taskGenesisRequestDigest(String(call?.args.requestId), scope.project, call?.args)
      ).toBe(requestDigest);
    }
    expect(taskGenesisRequestDigest(requestId, scope.project, replayCall?.args)).toBe(
      requestDigest
    );
    const tampered = JSON.parse(JSON.stringify(replay)) as RegistryTaskGenesisReplayRecord;
    const tamperedArguments = tampered.requestArguments as unknown as {
      operations: Array<Record<string, unknown>>;
    };
    tamperedArguments.operations[0].expectedSha = 'c'.repeat(64);
    tamperedArguments.operations[0].title = 'different signed title';
    const callsBeforeTamperedReplay = registry.calls.length;
    await expect(
      client.replayTaskGenesisRequest({
        replay: tampered,
        expectedRegistrationIdentity: identity,
      })
    ).rejects.toBeInstanceOf(RegistryTaskClientError);
    expect(registry.calls).toHaveLength(callsBeforeTamperedReplay);
  });

  it('reports UNCHANGED without inventing a transition', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({
        schemaVersion: 'spec-mcp-operations-patch@1',
        requestId: 'req-2',
        dryRun: false,
        proposalHash: 'hash-2',
        outcome: 'UNCHANGED',
        unchanged: true,
        transitions: [],
      }),
    }));
    const client = await makeClient(registry);

    const result = await client.replaceTaskOwner({
      teamId: TEAM_ID,
      project: 'stgmt/tokenplan',
      spec: 'spec-a',
      entity: 'spec-a:TASK-9',
      owner: 'lead',
    });

    expect(result).toEqual({ outcome: 'UNCHANGED', transitions: [], refusal: null });
    expect(registry.calls[0]?.args.operations).toEqual([
      {
        kind: 'replace_task_owner',
        document: 'TASKS.md',
        teamId: TEAM_ID,
        entity: 'TASK-9',
        owner: 'lead',
      },
    ]);
  });
  it('sends null to unassign an owner', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({
        schemaVersion: 'spec-mcp-operations-patch@1',
        requestId: 'req-clear',
        dryRun: false,
        proposalHash: 'hash',
        outcome: 'APPLIED',
        transitions: [],
      }),
    }));
    const client = await makeClient(registry);
    await client.replaceTaskOwner({
      teamId: TEAM_ID,
      project: 'stgmt/tokenplan',
      spec: 'spec-a',
      entity: 'TASK-1',
      owner: null,
    });
    expect(registry.calls[0]?.args.operations).toEqual([
      {
        kind: 'replace_task_owner',
        document: 'TASKS.md',
        teamId: TEAM_ID,
        entity: 'TASK-1',
        owner: null,
      },
    ]);
  });

  it('throws STATUS_CONFLICT with currentStatus when expectedStatus lost the race', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({
        schemaVersion: 'spec-mcp-operations-patch@1',
        requestId: 'req-3',
        dryRun: false,
        proposalHash: 'hash-3',
        outcome: 'REFUSED',
        transitions: [],
        error: {
          code: 'STATUS_CONFLICT',
          message: 'task TASK-7 is in status done, expected todo',
          retryable: false,
          localId: 'TASK-7',
          currentStatus: 'done',
          expectedStatus: 'todo',
        },
      }),
    }));
    const client = await makeClient(registry);

    const failure = await client
      .replaceTaskStatus({
        teamId: TEAM_ID,
        project: 'stgmt/tokenplan',
        spec: 'spec-a',
        entity: 'TASK-7',
        status: 'in-progress',
        expectedStatus: 'todo',
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RegistryStatusConflictError);
    const conflict = failure as RegistryStatusConflictError;
    expect(conflict.code).toBe('STATUS_CONFLICT');
    expect(conflict.currentStatus).toBe('done');
    expect(conflict.expectedStatus).toBe('todo');
    expect(conflict.localId).toBe('TASK-7');
    expect(registry.calls[0]?.args.operations).toEqual([
      {
        kind: 'replace_task_status',
        document: 'TASKS.md',
        teamId: TEAM_ID,
        entity: 'TASK-7',
        status: 'in-progress',
        expectedStatus: 'todo',
      },
    ]);
  });

  it('rejects replaceTaskLinks without a single link list before any request', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({ outcome: 'APPLIED', transitions: [] }),
    }));
    const client = await makeClient(registry);

    const failure = await client
      .replaceTaskLinks({
        project: 'stgmt/tokenplan',
        spec: 'spec-a',
        teamId: TEAM_ID,
        entity: 'TASK-7',
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RegistryTaskClientError);
    expect((failure as RegistryTaskClientError).code).toBe('INVALID_ARGUMENT');
    expect(registry.calls).toHaveLength(0);
  });

  it('refuses a canonical entity that belongs to another spec', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({ outcome: 'APPLIED', transitions: [] }),
    }));
    const client = await makeClient(registry);

    const failure = await client
      .replaceTaskOwner({
        teamId: TEAM_ID,
        project: 'stgmt/tokenplan',
        spec: 'spec-a',
        entity: 'other-spec:TASK-7',
        owner: 'lead',
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RegistryTaskClientError);
    expect((failure as RegistryTaskClientError).code).toBe('INVALID_ARGUMENT');
    expect(registry.calls).toHaveLength(0);
  });
});
