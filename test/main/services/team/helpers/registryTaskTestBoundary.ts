import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { ExecutionTaskStore } from '../../../../../src/main/services/team/execution/ExecutionTaskStore';
import { RegistryTaskClient } from '../../../../../src/main/services/team/registry/RegistryTaskClient';
import { RegistryTaskProvider } from '../../../../../src/main/services/team/registry/RegistryTaskProvider';
import { TeamTaskReader } from '../../../../../src/main/services/team/TeamTaskReader';

import type { RegistryTask, RegistryTaskStatus } from '../../../../../src/main/services/team/registry/RegistryTaskClientTypes';
import type { TeamTask } from '../../../../../src/shared/types';

const PROJECT = 'sandbox/project';
const SPEC = 'sandbox-spec';
const TOKEN = 'isolated-registry-test-token';
const TEAM_CONFIG = { specProject: PROJECT, specSlug: SPEC };

export interface RegistryTaskTestBoundary {
  taskReader: TeamTaskReader;
  executionStore: ExecutionTaskStore;
  replaceTasks(tasks: readonly TeamTask[]): Promise<void>;
  dispose(): Promise<void>;
}

function toRegistryStatus(status: TeamTask['status']): RegistryTaskStatus {
  switch (status) {
    case 'in_progress':
      return 'in-progress';
    case 'completed':
      return 'done';
    case 'deleted':
      return 'deleted';
    default:
      return 'todo';
  }
}

function toRegistryTask(task: TeamTask): RegistryTask {
  if (!/^[1-9][0-9]*$/.test(task.id)) {
    throw new Error(`Registry fixtures require numeric task ids, received ${task.id}.`);
  }
  return {
    canonicalId: `${SPEC}:TASK-${task.id}`,
    localId: task.id,
    title: task.subject,
    description: task.description ?? '',
    status: toRegistryStatus(task.status),
    owner: task.owner ?? null,
    tracking: null,
    requirements: [],
    dependsOn: (task.blockedBy ?? []).map((id) => `${SPEC}:TASK-${id}`),
    blocks: (task.blocks ?? []).map((id) => `${SPEC}:TASK-${id}`),
    blockedBy: (task.blockedBy ?? []).map((id) => `${SPEC}:TASK-${id}`),
    refs: (task.related ?? []).map((id) => `${SPEC}:TASK-${id}`),
    contentHash: null,
  };
}

function taskStatusValues(values: unknown): Set<string> | null {
  return Array.isArray(values) && values.every((value) => typeof value === 'string')
    ? new Set(values)
    : null;
}

function sendRpc(response: http.ServerResponse, id: unknown, result: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

/**
 * Provides actual RegistryTaskClient/RegistryTaskProvider/TeamTaskReader reads against an
 * isolated local MCP endpoint. Canonical fields live in its spec_tasks response; only
 * execution metadata is written to the temporary execution-task store.
 */
export async function createRegistryTaskTestBoundary(args: {
  teamName: string;
  tasks?: readonly TeamTask[];
}): Promise<RegistryTaskTestBoundary> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'registry-task-test-boundary-'));
  const executionStore = new ExecutionTaskStore({ basePath: path.join(tempDir, 'tasks-local') });
  let registryTasks: RegistryTask[] = [];

  const seedExecutionFields = (tasks: readonly TeamTask[]): void => {
    for (const task of tasks) {
      const patch = {
        ...(task.workIntervals === undefined ? {} : { workIntervals: task.workIntervals }),
        ...(task.reviewIntervals === undefined ? {} : { reviewIntervals: task.reviewIntervals }),
        ...(task.historyEvents === undefined ? {} : { historyEvents: task.historyEvents }),
        ...(task.comments === undefined ? {} : { comments: task.comments }),
        ...(task.attachments === undefined ? {} : { attachments: task.attachments }),
        ...(task.needsClarification === undefined ? {} : { needsClarification: task.needsClarification }),
      };
      if (Object.keys(patch).length > 0) {
        executionStore.write(args.teamName, task.id, patch);
      }
    }
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    const origin = request.headers.origin;
    if (origin) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-methods': 'POST, OPTIONS',
        'access-control-allow-headers':
          request.headers['access-control-request-headers'] ?? 'authorization, content-type',
        'access-control-max-age': '600',
      }).end();
      return;
    }
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      if (request.headers.authorization !== `Bearer ${TOKEN}`) {
        response.writeHead(401).end();
        return;
      }
      let rpc: unknown;
      try {
        rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400).end('invalid JSON-RPC request');
        return;
      }
      if (!rpc || typeof rpc !== 'object' || !('id' in rpc)) {
        response.writeHead(400).end('invalid JSON-RPC request');
        return;
      }
      const requestId = (rpc as { id: unknown }).id;
      const method = (rpc as { method?: unknown }).method;
      const params = (rpc as { params?: unknown }).params;
      if (method === 'tools/list') {
        sendRpc(response, requestId, {
          tools: [{
            name: 'spec_patch',
            inputSchema: {
              oneOf: [{
                properties: {
                  intent: { enum: ['patch'] },
                  operations: {
                    items: {
                      properties: {
                        status: { enum: ['todo', 'in-progress', 'done', 'deleted'] },
                        expectedStatus: { enum: ['todo', 'in-progress', 'done', 'deleted'] },
                      },
                    },
                  },
                },
              }],
            },
          }],
        });
        return;
      }
      if (method !== 'tools/call' || !params || typeof params !== 'object') {
        sendRpc(response, requestId, null, 404);
        return;
      }
      const call = params as { name?: unknown; arguments?: unknown };
      const input = call.arguments && typeof call.arguments === 'object'
        ? call.arguments as Record<string, unknown>
        : {};
      if (call.name !== 'spec_tasks') {
        sendRpc(response, requestId, {
          content: [{ type: 'text', text: JSON.stringify({
            schemaVersion: 'spec-kernel@2', operation: 'test', ok: false,
            data: null, error: { code: 'UNKNOWN_TOOL', message: 'unsupported test tool' },
          }) }],
        });
        return;
      }
      const statuses = taskStatusValues(input.statuses);
      const tasks = registryTasks.filter((task) => statuses === null || statuses.has(task.status));
      sendRpc(response, requestId, {
        content: [{ type: 'text', text: JSON.stringify({
          schemaVersion: 'spec-kernel@2',
          requestId: null,
          operation: 'listTasks',
          ok: true,
          page: {
            limit: null,
            returned: tasks.length,
            totalMatched: tasks.length,
            cursor: null,
            nextCursor: null,
            truncated: false,
          },
          data: { kind: 'tasks', spec: SPEC, count: tasks.length, tasks },
          error: null,
          diagnostics: [],
          provenance: null,
        }) }],
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
    throw new Error('Isolated test registry did not bind TCP.');
  }

  const client = RegistryTaskClient.fromConfig({
    url: `http://127.0.0.1:${address.port}/mcp`,
    token: TOKEN,
    requestTimeoutMs: 2_000,
  });
  const provider = new RegistryTaskProvider({
    readConfig: async () => TEAM_CONFIG,
    clientFactory: async () => client,
    executionStore,
    cacheTtlMs: 0,
  });
  const taskReader = new TeamTaskReader(undefined, provider);

  const replaceTasks = async (tasks: readonly TeamTask[]): Promise<void> => {
    registryTasks = tasks.map(toRegistryTask);
    seedExecutionFields(tasks);
  };

  try {
    await replaceTasks(args.tasks ?? []);
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }

  return {
    taskReader,
    executionStore,
    replaceTasks,
    dispose: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
