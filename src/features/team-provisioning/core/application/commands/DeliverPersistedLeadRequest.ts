import { HumanRequestLedger } from '../../domain/HumanRequestLedger';
import { PreviousDurableRequestActiveError } from '../ports/LeadInputDelivery';

import type { LeadRequestDeliveryReceipt, TeamRunIdentity } from '../../../contracts';
import type {
  LeadRequestDeliveryPorts,
  PersistedLeadRequest,
} from '../ports/LeadRequestDeliveryPorts';

interface Request {
  readonly run: Readonly<TeamRunIdentity>;
  readonly requestMessageId: string;
  input?: PersistedLeadRequest;
  pending?: Promise<LeadRequestDeliveryReceipt>;
  sent: boolean;
  unconfirmed: boolean;
  queued: boolean;
  error?: Error;
  deliveryChecked?: boolean;
  reserved?: boolean;
  deliveredMessageId?: string;
}

function runKey(run: Readonly<TeamRunIdentity>): string {
  return JSON.stringify([
    run.appInstanceId,
    run.dataRootFingerprint,
    run.connectionGeneration,
    run.teamName,
    run.runId,
  ]);
}

function exactMessageId(value: string, maximum = 256): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maximum &&
    value === value.trim() &&
    Array.from(value).every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127
    )
  );
}

/** Orders persisted human admission and exact reply closure; a pipe write is never a reply. */
export class DeliverPersistedLeadRequest {
  private readonly ledger = new HumanRequestLedger<Request>(200);
  private readonly queues = new Map<string, Request[]>();
  private readonly pumping = new Set<string>();

  constructor(private readonly ports: LeadRequestDeliveryPorts) {}

  async execute(
    identity: Readonly<TeamRunIdentity>,
    requestMessageId: string
  ): Promise<LeadRequestDeliveryReceipt> {
    if (!exactMessageId(requestMessageId))
      throw new TypeError('An exact human request identity is required');
    const run = Object.freeze({ ...identity });
    this.ports.assertCurrent(run);
    const scope = runKey(run);
    let request = this.ledger.get(run, requestMessageId);
    if (request?.deliveredMessageId) return request.pending ?? this.receipt(request);
    if (request?.error) {
      if (!request.queued) throw request.error;
      request.error = undefined;
    }
    const active = this.ledger.current(run);
    if (
      active &&
      active !== request &&
      (!active.deliveredMessageId || active.pending || active.unconfirmed)
    ) {
      request ??= this.createRequest(run, requestMessageId);
      this.enqueue(scope, request);
      return this.receipt(request);
    }
    if (!request) request = this.createRequest(run, requestMessageId);
    const wasQueued = request.queued;
    if (wasQueued) this.dequeue(scope, request);
    if (request.pending) return request.pending;
    if (request.deliveredMessageId || request.sent) return this.receipt(request);
    if (request.unconfirmed)
      throw new Error('Lead input delivery is unconfirmed; it must not be resent');
    this.ledger.activate(run, request);
    request.pending = Promise.resolve().then(() => this.prepare(request!));
    try {
      return await request.pending;
    } catch (error) {
      // A durable predecessor still awaiting its exact reply is ordering, not a failure.
      if (error instanceof PreviousDurableRequestActiveError && !request.deliveredMessageId) {
        this.enqueue(scope, request);
        return this.receipt(request);
      }
      throw error;
    } finally {
      request.pending = undefined;
      if (!request.queued && !wasQueued && (!request.input || !request.reserved))
        this.removeRequest(scope, request);
    }
  }

  /** Composition calls this only after the exact app-owned reply has durably reached the inbox. */
  confirmDelivered(
    run: Readonly<TeamRunIdentity>,
    requestMessageId: string,
    messageId: string
  ): void {
    this.ports.assertCurrent(run);
    const scope = runKey(run);
    const request = this.ledger.get(run, requestMessageId);
    if (!request?.input) throw new Error('No matching persisted human request is registered');
    if (!exactMessageId(messageId, 1024))
      throw new Error('An exact delivered message identity is required');
    if (request.deliveredMessageId && request.deliveredMessageId !== messageId)
      throw new Error('Delivered reply identity is already bound');
    request.deliveredMessageId = messageId;
    request.error = undefined;
    this.dequeue(scope, request);
    queueMicrotask(() => this.pump(scope));
  }

