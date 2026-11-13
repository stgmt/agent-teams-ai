import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectProcessByPid } from '@main/utils/processInspection';

import {
  ApplicationCommandBeginOutcome,
  ApplicationCommandLedgerStatus,
} from '@features/application-command-ledger/contracts';
import { ApplicationCommandRunner } from '@features/application-command-ledger/core/application/ApplicationCommandRunner';
import { NativeClaudeSdkHost } from '@features/team-provisioning/main/adapters/output/NativeClaudeSdkHost';
import { MemberLifecycleRegistry } from '@features/team-provisioning/core/domain/MemberLifecycleRegistry';
import {
  NativeClaudeApprovalStore,
  NativeClaudeToolApprovals,
} from '@features/team-provisioning/main/adapters/output/NativeClaudeToolApprovals';
import { NativeLeadInboxRelay } from '@features/team-provisioning/main/adapters/output/NativeLeadInboxRelay';
import { NativeMemberInboxRelay } from '@features/team-provisioning/main/adapters/output/NativeMemberInboxRelay';
import { NodeLeadRequestHistory } from '@features/team-provisioning/main/adapters/output/NodeLeadRequestHistory';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { ApplicationCommandLedgerRecord } from '@features/application-command-ledger/contracts';
import type { ApplicationCommandLedgerStore } from '@features/application-command-ledger/core/application/ports';
import type { MemberProcessToken } from '@features/team-provisioning/contracts';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

// This store tests admission/replay semantics, not SQLite crash durability. Transport is a real socket.
function ledger(): ApplicationCommandLedgerStore {
  const records = new Map<string, ApplicationCommandLedgerRecord>();
  const id = (value: { namespace: string; scopeKey: string; commandId: string }) =>
    JSON.stringify([value.namespace, value.scopeKey, value.commandId]);
  return {
    async begin(request) {
      const prior = records.get(id(request));
      if (prior) {
        if (prior.payloadHash !== request.payloadHash) throw new Error('Payload conflict');
        const record = prior as ApplicationCommandLedgerRecord<typeof request.operation>;
        return prior.status === ApplicationCommandLedgerStatus.Completed
          ? { outcome: ApplicationCommandBeginOutcome.DuplicateCompleted, record }
          : prior.status === ApplicationCommandLedgerStatus.UnknownAfterTimeout
            ? { outcome: ApplicationCommandBeginOutcome.UnknownAfterTimeout, record }
            : { outcome: ApplicationCommandBeginOutcome.AlreadyStarted, record };
      }
      const row = {
        ...request,
        status: ApplicationCommandLedgerStatus.Started,
        failureKind: null,
        retryable: false,
        attemptCount: 1,
        resultHash: null,
        resultJson: null,
        startedAt: request.nowIso,
        updatedAt: request.nowIso,
        completedAt: null,
        lastError: null,
      };
      records.set(id(request), row);
      return { outcome: ApplicationCommandBeginOutcome.Started, record: row };
    },
    async markCompleted(request) {
      Object.assign(records.get(id(request))!, request, {
        status: ApplicationCommandLedgerStatus.Completed,
      });
    },
    async markFailed(request) {
      Object.assign(records.get(id(request))!, request, {
        status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
      });
    },
    async getByCommandId(request) {
      return (records.get(id(request)) ?? null) as never;
    },
    async getByIdempotencyKey(request) {
      return ([...records.values()].find(
        (row) =>
          row.namespace === request.namespace &&
          row.scopeKey === request.scopeKey &&
          row.idempotencyKey === request.idempotencyKey
      ) ?? null) as never;
    },
    async listByScope(request) {
      return [...records.values()].filter(
        (row) => row.namespace === request.namespace && row.scopeKey === request.scopeKey
      ) as never;
    },
  };
}

