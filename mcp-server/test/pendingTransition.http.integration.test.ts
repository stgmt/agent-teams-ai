import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { startStdioAppControlFixture, type StdioAppControlFixture } from './stdioAppControlFixture';

const require = createRequire(import.meta.url);
const { createController } = require('../../agent-teams-controller/src/index.js');
const taskStore = require('../../agent-teams-controller/src/internal/taskStore.js');
let fixture = '';
let child: ChildProcess | undefined;
let appControl: StdioAppControlFixture | undefined;
let specRegistry: http.Server | undefined;

afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const activeChild = child;
    await new Promise<void>((resolve) => {
      activeChild.once('exit', () => resolve());
      activeChild.kill();
      if (activeChild.exitCode !== null || activeChild.signalCode !== null) resolve();
    });
  }
  child = undefined;
  await appControl?.close();
  appControl = undefined;
  if (specRegistry) {
    specRegistry.closeAllConnections();
    const closed = once(specRegistry, 'close');
    specRegistry.close();
    await closed;
    specRegistry = undefined;
  }
  if (fixture) {
    const target = path.resolve(fixture);
    if (
      !target.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
      !path.basename(target).startsWith('mcp-kanban-http-')
    ) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    fixture = '';
  }
});

/**
 * A full MCP session discovers the spec registry before it reports ready, so the
 * child needs a registry answering the MCP handshake and one-tool discovery.
 */
async function startSpecRegistry(): Promise<string> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
        id?: number;
        method?: string;
      };
      const reply = (result: unknown) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
      };
      if (body.method === 'initialize') {
        response.setHeader('mcp-session-id', 'fixture-session');
        reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'registry-fixture', version: '1' },
        });
        return;
      }
      if (body.method === 'notifications/initialized') {
        response.writeHead(202);
        response.end();
        return;
      }
      reply({
        tools: [
          {
            name: 'spec_catalog',
            description: 'List specifications',
            inputSchema: {
              type: 'object',
              additionalProperties: false,
              properties: { project: { type: 'string' } },
              required: ['project'],
            },
          },
        ],
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  specRegistry = server;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Registry fixture did not bind');
  return `http://127.0.0.1:${address.port}/mcp`;
}

async function allocatePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  const port = address.port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('pending review transition over MCP HTTP', () => {
  it('reports an unknown outcome instead of returning the inconsistent task', async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-kanban-http-'));
    const teamDir = path.join(fixture, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'fixture',
        members: [
          { name: 'lead', role: 'team-lead' },
          { name: 'worker', role: 'developer' },
        ],
      })
    );
    const board = createController({
      teamName: 'fixture',
      claudeDir: fixture,
      localTaskBoard: true,
    }).taskBoard;
    const task = board.createTask({ subject: 'fixture', owner: 'worker' });
    board.completeTask(task.id, 'worker');
    const original = taskStore.updateTask;
    taskStore.updateTask = (...args: unknown[]) => {
      original(...args);
      throw Object.assign(new Error('injected post-commit EIO'), { code: 'EIO' });
    };
    try {
      expect(() => board.requestReview(task.id, { from: 'worker' })).toThrow(/unknown outcome/);
    } finally {
      taskStore.updateTask = original;
    }

    // The MCP session reads canonical tasks through the app-bound control API,
    // so the inconsistent state is served by the fixture control server.
    const control = await startStdioAppControlFixture({ claudeDir: fixture });
    appControl = control;
    control.seedTask('fixture', {
      id: '1',
      subject: 'fixture',
      status: 'completed',
      owner: 'worker',
      pendingKanbanTransition: {
        id: '11111111-1111-4111-8111-111111111111',
        taskId: '1',
        kind: 'review',
        phase: 'prepared',
        column: 'review',
      },
    });

    const registryUrl = await startSpecRegistry();
    const port = await allocatePort();
    const tsconfig = path.join(fixture, 'mcp-tsconfig.json');
    fs.writeFileSync(
      tsconfig,
      JSON.stringify({
        extends: path.resolve('tsconfig.json'),
        compilerOptions: {
          baseUrl: process.cwd(),
          paths: {
            'agent-teams-controller': [path.resolve('../agent-teams-controller/src/index.js')],
          },
        },
      })
    );
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        path.resolve('src/index.ts'),
        '--transport',
        'httpStream',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: tsconfig,
          AGENT_TEAMS_BOUND_CONTROL_URL: control.baseUrl,
          AGENT_TEAMS_BOUND_CONTEXT_JSON: JSON.stringify(control.context),
          AGENT_TEAMS_MCP_CLAUDE_DIR: fixture,
          OMP_SPEC_REGISTRY_URL: registryUrl,
          OMP_SPEC_REGISTRY_TOKEN: 'fixture-token',
          AGENT_TEAMS_SPEC_SCOPE: JSON.stringify({
            projects: ['stgm/tokenplan'],
            bindings: [],
          }),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    const url = `http://127.0.0.1:${port}/mcp`;
    const deadline = Date.now() + 10_000;
    while (true) {
      try {
        await fetch(url);
        break;
      } catch (error) {
        if (Date.now() >= deadline || child.exitCode !== null) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const post = (body: object, session?: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify(body),
      });
    const initialized = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'fixture', version: '1' },
      },
    });
    expect(initialized.status).toBe(200);
    const session = initialized.headers.get('mcp-session-id');
    expect(session).toBeTruthy();
    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session!);
    const response = await post(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'task_get',
          arguments: { teamName: 'fixture', claudeDir: fixture, taskId: '1' },
        },
      },
      session!
    );
    const body = await response.text();
    expect(body).toContain('KANBAN_TRANSITION_UNCERTAIN');
    expect(body).toContain('unknown outcome');
    expect(body).toContain('isError');
  }, 20_000);
});
