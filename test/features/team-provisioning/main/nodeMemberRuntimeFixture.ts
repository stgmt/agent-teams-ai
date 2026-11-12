import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApplicationCommandRunner } from '@features/application-command-ledger/core/application/ApplicationCommandRunner';
import { InternalStorageApplicationCommandLedgerStore } from '@features/application-command-ledger/main';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import { NativeClaudeSdkHost } from '@features/team-provisioning/main/adapters/output/NativeClaudeSdkHost';
import { inspectProcessByPid } from '@main/utils/processInspection';
import Database from 'better-sqlite3-node';
import { afterEach, expect, vi } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';

import type {
  MemberProcessToken,
  OwnedProcessIdentity,
} from '@features/team-provisioning/contracts';
import type { NativeClaudeSdkEvent } from '@features/team-provisioning/main/adapters/output/NativeClaudeSdkHost';
import type {
  NodeMemberConnectionPlan,
  NodeMemberLaunchPlan,
} from '@features/team-provisioning/main/adapters/output/NodeMemberRuntime';

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const disposers: (() => Promise<void>)[] = [];
// Teardown stops the host, kills every child this fixture birth-verified and waits for each
// real OS exit, which costs more than the default 10s hook ceiling under a loaded Windows box.
afterEach(async () => {
  const failures: unknown[] = [];
  for (const dispose of disposers.splice(0).reverse()) {
    try {
      await dispose();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, 'SDK fixture teardown failed');
}, 60_000);

export type SdkPlanOverrides = Partial<Omit<NodeMemberLaunchPlan, 'sdk' | 'executable' | 'args'>>;

export function rejectUnexpectedRecovery(): Promise<never> {
  return Promise.reject(new Error('Spawn-only fixture must not fabricate runtime recovery'));
}

/** A real child, loopback WebSocket and SQLite ledger. No model provider or pipe transport. */
export async function createNodeMemberRuntimeFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'node-member-sdk-'));
  const databasePath = join(directory, 'ledger.db');
  let core = openCore();
  let store = new InternalStorageApplicationCommandLedgerStore(new InProcessGateway(core));
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const attempts = new Map<
    string,
    {
      token: Readonly<MemberProcessToken>;
      overrides: SdkPlanOverrides;
      stdoutPath: string;
      stderrPath: string;
      commandsPath: string;
    }
  >();
  const authorities = new Map<
    string,
    {
      token: Readonly<MemberProcessToken>;
      identity: Readonly<OwnedProcessIdentity>;
      startedAt: number;
    }
  >();
  const observed: NativeClaudeSdkEvent[] = [];
  const failures: Error[] = [];
  let host = makeHost();
  let server = createServer();
  let closed = false;
  let counter = 0;
  await listen();

  function openCore() {
    return new InternalStorageWorkerCore({
      databasePath,
      createDatabase: (file) => new Database(file),
    });
  }
  function makeHost() {
    return new NativeClaudeSdkHost({
      ledger: store,
      runner: new ApplicationCommandRunner({
        ledger: store,
        hasher: { hashString: hash, hashJson: (value) => hash(JSON.stringify(value)) },
      }),
      scopeKey: directory,
      async assertAuthorized(token, identity) {
        const authority = authorities.get(token.operationId);
        if (
          authority &&
          (authority.token.memberName !== token.memberName ||
            authority.token.generation !== token.generation ||
            authority.identity.pid !== identity.pid ||
            authority.identity.birthId !== identity.birthId)
        )
          throw new Error('Test SDK process identity changed');
        // The app authorizes against its registry snapshot, so the OS birth probe runs once per
        // owned process. Re-probing on every event would spawn a PowerShell query per stream
        // frame and starve the real children this suite is meant to observe.
        if (authority) return;
        const inspection = await inspectProcessByPid(identity.pid);
        if (inspection.status !== 'found' || inspection.startedAt === undefined)
          throw Object.assign(new Error('Test SDK process birth is no longer current'), {
            code: 'TEST_PROCESS_EXITED' as const,
          });
        authorities.set(token.operationId, {
          token,
          identity: { ...identity },
          startedAt: inspection.startedAt,
        });
      },
      async observe(_subject, event) {
        observed.push(event);
      },
    });
  }
  async function listen() {
    const port = await host.recoverEndpoint();
    host.attach(server);
    const listening = deferred<void>();
    server.once('error', listening.reject);
    server.listen(port ?? 0, '127.0.0.1', listening.resolve);
    await listening.promise;
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('SDK fixture has no loopback listener');
    await host.listening(address.port);
  }
  async function closeHost() {
    await host.close();
    const stopped = deferred<void>();
    server.close(() => stopped.resolve());
    // A surviving owned member reconnects the moment the host closes its WebSocket, and the
    // listener counts that raw socket: `server.close()` waits for every connection, so one
    // late socket would keep the endpoint (and `replaceHost`) open until the member is killed.
    server.closeAllConnections();
    await stopped.promise;
  }
  async function close() {
    if (closed) return;
    closed = true;
    await closeHost();
    // Only processes created and birth-verified by this fixture are eligible for teardown.
    for (const attempt of attempts.values()) {
      const authority = authorities.get(attempt.token.operationId);
      if (!authority) continue;
      const result = await inspectProcessByPid(authority.identity.pid);
      if (result.status === 'found' && result.startedAt === authority.startedAt) {
        try {
          process.kill(authority.identity.pid, 'SIGKILL');
        } catch (error) {
          if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH')
            throw error;
        }
        await vi.waitFor(
          async () => {
            const current = await inspectProcessByPid(authority.identity.pid);
            if (current.status === 'found' && current.startedAt === authority.startedAt)
              throw new Error('Fixture child has not exited');
          },
          { timeout: 10_000 }
        );
      }
    }
    try {
      expect(failures).toEqual([]);
    } finally {
      core.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  disposers.push(close);

  function acknowledgeObservedBootstrap(token: Readonly<MemberProcessToken>): void {
    const attempt = attempts.get(token.operationId);
    if (!attempt) throw new Error('No fixture attempt to observe');
    host.subscribe(token, {
      output(line) {
        const event: NativeClaudeSdkEvent = JSON.parse(line);
        if (typeof event.uuid === 'string')
          writeFileSync(`${attempt.commandsPath}.observed-${event.uuid}`, '');
      },
      disconnected() {},
      failed(error) {
        // The app authorizes an event against its registry snapshot; this probe adds an OS
        // birth check on every event. Once the test kills the owned child, a buffered event
        // fails that stricter probe even though the app itself never inspects the OS here,
        // so only the extra probe's verdict is discarded. Everything else stays recorded,
        // including failures seen before teardown stops the host.
        if (!closed && (error as { code?: string }).code !== 'TEST_PROCESS_EXITED')
          failures.push(error);
      },
    });
  }

  function connectionPlan(token: Readonly<MemberProcessToken>): NodeMemberConnectionPlan {
    const attempt = attempts.get(token.operationId);
    if (!attempt) throw new Error('No persisted fixture attempt');
    return {
      ...attempt.overrides,
      sdk: { host, token, stdoutPath: attempt.stdoutPath, stderrPath: attempt.stderrPath },
      observeOutput:
        attempt.overrides.observeOutput ??
        ((line) => {
          const event: NativeClaudeSdkEvent = JSON.parse(line);
          return event.type === 'system' &&
            event.subtype === 'team_bootstrap' &&
            event.team_name === token.teamName &&
            event.run_id === token.runId &&
            event.event === 'completed' &&
            event.status === 'completed' &&
            event.text === 'TEST-ready'
            ? 'connected'
            : null;
        }),
    };
  }

  return {
    directory,
    observed,
    get host() {
      return host;
    },
    async plan(
      code: string,
      token: Readonly<MemberProcessToken>,
      overrides: SdkPlanOverrides = {}
    ): Promise<NodeMemberLaunchPlan> {
      const attemptDirectory = join(directory, String(++counter));
      await mkdir(attemptDirectory);
      const prefix = join(attemptDirectory, 'runtime');
      const stdoutPath = `${prefix}.stdout`;
      const stderrPath = `${prefix}.stderr`;
      const commandsPath = `${prefix}.commands.jsonl`;
      attempts.set(token.operationId, { token, overrides, stdoutPath, stderrPath, commandsPath });
      const endpoint = await host.prepare(token);
      acknowledgeObservedBootstrap(token);
      await writeFile(`${prefix}.mcp.json`, JSON.stringify({ mcpServers: {} }));
      await host.rememberConnection(token, {
        role: 'lead',
        mailboxOwner: 'runtime',
        mcpConfigPath: `${prefix}.mcp.json`,
        stdoutPath,
        stderrPath,
      });
      const script = `${prefix}.cjs`;
      await writeFile(script, childScript(code, endpoint, commandsPath, token));
      return {
        ...connectionPlan(token),
        executable: process.execPath,
        args: [script],
        cwd: process.cwd(),
        env: process.env,
        ...overrides,
      };
    },
    async recover(token: Readonly<MemberProcessToken>): Promise<NodeMemberConnectionPlan> {
      const evidence = await host.recoverConnection(token);
      const plan = connectionPlan(token);
      if (
        plan.sdk.stdoutPath !== evidence.stdoutPath ||
        plan.sdk.stderrPath !== evidence.stderrPath
      )
        throw new Error('Persisted SDK diagnostic paths changed');
      return plan;
    },
    async commands(token: Readonly<MemberProcessToken>): Promise<NativeClaudeSdkEvent[]> {
      const attempt = attempts.get(token.operationId);
      if (!attempt) throw new Error('Unknown SDK fixture attempt');
      const contents = await readFile(attempt.commandsPath, 'utf8');
      return contents
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
    async replaceHost() {
      await closeHost();
      core.close();
      core = openCore();
      store = new InternalStorageApplicationCommandLedgerStore(new InProcessGateway(core));
      host = makeHost();
      server = createServer();
      await listen();
      for (const attempt of attempts.values()) acknowledgeObservedBootstrap(attempt.token);
    },
    close,
  };
}

export async function createSdkRuntimePlan(
  code: string,
  token: Readonly<MemberProcessToken>,
  overrides: SdkPlanOverrides = {}
): Promise<NodeMemberLaunchPlan> {
  const fixture = await createNodeMemberRuntimeFixture();
  return fixture.plan(code, token, overrides);
}

function childScript(
  code: string,
  endpoint: { url: string; bearerToken: string },
  commandsPath: string,
  token: Readonly<MemberProcessToken>
): string {
  const wsModule = createRequire(import.meta.url).resolve('ws');
  return `
const { WebSocket } = require(${JSON.stringify(wsModule)});
const { randomUUID } = require('node:crypto');
const { appendFileSync, existsSync, writeFileSync } = require('node:fs');
const endpoint = ${JSON.stringify(endpoint)};
const commandsPath = ${JSON.stringify(commandsPath)};
const token = ${JSON.stringify(token)};
writeFileSync(commandsPath, '');
let ws;
let finished = false;
let ran = false;
let readyText = null;
const accepted = new Set();
const send = async event => {
  const value = { session_id: 'TEST-session', uuid: randomUUID(), ...event };
  const sent = Promise.withResolvers();
  ws.send(JSON.stringify(value) + '\\n', error => error ? sent.reject(error) : sent.resolve());
  await sent.promise;
  // Do not let a short-lived real child exit while the host still authorizes or
  // commits its last event. A socket send callback only proves bytes were sent.
  const receipt = commandsPath + '.observed-' + value.uuid;
  while (!existsSync(receipt)) {
    const tick = Promise.withResolvers();
    setTimeout(tick.resolve, 10);
    await tick.promise;
  }
};
// This receipt only synchronizes test exit after host consumption. Runtime readiness still uses SDK output.
const ready = async (text = 'TEST-ready') => {
  readyText = text;
  const uuid = randomUUID();
  await send({ type: 'system', subtype: 'team_bootstrap', team_name: token.teamName, run_id: token.runId, event: 'completed', status: 'completed', expected_members: [], registered_members: [], failed_members: [], text, uuid });
};
const finish = async (code = 0) => {
  finished = true;
  await new Promise(resolve => { ws.once('close', resolve); ws.close(); });
  process.exitCode = code;
};
function connect() {
  ws = new WebSocket(endpoint.url, { headers: { Authorization: 'Bearer ' + endpoint.bearerToken } });
  ws.on('error', () => {});
  ws.on('close', () => { if (!finished) setTimeout(connect, 50); });
  ws.on('message', async bytes => {
    const event = JSON.parse(bytes.toString());
    if (event.type === 'user') {
      if (!accepted.has(event.uuid)) { accepted.add(event.uuid); appendFileSync(commandsPath, JSON.stringify(event) + '\\n'); }
      await send(event);
    } else if (event.type === 'control_request') {
      await send({ type: 'control_response', response: { subtype: 'success', request_id: event.request_id, response: {} } });
    }
  });
  ws.on('open', async () => {
    if (ran) { if (readyText !== null) await ready(readyText); return; }
    ran = true;
    try { await (async () => { ${code}\n })(); }
    catch (error) { console.error(error); finished = true; ws.close(); process.exitCode = 1; }
  });
}
connect();
`;
}