const token: MemberProcessToken = {
  appInstanceId: 'test-app',
  dataRootFingerprint: 'test-root',
  connectionGeneration: 1,
  teamName: 'socket-team',
  runId: 'socket-run',
  memberName: 'executor',
  generation: 1,
  operationId: 'launch-operation',
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function fixture(
  store: ApplicationCommandLedgerStore = ledger(),
  beforeObserve?: () => Promise<void>,
  beforeAuthorize?: () => Promise<void>
) {
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const runner = new ApplicationCommandRunner({
    ledger: store,
    hasher: { hashString: hash, hashJson: (value) => hash(JSON.stringify(value)) },
  });
  const observed: unknown[] = [];
  const projected: unknown[] = [];
  let authorized = true;
  const host = new NativeClaudeSdkHost({
    runner,
    ledger: store,
    scopeKey: 'socket-root',
    async assertAuthorized(current, identity) {
      await beforeAuthorize?.();
      if (
        !authorized ||
        current.operationId !== token.operationId ||
        identity.pid !== process.pid ||
        identity.birthId !== 'test-birth'
      )
        throw new Error('Identity refused');
    },
    async observe(_subject, event) {
      await beforeObserve?.();
      observed.push(event);
    },
  });
  const recoveryPort = await host.recoverEndpoint();
  const server = createServer();
  host.attach(server);
  const started = deferred<void>();
  server.listen(recoveryPort ?? 0, '127.0.0.1', started.resolve);
  await started.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test listener');
  await host.listening(address.port);
  const launch = await host.prepare(token);
  const inspection = await inspectProcessByPid(process.pid);
  if (inspection.status !== 'found' || inspection.startedAt === undefined)
    throw new Error('Test process birth unavailable');
  await host.registerProcess(
    token,
    { pid: process.pid, birthId: 'test-birth' },
    inspection.startedAt
  );
  host.subscribe(token, {
    output(line) {
      projected.push(JSON.parse(line));
    },
    disconnected() {},
    failed(error) {
      throw error;
    },
  });
  const sockets: WebSocket[] = [];
  const connect = (headers: Record<string, string> = {}) => {
    const ws = new WebSocket(launch.url, {
      headers: { Authorization: `Bearer ${launch.bearerToken}`, ...headers },
    });
    sockets.push(ws);
    return ws;
  };
  let disposed = false;
  const shutdown = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    for (const ws of sockets) ws.terminate();
    await host.close();
    const closed = deferred<void>();
    server.close(() => closed.resolve());
    await closed.promise;
  };
  cleanup.push(shutdown);
  return {
    host,
    connect,
    observed,
    projected,
    store,
    launch,
    shutdown,
    revoke: () => {
      authorized = false;
    },
  };
}

async function opened(ws: WebSocket): Promise<void> {
  const pending = deferred<void>();
  ws.once('open', pending.resolve);
  ws.once('error', pending.reject);
  await pending.promise;
}

async function refused(ws: WebSocket): Promise<number> {
  const pending = deferred<number>();
  ws.once('unexpected-response', (_request, response) => {
    response.resume();
    pending.resolve(response.statusCode ?? 0);
    ws.terminate();
  });
  ws.on('error', () => {});
  return pending.promise;
}

