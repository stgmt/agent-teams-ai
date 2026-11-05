import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createController } = require('../../agent-teams-controller/src/index.js');
const taskStore = require('../../agent-teams-controller/src/internal/taskStore.js');
let fixture = '';
let child: ChildProcess | undefined;

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
    const board = createController({ teamName: 'fixture', claudeDir: fixture }).taskBoard;
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
        env: { ...process.env, TSX_TSCONFIG_PATH: tsconfig },
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
          arguments: { teamName: 'fixture', claudeDir: fixture, taskId: task.id },
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
