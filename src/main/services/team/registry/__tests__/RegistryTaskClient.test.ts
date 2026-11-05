// @vitest-environment node
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

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

async function startFakeRegistry(
  handler: (call: RecordedCall) => FakeReply
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
    env: {},
  });
}

describe('RegistryTaskClient.listTasks', () => {
  it('reads every task field and forwards the scope to spec_tasks', async () => {
    const registry = await startFakeRegistry(() => ({
      envelope: baseEnvelope({
        kind: 'tasks',
        spec: 'balancer-consistency-hardening',
        count: 1,
        tasks: [
          {
            canonicalId: 'balancer-consistency-hardening:TASK-7',
            localId: 'TASK-7',
            title: 'Pin the PAYG price rule',
            status: 'in-progress',
            owner: 'balancer',
            tracking: 'agent-teams/alpha/8f1d',
            requirements: ['balancer-consistency-hardening:FR-6'],
            dependsOn: ['balancer-consistency-hardening:TASK-3'],
            blocks: ['balancer-consistency-hardening:TASK-9'],
            blockedBy: [],
            refs: ['balancer-consistency-hardening:AC-2'],
            contentHash: 'abc123',
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
        canonicalId: 'balancer-consistency-hardening:TASK-7',
        localId: 'TASK-7',
        title: 'Pin the PAYG price rule',
        status: 'in-progress',
        owner: 'balancer',
        tracking: 'agent-teams/alpha/8f1d',
        requirements: ['balancer-consistency-hardening:FR-6'],
        dependsOn: ['balancer-consistency-hardening:TASK-3'],
        blocks: ['balancer-consistency-hardening:TASK-9'],
        blockedBy: [],
        refs: ['balancer-consistency-hardening:AC-2'],
        contentHash: 'abc123',
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
              tasks: [
                { canonicalId: 'spec-a:TASK-1', localId: 'TASK-1', title: 'first', status: 'todo' },
              ],
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
            tasks: [
              { canonicalId: 'spec-a:TASK-2', localId: 'TASK-2', title: 'second', status: 'done' },
            ],
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
    const missingTokenPath = path.join(
      os.tmpdir(),
      `registry-missing-token-${process.pid}-${Date.now()}.txt`
    );

    const failure = await RegistryTaskClient.create({
      env: {},
      tokenFilePath: missingTokenPath,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RegistryTaskClientConfigError);
    expect((failure as RegistryTaskClientConfigError).code).toBe('MISSING_TOKEN');
  });
});

describe('RegistryTaskClient writes', () => {
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
      project: 'stgmt/tokenplan',
      spec: 'spec-a',
      localId: 'TASK-9',
      title: 'Wire the registry task store',
      requirements: ['spec-a:FR-1'],
      body: 'The kanban reflects the registry task.',
      status: 'todo',
      owner: 'lead',
      tracking: 'agent-teams/alpha/8f1d',
      dependsOn: ['spec-a:TASK-3'],
      refs: ['spec-a:TASK-4'],
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
        document: 'TASKS.md',
        localId: 'TASK-9',
        title: 'Wire the registry task store',
        requirements: ['spec-a:FR-1'],
        body: 'The kanban reflects the registry task.',
        status: 'todo',
        owner: 'lead',
        tracking: 'agent-teams/alpha/8f1d',
        dependsOn: ['spec-a:TASK-3'],
        refs: ['spec-a:TASK-4'],
      },
    ]);
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
      project: 'stgmt/tokenplan',
      spec: 'spec-a',
      entity: 'spec-a:TASK-9',
      owner: 'lead',
    });

    expect(result).toEqual({ outcome: 'UNCHANGED', transitions: [], refusal: null });
    expect(registry.calls[0]?.args.operations).toEqual([
      { kind: 'replace_task_owner', document: 'TASKS.md', entity: 'TASK-9', owner: 'lead' },
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
      .replaceTaskLinks({ project: 'stgmt/tokenplan', spec: 'spec-a', entity: 'TASK-7' })
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