describe('native SDK HTTP upgrade boundary', () => {
  it('refuses browser origins, wrong bearer and superseded process authority over real upgrades', async () => {
    const f = await fixture();
    expect(await refused(f.connect({ Origin: 'http://127.0.0.1' }))).toBe(403);
    expect(await refused(f.connect({ Authorization: 'Bearer invalid' }))).toBe(403);
    f.revoke();
    expect(await refused(f.connect())).toBe(403);
  });

  it('distinguishes socket admission from bootstrap and commits event dedup before UUID command acknowledgment', async () => {
    const f = await fixture();
    const output = deferred<void>();
    f.host.subscribe(token, {
      output() {
        output.resolve();
      },
      disconnected() {},
      failed(error) {
        output.reject(error);
      },
    });
    const ws = f.connect();
    await opened(ws);
    expect(f.projected).toEqual([]);
    expect(f.observed).toEqual([]);
    const event = {
      type: 'user',
      uuid: 'incoming-event',
      session_id: 'executor-session',
      message: { content: [] },
    };
    ws.send(`${JSON.stringify(event)}\n${JSON.stringify(event)}\n`);
    await output.promise;
    expect(f.observed).toEqual([event]);
    expect(f.projected).toEqual([event]);
    const received = deferred<string>();
    ws.once('message', (bytes) => received.resolve(bytes.toString()));
    const delivery = f.host.deliver(
      token,
      'durable-user-command',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'work' } })
    );
    const wire = await received.promise;
    expect(wire.endsWith('\n')).toBe(true);
    const command = JSON.parse(wire);
    expect(command.uuid).toBe('durable-user-command');
    let completed = false;
    void delivery.then(() => {
      completed = true;
    });
    await Promise.resolve();
    expect(completed).toBe(false);
    ws.send(
      `${JSON.stringify({
        ...command,
        session_id: 'executor-session',
        message: { role: 'user', content: [{ type: 'text', text: 'work' }] },
      })}\n`
    );
    await delivery;
    await f.host.deliver(
      token,
      'durable-user-command',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'work' } })
    );
    expect(f.observed).toHaveLength(2);
  });

  it('replays committed output to a replacement volatile consumer without consuming its side effect again', async () => {
    const f = await fixture();
    const first = deferred<void>();
    f.host.subscribe(token, {
      output() {
        first.resolve();
      },
      disconnected() {},
      failed(error) {
        first.reject(error);
      },
    });
    const ws = f.connect();
    await opened(ws);
    const event = {
      type: 'user',
      uuid: 'persisted-output',
      session_id: 'executor-session',
      message: { content: [] },
    };
    ws.send(`${JSON.stringify(event)}\n`);
    await first.promise;
    const rebuilt = deferred<string>();
    f.host.subscribe(token, {
      output(line) {
        rebuilt.resolve(line);
      },
      disconnected() {},
      failed(error) {
        rebuilt.reject(error);
      },
    });
    expect(JSON.parse(await rebuilt.promise)).toEqual(event);
    expect(f.observed).toEqual([event]);
    const closed = deferred<void>();
    ws.once('close', closed.resolve);
    ws.close();
    await closed.promise;
    const reconnected = f.connect();
    await opened(reconnected);
    expect(f.observed).toEqual([event]);
    expect(f.projected).toEqual([event]);
  });

  it('recovers the same endpoint and launch credential and rebuilds committed output after host replacement', async () => {
    const first = await fixture();
    const consumed = deferred<void>();
    first.host.subscribe(token, {
      output() {
        consumed.resolve();
      },
      disconnected() {},
      failed(error) {
        consumed.reject(error);
      },
    });
    const ws = first.connect();
    await opened(ws);
    const event = {
      type: 'user',
      uuid: 'before-host-replacement',
      session_id: 'executor-session',
      message: { content: [] },
    };
    ws.send(`${JSON.stringify(event)}\n`);
    await consumed.promise;
    await first.shutdown();
    const second = await fixture(first.store);
    expect(second.launch).toEqual(first.launch);
    const replayed = deferred<void>();
    second.host.subscribe(token, {
      output() {
        replayed.resolve();
      },
      disconnected() {},
      failed(error) {
        replayed.reject(error);
      },
    });
    await replayed.promise;
    expect(second.projected).toEqual([event]);
    expect(second.observed).toEqual([]);
    const reconnected = second.connect();
    await opened(reconnected);
    expect(second.projected).toEqual([event]);
  });

  it('awaits all-member binding observation before committing output consumption', async () => {
    const entered = deferred<void>();
    const persisted = deferred<void>();
    const f = await fixture(ledger(), async () => {
      entered.resolve();
      await persisted.promise;
    });
    const consumed = deferred<void>();
    f.host.subscribe(token, {
      output() {
        consumed.resolve();
      },
      disconnected() {},
      failed(error) {
        consumed.reject(error);
      },
    });
    const ws = f.connect();
    await opened(ws);
    const event = {
      type: 'user',
      uuid: 'binding-tool-result',
      session_id: 'executor-session',
      message: { content: [{ type: 'tool_result', tool_use_id: 'created-spec', content: [] }] },
    };
    ws.send(`${JSON.stringify(event)}\n`);
    await entered.promise;
    expect(f.projected).toEqual([]);
    expect(f.observed).toEqual([]);
    persisted.resolve();
    await consumed.promise;
    expect(f.observed).toEqual([event]);
    expect(f.projected).toEqual([event]);
  });

  it('owns a peer reset during asynchronous upgrade authority and still accepts the next exact process connection', async () => {
    let blocked = false;
    const entered = deferred<void>();
    const release = deferred<void>();
    const f = await fixture(ledger(), undefined, async () => {
      if (blocked) {
        entered.resolve();
        await release.promise;
      }
    });
    blocked = true;
    const abandoned = f.connect();
    const closed = deferred<void>();
    let admitted = false;
    abandoned.once('close', closed.resolve);
    abandoned.once('error', () => closed.resolve());
    abandoned.once('open', () => {
      admitted = true;
    });
    await entered.promise;
    abandoned.terminate();
    await closed.promise;
    blocked = false;
    release.resolve();
    const next = f.connect();
    const connected = deferred<void>();
    next.once('open', connected.resolve);
    next.once('error', connected.reject);
    await connected.promise;
    expect(
      f.host.hasAuthenticatedConnection(token, { pid: process.pid, birthId: 'test-birth' })
    ).toBe(true);
    expect(abandoned.readyState).toBe(WebSocket.CLOSED);
    expect(admitted).toBe(false);
  });

  it('drains admitted event persistence before releasing the host ledger owner', async () => {
    const entered = deferred<void>();
    const persisted = deferred<void>();
    const f = await fixture(ledger(), async () => {
      entered.resolve();
      await persisted.promise;
    });
    const ws = f.connect();
    await opened(ws);
    ws.send(
      `${JSON.stringify({ type: 'user', uuid: 'shutdown-event', session_id: 'executor-session', message: { content: [] } })}\n`
    );
    await entered.promise;
    const received = deferred<void>();
    ws.once('message', received.resolve);
    const command = f.host.deliver(
      token,
      'shutdown-command',
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'unacknowledged work' },
      })
    );
    const refused = expect(command).rejects.toThrow('outcome unknown');
    await received.promise;
    let stopped = false;
    const closing = f.host.close().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    persisted.resolve();
    await closing;
    await refused;
    expect(f.observed).toHaveLength(1);
    await f.shutdown();
    const restored = await fixture(f.store);
    const replayed = deferred<void>();
    restored.host.subscribe(token, {
      output() {
        replayed.resolve();
      },
      disconnected() {},
      failed(error) {
        replayed.reject(error);
      },
    });
    await replayed.promise;
    expect(restored.projected).toEqual([
      expect.objectContaining({ type: 'user', uuid: 'shutdown-event' }),
    ]);
    expect(restored.observed).toEqual([]);
  });

  it('leaves SDK-owned lead and member mailboxes untouched, including while their socket is disconnected', async () => {
    const f = await fixture();
    await f.host.rememberConnection(token, {
      role: 'member',
      mailboxOwner: 'runtime',
      mcpConfigPath: join(tmpdir(), 'socket-test-mcp.json'),
      stdoutPath: join(tmpdir(), 'socket-test.stdout'),
      stderrPath: join(tmpdir(), 'socket-test.stderr'),
    });
    const identity = { pid: process.pid, birthId: 'test-birth' };
    expect(f.host.ownsMailbox(token, identity)).toBe(true);
    expect(f.host.ownsMailbox({ ...token, generation: token.generation + 1 }, identity)).toBe(
      false
    );
    expect(f.host.ownsMailbox(token, { ...identity, birthId: 'foreign-birth' })).toBe(false);
    for (const role of ['lead', 'member'] as const) {
      const registry = new MemberLifecycleRegistry(token);
      registry.configureTeam(token, [
        { memberName: token.memberName, role },
        ...(role === 'member' ? [{ memberName: 'leader', role: 'lead' as const }] : []),
      ]);
      for (const admitted of registry.beginTeamStart(token, () => token.operationId)) {
        expect(registry.observeSpawn(admitted, identity)).toBe(true);
        expect(registry.observeConnected(admitted)).toBe(true);
      }
      let reads = 0;
      const deps = {
        runs: registry,
        snapshot: (teamName: string) => registry.snapshot(teamName),
        inbox: {
          async getMessagesFor() {
            reads++;
            return [];
          },
        },
        async send() {
          throw new Error('Application must not resend a runtime-owned mailbox');
        },
        teamsRoot: tmpdir(),
        ownsMailbox: (_run: unknown, memberName: string) =>
          f.host.ownsMailbox({ ...token, memberName }, identity),
      };
      const count =
        role === 'lead'
          ? await new NativeLeadInboxRelay({ ...deps, controlUrl: async () => null }).relay(
              token.teamName
            )
          : await new NativeMemberInboxRelay(deps).relay(token.teamName, token.memberName);
      expect(count).toBe(0);
      expect(reads).toBe(0);
    }
  });

  it('clears a replayed pending permission only after its matching durable success echo', async () => {
    const f = await fixture();
    const approvals = new NativeClaudeToolApprovals({
      store: new NativeClaudeApprovalStore(),
      write: (subject, line) => f.host.deliver(subject, 'permission-command', line),
    });
    const requested = deferred<void>();
    approvals.onEvent((event) => {
      if (event.type === 'requested') requested.resolve();
    });
    f.host.subscribe(token, {
      output(line, evidence) {
        approvals.observeLine(token, line, evidence);
      },
      disconnected() {},
      failed(error) {
        requested.reject(error);
      },
    });
    const ws = f.connect();
    await opened(ws);
    ws.send(
      `${JSON.stringify({
        type: 'control_request',
        uuid: 'permission-request-event',
        request_id: 'native-permission-request',
        request: { subtype: 'can_use_tool', tool_name: 'Read', input: { file_path: 'source.ts' } },
      })}\n`
    );
    await requested.promise;
    expect(await approvals.respond(token.runId, 'mailbox-only-permission-id', true)).toBe(false);
    expect(approvals.list(token.runId)).toHaveLength(1);
    const received = deferred<string>();
    ws.once('message', (bytes) => received.resolve(bytes.toString()));
    const answered = approvals.respond(token.runId, 'native-permission-request', true);
    const response = JSON.parse(await received.promise);
    expect(response.response.response.updatedInput).toEqual({ file_path: 'source.ts' });
    ws.send(`${JSON.stringify(response)}\n`);
    expect(await answered).toBe(true);
    const restored = new NativeClaudeToolApprovals({
      store: new NativeClaudeApprovalStore(),
      async write() {
        throw new Error('Historical permission reconstruction must not submit another answer');
      },
    });
    const replayed = deferred<void>();
    f.host.subscribe(token, {
      output(line, evidence) {
        restored.observeLine(token, line, evidence);
        if (JSON.parse(line).type === 'control_response') replayed.resolve();
      },
      disconnected() {},
      failed(error) {
        replayed.reject(error);
      },
    });
    await replayed.promise;
    expect(restored.list(token.runId)).toEqual([]);
  });

  it('persists direct human history separately from the runtime mailbox before SDK command delivery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-sdk-human-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const teamsRoot = join(directory, 'teams');
    const inbox = join(teamsRoot, token.teamName, 'inboxes', `${token.memberName}.json`);
    await mkdir(join(teamsRoot, token.teamName, 'inboxes'), { recursive: true });
    await writeFile(inbox, '[]');
    const history = new NodeLeadRequestHistory({
      teamsRoot,
      leadName: () => token.memberName,
      assertCurrent(run) {
        if (run.runId !== token.runId) throw new Error('Stale run');
      },
    });
    await history.persist({
      run: token,
      requestMessageId: 'direct-human-request',
      text: 'work',
      origin: { kind: 'human' },
      isMeta: false,
    });
    const f = await fixture();
    const ws = f.connect();
    await opened(ws);
    const received = deferred<string>();
    ws.once('message', (bytes) => received.resolve(bytes.toString()));
    const delivered = f.host.deliver(
      token,
      'persisted-human-operation',
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'work' } })
    );
    const command = JSON.parse(await received.promise);
    ws.send(`${JSON.stringify({ ...command, session_id: 'executor-session' })}\n`);
    await delivered;
    expect(JSON.parse(await readFile(inbox, 'utf8'))).toEqual([]);
    expect((await history.read(token, 'direct-human-request'))?.text).toBe('work');
  });
});
