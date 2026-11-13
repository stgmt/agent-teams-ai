import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import {
  ApplicationCommandFailureKind,
  ApplicationCommandLedgerStatus,
} from '@features/application-command-ledger/contracts';
import { inspectProcessByPid } from '@main/utils/processInspection';
import { WebSocket, WebSocketServer } from 'ws';

import { awaitWithAbort } from '../../../core/application/awaitWithAbort';

import { isLoopbackPeerAddress } from './loopbackPeerAddress';
import { NativeSdkHostStateStore } from './NativeSdkHostStateStore';

import type { MemberProcessToken, OwnedProcessIdentity } from '../../../contracts';
import type { NativeRuntimeConnectionExpected } from './NativeRuntimeConnection';
import type { ApplicationCommandRunner } from '@features/application-command-ledger/core/application/ApplicationCommandRunner';
import type { ApplicationCommandLedgerStore } from '@features/application-command-ledger/core/application/ports';
import type { ApplicationCommandJsonValue } from '@features/application-command-ledger/core/domain/stableJson';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData } from 'ws';

export type NativeClaudeSdkEvent = Record<string, ApplicationCommandJsonValue>;

export interface NativeClaudeSdkOutputEvidence {
  permissionResponseConsumed: boolean;
}

export interface NativeClaudeSdkHostPorts {
  runner: ApplicationCommandRunner;
  ledger: ApplicationCommandLedgerStore;
  /** Stable application storage/root identity, not the current application PID. */
  scopeKey: string;
  /** Existing root/context/generation and OS PID-birth authority; invoked on every operation. */
  assertAuthorized(
    token: Readonly<MemberProcessToken>,
    identity: Readonly<OwnedProcessIdentity>
  ): Promise<void>;
  /** Existing CreatedSpecBindingObserver.observe, for every member, not only the lead. */
  observe(
    subject: { teamName: string; sessionId: string },
    event: NativeClaudeSdkEvent
  ): Promise<void>;
}

export interface NativeClaudeSdkRecovery {
  role: 'lead' | 'member';
  mailboxOwner: 'runtime';
  mcpConfigPath: string;
  stdoutPath: string;
  stderrPath: string;
  proof?: NativeRuntimeConnectionExpected;
}

interface Launch {
  token: MemberProcessToken;
  url: string;
  bearerToken: string;
}
interface Session {
  launch: Launch;
  identity: OwnedProcessIdentity | null;
  recovery: NativeClaudeSdkRecovery | null;
  startedAt: number | null;
  registered: Promise<void>;
  processRegistered(): void;
  socket: WebSocket | null;
  serial: Promise<void>;
  nextSequence: number;
  listeners: Set<{
    output(line: string, evidence: NativeClaudeSdkOutputEvidence): void;
    opened?(): void;
    disconnected(): void;
    failed(error: Error): void;
    seen: Set<string>;
  }>;
  pending: Map<
    string,
    { resolve(): void; reject(error: Error): void; matches(event: NativeClaudeSdkEvent): boolean }
  >;
}

const NAMESPACE = 'native-claude-sdk';
const PREFIX = '/api/native-claude-sdk/';
const MAX_FRAME = 16 * 1024 * 1024;