  private createRequest(run: Readonly<TeamRunIdentity>, requestMessageId: string): Request {
    return this.ledger.register(
      run,
      requestMessageId,
      () => ({
        run,
        requestMessageId,
        sent: false,
        unconfirmed: false,
        queued: false,
      }),
      (value) => !!value.deliveredMessageId && !value.pending && !value.queued
    );
  }

  private removeRequest(scope: string, request: Request): void {
    this.dequeue(scope, request);
    this.ledger.delete(request.run, request.requestMessageId, request);
  }

  private enqueue(scope: string, request: Request): void {
    if (this.ledger.current(request.run) === request) this.ledger.deactivate(request.run, request);
    if (!request.queued) request.queued = true;
    const queue = this.queues.get(scope) ?? [];
    if (!queue.includes(request)) queue.push(request);
    this.queues.set(scope, queue);
  }

  private dequeue(scope: string, request: Request): void {
    request.queued = false;
    const queue = this.queues.get(scope);
    if (!queue) return;
    const index = queue.indexOf(request);
    if (index >= 0) queue.splice(index, 1);
    if (!queue.length) this.queues.delete(scope);
  }

  private pump(scope: string): void {
    if (this.pumping.has(scope)) return;
    this.pumping.add(scope);
    void this.drain(scope).finally(() => this.pumping.delete(scope));
  }

  private async drain(scope: string): Promise<void> {
    const next = this.queues.get(scope)?.[0];
    if (next) {
      const active = this.ledger.current(next.run);
      if (active && (!active.deliveredMessageId || active.pending || active.unconfirmed)) return;
    }
    if (!next) return;
    try {
      await this.execute(next.run, next.requestMessageId);
    } catch (error) {
      next.error = error instanceof Error ? error : new Error(String(error));
      this.enqueue(scope, next);
    }
  }

  private async prepare(request: Request): Promise<LeadRequestDeliveryReceipt> {
    const { run, requestMessageId } = request;
    this.ports.assertCurrent(run);
    if (!request.input) {
      const saved = await this.ports.read(run, requestMessageId);
      this.ports.assertCurrent(run);
      if (
        !saved ||
        runKey(saved.run) !== runKey(run) ||
        saved.requestMessageId !== requestMessageId ||
        saved.origin?.kind !== 'human' ||
        saved.isMeta !== false ||
        typeof saved.text !== 'string' ||
        !saved.text.trim() ||
        saved.text.length > 64_000
      )
        throw new Error('The exact persisted human request is unavailable');
      request.input = Object.freeze({
        run,
        requestMessageId,
        text: saved.text,
        origin: Object.freeze({ kind: 'human' as const }),
        isMeta: false,
      });
    }
    if (!request.deliveryChecked) {
      const delivered = await this.ports.readDelivered(run, requestMessageId);
      this.ports.assertCurrent(run);
      if (delivered !== null) {
        this.confirmDelivered(run, requestMessageId, delivered);
        return this.receipt(request);
      }
      request.deliveryChecked = true;
    }
    await this.ports.input.reserve(request.input);
    request.reserved = true;
    this.ports.assertCurrent(run);
    // The request is registered before accept: admission may itself deliver a source limitation.
    const instruction = await this.ports.accept(request.input);
    this.ports.assertCurrent(run);
    if (request.deliveredMessageId) return this.receipt(request);
    if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 64_000)
      throw new Error('A bounded app-owned human request instruction is required');
    const text = [
      `App-admitted human request identity: ${requestMessageId}`,
      instruction,
      'Original persisted human message:',
      request.input.text,
    ].join('\n\n');
    const claim = await this.ports.input.claim(request.input);
    this.ports.assertCurrent(run);
    if (request.deliveredMessageId) return this.receipt(request);
    if (claim.state === 'sent') {
      request.sent = true;
      return this.receipt(request);
    }
    request.unconfirmed = true;
    if (claim.state === 'unconfirmed')
      throw new Error('Lead input delivery is unconfirmed; it must not be resent');
    try {
      await this.ports.send(run, text);
      await this.ports.input.sent(request.input, claim.operationId);
      request.sent = true;
      request.unconfirmed = false;
    } catch (cause) {
      if (!request.deliveredMessageId) {
        request.unconfirmed = true;
        throw new Error('Lead input delivery is unconfirmed; it must not be resent', { cause });
      }
    }
    this.ports.assertCurrent(run);
    return this.receipt(request);
  }

  private receipt(request: Request): LeadRequestDeliveryReceipt {
    return Object.freeze({
      requestMessageId: request.requestMessageId,
      state: request.deliveredMessageId ? 'delivered' : request.queued ? 'queued' : 'sent',
    });
  }
}