function key(token: Readonly<MemberProcessToken>): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        token.dataRootFingerprint,
        token.teamName,
        token.runId,
        token.memberName,
        token.generation,
        token.operationId,
      ])
    )
    .digest('hex');
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** SDK transport on the application's existing HTTP server; it never owns a listener. */
export class NativeClaudeSdkHost {
  private port: number | null = null;
  private readonly sessions = new Map<string, Session>();
  private readonly webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
  private server: Server | null = null;
  private restoring: Promise<number | null> | null = null;
  private readonly stopping = new AbortController();
  private closing: Promise<void> | null = null;
  private readonly admissions = new Set<Promise<void>>();
  private readonly commands = new Set<Promise<unknown>>();
  private readonly state: NativeSdkHostStateStore;
  private readonly upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!request.url?.startsWith(PREFIX)) return;
    // HTTP has handed off the raw socket, but ws cannot own it until asynchronous
    // registration/authority checks finish. Keep errors owned during that window.
    const admission = new AbortController();
    const failed = (error: Error): void => admission.abort(error);
    const closed = (): void => {
      admission.abort(new Error('Native SDK upgrade peer disconnected'));
      socket.removeListener('error', failed);
    };
    socket.once('error', failed);
    socket.once('close', closed);
    const pending = this.accept(
      request,
      socket,
      head,
      AbortSignal.any([admission.signal, this.stopping.signal])
    ).then(
      () => {
        // handleUpgrade installed ws's socket error ownership.
        socket.removeListener('error', failed);
        socket.removeListener('close', closed);
      },
      () => {
        // Retain raw error ownership through the asynchronous refusal write.
        if (!socket.destroyed)
          socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      }
    );
    this.admissions.add(pending);
    void pending.then(() => {
      this.admissions.delete(pending);
    });
  };

  constructor(private readonly ports: NativeClaudeSdkHostPorts) {
    if (!ports.scopeKey.trim())
      throw new Error('Native SDK requires application storage authority');
    const { runner, ledger, scopeKey } = ports;
    this.state = new NativeSdkHostStateStore({ runner, ledger, scopeKey, namespace: NAMESPACE });
  }

  /** Must run before HttpServer chooses its port and before recovered runtimes are admitted. */
  recoverEndpoint(): Promise<number | null> {
    this.restoring ??= this.restore();
    return this.restoring;
  }

  private async restore(): Promise<number | null> {
    const rows = await this.ports.ledger.listByScope({
      namespace: NAMESPACE,
      scopeKey: this.ports.scopeKey,
    });
    await this.state.fenceInterrupted(rows);
    const endpoint = rows.find((row) => row.commandId === 'endpoint');
    if (endpoint) {
      const value = await this.state.readResult('endpoint');
      if (
        !record(value) ||
        !Number.isSafeInteger(value.port) ||
        Number(value.port) < 1 ||
        Number(value.port) > 65535
      )
        throw new Error('Invalid persisted native SDK endpoint');
      this.port = Number(value.port);
    }
    for (const row of rows) {
      if (!row.commandId.startsWith('launch:')) continue;
      const value = await this.state.readResult(row.commandId);
      if (
        !record(value) ||
        !record(value.token) ||
        typeof value.url !== 'string' ||
        typeof value.bearerToken !== 'string'
      )
        throw new Error('Invalid persisted native SDK launch');
      const launch = value as unknown as Launch;
      const session = this.session(launch);
      const processRow = rows.find(
        (candidate) => candidate.commandId === `process:${key(launch.token)}`
      );
      if (processRow) {
        const identity = await this.state.readResult(processRow.commandId);
        if (
          !record(identity) ||
          !Number.isSafeInteger(identity.pid) ||
          typeof identity.birthId !== 'string' ||
          typeof identity.startedAt !== 'number' ||
          !Number.isFinite(identity.startedAt)
        )
          throw new Error('Invalid persisted native SDK process');
        session.identity = { pid: Number(identity.pid), birthId: identity.birthId };
        session.startedAt = identity.startedAt;
        session.processRegistered();
      }
      if (rows.some((candidate) => candidate.commandId === `connection:${key(launch.token)}`))
        session.recovery = await this.recoverConnection(launch.token);
      await this.state.fenceInterrupted(
        await this.ports.ledger.listByScope({
          namespace: NAMESPACE,
          scopeKey: this.scope(launch.token),
        })
      );
    }
    return this.port;
  }

  attach(server: Server): void {
    if (this.server) throw new Error('Native SDK host is already attached');
    this.server = server;
    server.on('upgrade', this.upgrade);
  }

  async listening(port: number): Promise<void> {
    if (
      !Number.isSafeInteger(port) ||
      port < 1 ||
      port > 65535 ||
      (this.port !== null && this.port !== port)
    )
      throw new Error('Native SDK recovery endpoint cannot change');
    await this.state.persist('endpoint', { port }, async () => ({ port }));
    this.port = port;
  }

  async prepare(
    token: Readonly<MemberProcessToken>
  ): Promise<{ url: string; bearerToken: string }> {
    this.stopping.signal.throwIfAborted();
    if (this.port === null) throw new Error('Native SDK HTTP listener is not ready');
    const id = key(token);
    const existing = await this.ports.ledger.getByCommandId({
      namespace: NAMESPACE,
      scopeKey: this.ports.scopeKey,
      commandId: `launch:${id}`,
    });
    const reservation: ApplicationCommandJsonValue = existing?.metadataJson
      ? (JSON.parse(existing.metadataJson) as ApplicationCommandJsonValue)
      : {
          token: this.state.json(token),
          url: `ws://127.0.0.1:${this.port}${PREFIX}${id}`,
          bearerToken: randomBytes(32).toString('base64url'),
        };
    const value = await this.state.persist(`launch:${id}`, reservation, async () => reservation);
    const launch = value as unknown as Launch;
    this.session(launch);
    return { url: launch.url, bearerToken: launch.bearerToken };
  }

  async registerProcess(
    token: Readonly<MemberProcessToken>,
    identity: Readonly<OwnedProcessIdentity>,
    startedAt: number
  ): Promise<void> {
    this.stopping.signal.throwIfAborted();
    const session = this.requireSession(token);
    if (!Number.isFinite(startedAt))
      throw new Error('Native SDK requires verified OS process birth');
    await this.ports.assertAuthorized(token, identity);
    await this.state.persist(
      `process:${key(token)}`,
      this.state.json({ ...identity, startedAt }),
      async () => this.state.json({ ...identity, startedAt })
    );
    // The native session survives an app epoch; only its verified current authority is rebound.
    session.launch.token = { ...token };
    session.identity = { ...identity };
    session.startedAt = startedAt;
    session.processRegistered();
  }

  async rememberConnection(
    token: Readonly<MemberProcessToken>,
    evidence: NativeClaudeSdkRecovery
  ): Promise<void> {
    await this.state.persist(`connection:${key(token)}`, this.state.json(evidence), async () =>
      this.state.json(evidence)
    );
    this.requireSession(token).recovery = evidence;
  }

  async recoverConnection(token: Readonly<MemberProcessToken>): Promise<NativeClaudeSdkRecovery> {
    const session = this.requireSession(token);
    const evidence = (await this.state.readResult(
      `connection:${key(token)}`
    )) as unknown as NativeClaudeSdkRecovery;
    session.recovery = evidence;
    return evidence;
  }

  hasAuthenticatedConnection(
    token: Readonly<MemberProcessToken>,
    identity: Readonly<OwnedProcessIdentity>
  ): boolean {
    const session = this.sessions.get(key(token));
    return (
      session !== undefined &&
      session.socket?.readyState === WebSocket.OPEN &&
      session.identity?.pid === identity.pid &&
      session.identity.birthId === identity.birthId &&
      session.launch.token.appInstanceId === token.appInstanceId &&
      session.launch.token.connectionGeneration === token.connectionGeneration
    );
  }

  ownsMailbox(
    token: Readonly<MemberProcessToken>,
    identity: Readonly<OwnedProcessIdentity>
  ): boolean {
    const session = this.sessions.get(key(token));
    return (
      session?.recovery?.mailboxOwner === 'runtime' &&
      session.identity?.pid === identity.pid &&
      session.identity.birthId === identity.birthId &&
      session.launch.token.appInstanceId === token.appInstanceId &&
      session.launch.token.connectionGeneration === token.connectionGeneration
    );
  }

  /** Output is bootstrap evidence; a successful WebSocket upgrade never emits connected. */
  subscribe(
    token: Readonly<MemberProcessToken>,
    events: {
      output(line: string, evidence: NativeClaudeSdkOutputEvidence): void;
      opened?(): void;
      disconnected(): void;
      failed(error: Error): void;
    }
  ): () => void {
    const session = this.requireSession(token);
    const subscription = { ...events, seen: new Set<string>() };
    session.listeners.add(subscription);
    if (session.socket?.readyState === WebSocket.OPEN) events.opened?.();
    session.serial = session.serial
      .then(() => this.rebuild(session))
      .catch((error: unknown) =>
        events.failed(error instanceof Error ? error : new Error('Native SDK replay failed'))
      );
    return () => {
      session.listeners.delete(subscription);
    };
  }

  /** The caller supplies the existing durable operation UUID; a send callback is not execution. */
  async deliver(token: Readonly<MemberProcessToken>, uuid: string, line: string): Promise<void> {
    this.stopping.signal.throwIfAborted();
    if (!uuid || /[\r\n]/.test(line) || Buffer.byteLength(line) > MAX_FRAME)
      throw new Error('Native SDK command must be one bounded JSON line with a durable UUID');
    const value: unknown = JSON.parse(line);
    if (
      !record(value) ||
      !['user', 'control_request', 'control_response'].includes(String(value.type))
    )
      throw new Error('Unsupported native SDK command');
    if (value.uuid !== undefined && value.uuid !== uuid)
      throw new Error('Native SDK command UUID conflict');
    if (
      value.type === 'control_request' &&
      (typeof value.request_id !== 'string' || !value.request_id)
    )
      throw new Error('Native SDK control requires request_id');
    if (
      value.type === 'control_response' &&
      (!record(value.response) || typeof value.response.request_id !== 'string')
    )
      throw new Error('Native SDK permission response requires response.request_id');
    const event = this.state.json({ ...value, uuid }) as NativeClaudeSdkEvent;
    const session = this.requireSession(token);
    const send = async (): Promise<null> => {
      this.stopping.signal.throwIfAborted();
      await this.authorize(session);
      if (session.socket?.readyState !== WebSocket.OPEN)
        throw new Error('Native SDK member is disconnected');
      const ackId =
        value.type === 'control_request'
          ? String(value.request_id)
          : value.type === 'control_response' && record(value.response)
            ? String(value.response.request_id)
            : uuid;
      if (session.pending.has(ackId))
        throw new Error('Native SDK command already awaits acknowledgment');
      const { promise, resolve, reject } = deferred<void>();
      const timer = setTimeout(
        () => finish(new Error('Native SDK command acknowledgment is unknown')),
        30_000
      );
      const finish = (error?: Error): void => {
        clearTimeout(timer);
        session.pending.delete(ackId);
        if (error) reject(error);
        else resolve();
      };
      session.pending.set(ackId, {
        resolve: () => finish(),
        reject: (error) => finish(error),
        matches: (receipt) => this.acknowledges(receipt, event),
      });
      session.socket.send(`${JSON.stringify(event)}\n`, (error?: Error) => {
        if (error) finish(error);
      });
      await promise;
      return null;
    };
    const delivery = this.ports.runner.run(
      {
        namespace: NAMESPACE,
        scopeKey: this.scope(token),
        commandId: uuid,
        idempotencyKey: uuid,
        operation: 'sdk-command',
        payload: event,
        metadata: event,
        classifyError: () => ({ failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout }),
        reconcile: async () => {
          const receipts = await this.ports.ledger.listByScope({
            namespace: NAMESPACE,
            scopeKey: this.scope(token),
          });
          for (const receipt of receipts) {
            if (
              receipt.operation !== 'sdk-event' ||
              receipt.status !== ApplicationCommandLedgerStatus.Completed
            )
              continue;
            const metadata = receipt.metadataJson
              ? (JSON.parse(receipt.metadataJson) as unknown)
              : null;
            const prior = record(metadata) && record(metadata.event) ? metadata.event : null;
            if (record(prior) && this.acknowledges(prior, event))
              return { outcome: 'applied', result: null };
          }
          // Native user-message UUID dedup makes this exact retry safe. Controls need explicit reconciliation.
          if (event.type === 'user') return { outcome: 'applied', result: await send() };
          return {
            outcome: 'unknown',
            message: 'Native control response was not durably observed',
          };
        },
      },
      send
    );
    this.commands.add(delivery);
    try {
      await delivery;
    } finally {
      this.commands.delete(delivery);
    }
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping.abort(new Error('Application SDK host stopping'));
    this.server?.removeListener('upgrade', this.upgrade);
    this.server = null;
    for (const session of this.sessions.values()) {
      session.socket?.close(1001, 'Application host stopping');
      this.disconnected(session);
    }
    this.closing = Promise.all([
      ...this.admissions,
      Promise.allSettled(this.commands),
      ...[...this.sessions.values()].map((session) => session.serial),
    ]).then(
      () =>
        new Promise<void>((closed) => {
          // The application closes its HTTP listener once this host is gone, and an unfinished
          // socket close keeps that listener open. Awaiting the handshake also lets a surviving
          // member finish recording the bootstrap receipt it is waiting for.
          this.webSockets.close(() => closed());
        })
    );
    return this.closing;
  }

  private async accept(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    signal: AbortSignal
  ): Promise<void> {
    const address = this.server?.address();
    if (
      !address ||
      typeof address === 'string' ||
      request.headers.origin !== undefined ||
      request.headers.host !== `127.0.0.1:${address.port}` ||
      !isLoopbackPeerAddress(request.socket.remoteAddress)
    )
      throw new Error('Native SDK requires a non-browser loopback upgrade');
    const session = [...this.sessions.values()].find(
      (candidate) => new URL(candidate.launch.url).pathname === request.url
    );
    const authorization = request.headers.authorization;
    if (!session || typeof authorization !== 'string')
      throw new Error('Unknown native SDK attempt');
    const actual = Buffer.from(authorization);
    const expected = Buffer.from(`Bearer ${session.launch.bearerToken}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new Error('Native SDK authorization refused');
    if (!session.identity) {
      const timeout = deferred<never>();
      const timer = setTimeout(
        () => timeout.reject(new Error('Native SDK registration did not complete')),
        60_000
      );
      try {
        await awaitWithAbort(Promise.race([session.registered, timeout.promise]), signal);
      } finally {
        clearTimeout(timer);
      }
    }
    await awaitWithAbort(this.authorize(session), signal);
    // Rebuild volatile tool correlation before accepting a new tool_result after application restart.
    await this.rebuild(session);
    signal.throwIfAborted();
    await awaitWithAbort(this.authorize(session), signal);
    const inspection = await awaitWithAbort(inspectProcessByPid(session.identity!.pid), signal);
    if (inspection.status !== 'found' || inspection.startedAt !== session.startedAt)
      throw new Error('Native SDK process birth authority refused');
    signal.throwIfAborted();
    this.webSockets.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      const previous = session.socket;
      session.socket = ws;
      previous?.close(1001, 'Native SDK connection replaced');
      for (const listener of session.listeners) listener.opened?.();
      let carry = '';
      ws.on('message', (bytes: RawData, binary: boolean) => {
        if (this.stopping.signal.aborted || session.socket !== ws) return;
        if (binary) {
          ws.close(1003, 'Native SDK requires JSON text');
          return;
        }
        carry += bytes.toString();
        if (Buffer.byteLength(carry) > MAX_FRAME) {
          ws.close(1009, 'Native SDK frame too large');
          return;
        }
        const lines = carry.split('\n');
        carry = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          session.serial = session.serial
            .then(async () => {
              if (session.socket !== ws) throw new Error('Native SDK connection superseded');
              const parsed: unknown = JSON.parse(line);
              if (!record(parsed)) throw new Error('Native SDK event must be an object');
              await this.consume(session, parsed as NativeClaudeSdkEvent);
            })
            .catch((error: unknown) => {
              const failure =
                error instanceof Error ? error : new Error('Native SDK event ingestion failed');
              for (const listener of session.listeners) listener.failed(failure);
              ws.close(1011, 'Native SDK ingestion failed');
              if (session.socket === ws) {
                session.socket = null;
                this.disconnected(session);
              }
            });
        }
      });
      ws.on('error', () => ws.close());
      ws.on('close', () => {
        if (session.socket === ws) {
          session.socket = null;
          this.disconnected(session);
        }
      });
    });
  }

  private async consume(session: Session, event: NativeClaudeSdkEvent): Promise<void> {
    await this.authorize(session);
    if (event.type === 'keep_alive') return;
    if (typeof event.uuid !== 'string' || !event.uuid)
      throw new Error('Durable native SDK event requires uuid');
    const scopeKey = this.scope(session.launch.token);
    const prior = await this.ports.ledger.getByCommandId({
      namespace: NAMESPACE,
      scopeKey,
      commandId: `event:${event.uuid}`,
    });
    const completed = prior?.status === ApplicationCommandLedgerStatus.Completed;
    const priorMetadata: unknown = prior?.metadataJson ? JSON.parse(prior.metadataJson) : null;
    const sequence =
      record(priorMetadata) && Number.isSafeInteger(priorMetadata.sequence)
        ? Number(priorMetadata.sequence)
        : ++session.nextSequence;
    const observe = async (): Promise<void> => {
      if (typeof event.session_id === 'string' && event.session_id) {
        await this.ports.observe(
          { teamName: session.launch.token.teamName, sessionId: event.session_id },
          event
        );
      } else if (
        record(event.message) &&
        Array.isArray(event.message.content) &&
        event.message.content.some(
          (block) => record(block) && ['tool_use', 'tool_result'].includes(String(block.type))
        )
      ) {
        throw new Error('Native SDK tool event requires session identity');
      }
    };
    await this.ports.runner.run(
      {
        namespace: NAMESPACE,
        scopeKey,
        commandId: `event:${event.uuid}`,
        idempotencyKey: `event:${event.uuid}`,
        operation: 'sdk-event',
        payload: event,
        metadata: { event, sequence },
        classifyError: () => ({ failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout }),
        reconcile: async () => {
          // The existing observer's scope writer is idempotent; retry an uncommitted binding, never a tool invocation.
          await observe();
          return { outcome: 'applied', result: null };
        },
      },
      async () => {
        await observe();
        return null;
      }
    );
    if (completed && event.type === 'assistant') await observe();
    await this.authorize(session);
    if (this.stopping.signal.aborted) return;
    const evidence = {
      permissionResponseConsumed: await this.permissionEchoConsumed(session, event),
    };
    for (const listener of session.listeners) {
      if (listener.seen.has(event.uuid)) continue;
      listener.output(JSON.stringify(event), evidence);
      listener.seen.add(event.uuid);
    }
    const ackId =
      event.type === 'user' && typeof event.uuid === 'string'
        ? event.uuid
        : event.type === 'control_response' &&
            record(event.response) &&
            typeof event.response.request_id === 'string'
          ? event.response.request_id
          : null;
    const pending = ackId ? session.pending.get(ackId) : null;
    if (pending?.matches(event)) pending.resolve();
  }

  private async rebuild(session: Session): Promise<void> {
    if (this.stopping.signal.aborted) return;
    const rows = await this.ports.ledger.listByScope({
      namespace: NAMESPACE,
      scopeKey: this.scope(session.launch.token),
    });
    const receipts = rows
      .filter((row) => row.operation === 'sdk-event' && row.metadataJson)
      .map((row) => ({
        row,
        metadata: JSON.parse(row.metadataJson!) as {
          event: NativeClaudeSdkEvent;
          sequence: number;
        },
      }));
    for (const { row, metadata } of receipts.sort(
      (a, b) => a.metadata.sequence - b.metadata.sequence
    )) {
      if (!Number.isSafeInteger(metadata.sequence) || !record(metadata.event))
        throw new Error('Native SDK receipt order is invalid');
      session.nextSequence = Math.max(session.nextSequence, metadata.sequence);
      if (row.status !== ApplicationCommandLedgerStatus.Completed) continue;
      const event = metadata.event;
      if (event.type === 'assistant' && typeof event.session_id === 'string')
        await this.ports.observe(
          { teamName: session.launch.token.teamName, sessionId: event.session_id },
          event
        );
      if (typeof event.uuid !== 'string') throw new Error('Native SDK receipt identity is invalid');
      const evidence = {
        permissionResponseConsumed: await this.permissionEchoConsumed(session, event),
      };
      for (const listener of session.listeners) {
        if (listener.seen.has(event.uuid)) continue;
        listener.output(JSON.stringify(event), evidence);
        listener.seen.add(event.uuid);
      }
    }
  }

  private async permissionEchoConsumed(
    session: Session,
    event: NativeClaudeSdkEvent
  ): Promise<boolean> {
    if (
      event.type !== 'control_response' ||
      !record(event.response) ||
      event.response.subtype !== 'success'
    )
      return false;
    const rows = await this.ports.ledger.listByScope({
      namespace: NAMESPACE,
      scopeKey: this.scope(session.launch.token),
    });
    return rows.some((row) => {
      if (row.operation !== 'sdk-command' || !row.metadataJson) return false;
      const command = JSON.parse(row.metadataJson) as NativeClaudeSdkEvent;
      return command.type === 'control_response' && this.acknowledges(event, command);
    });
  }

  private acknowledges(receipt: Record<string, unknown>, command: NativeClaudeSdkEvent): boolean {
    if (command.type === 'user') return receipt.type === 'user' && receipt.uuid === command.uuid;
    if (receipt.type !== 'control_response' || !record(receipt.response)) return false;
    if (command.type === 'control_response')
      return (
        record(command.response) &&
        receipt.response.request_id === command.response.request_id &&
        JSON.stringify(receipt.response) === JSON.stringify(command.response)
      );
    return receipt.response.request_id === command.request_id;
  }
  private scope(token: Readonly<MemberProcessToken>): string {
    return `${this.ports.scopeKey}:${key(token)}`;
  }
  private async authorize(session: Session): Promise<void> {
    if (!session.identity) throw new Error('Native SDK process identity is not registered');
    await this.ports.assertAuthorized(session.launch.token, session.identity);
  }
  private requireSession(token: Readonly<MemberProcessToken>): Session {
    const session = this.sessions.get(key(token));
    if (!session) throw new Error('Native SDK launch is not registered');
    return session;
  }
  private session(launch: Launch): Session {
    const id = key(launch.token);
    let session = this.sessions.get(id);
    if (!session) {
      const registration = deferred<void>();
      session = {
        launch,
        identity: null,
        recovery: null,
        startedAt: null,
        registered: registration.promise,
        processRegistered: registration.resolve,
        socket: null,
        serial: Promise.resolve(),
        nextSequence: 0,
        listeners: new Set(),
        pending: new Map(),
      };
      this.sessions.set(id, session);
    }
    return session;
  }
  private disconnected(session: Session): void {
    for (const pending of session.pending.values())
      pending.reject(new Error('Native SDK command outcome unknown after disconnect'));
    session.pending.clear();
    for (const listener of session.listeners) listener.disconnected();
  }
}
