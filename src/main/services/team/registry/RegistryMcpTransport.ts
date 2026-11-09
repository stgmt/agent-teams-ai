import { isRecord, numberOrNull, stringOrNull } from './RegistryJson';
import {
  RegistryTaskAbortedError,
  RegistryTaskAuthenticationError,
  RegistryTaskHttpError,
  RegistryTaskProtocolError,
  RegistryTaskRequestFailedError,
  RegistryTaskRpcError,
  RegistryTaskTimeoutError,
  RegistryTaskTransportError,
} from './RegistryTaskClientErrors';

import type { RegistryEnvelopeError, RegistryToolEnvelope } from './RegistryTaskClientTypes';

/**
 * Minimal MCP Streamable HTTP client for one registry endpoint.
 *
 * The endpoint is stateless for tool calls, so no `initialize` handshake is
 * sent. Both JSON and `text/event-stream` responses are accepted, the bearer
 * token lives in a private field, and every server-provided message is
 * redacted before it can reach an error.
 */
export interface RegistryMcpTransportOptions {
  url: string;
  token: string;
  requestTimeoutMs: number;
  fetchImpl?: typeof globalThis.fetch;
}

const REGISTRY_TIMEOUT_ABORT_REASON = 'registry tool call';

export class RegistryMcpTransport {
  readonly #url: string;
  /** Never logged, never returned; see `redact`. */
  readonly #token: string;
  readonly #requestTimeoutMs: number;
  readonly #fetchImpl: typeof globalThis.fetch;
  readonly #endpointHost: string;
  #nextRequestId = 1;

  constructor(options: RegistryMcpTransportOptions) {
    this.#url = options.url;
    this.#token = options.token;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.#endpointHost = describeHost(options.url);
  }

  /** Removes the bearer token from arbitrary server-provided text. */
  redact(text: string): string {
    return this.#token ? text.split(this.#token).join('[redacted]') : text;
  }

  async callTool(
    toolName: string,
    toolArguments: Record<string, unknown>,
    operation: string,
    signal?: AbortSignal,
    options: { allowTaskGenesisChallenge?: boolean } = {}
  ): Promise<RegistryToolEnvelope<unknown>> {
    const result = await this.#callRpc(
      'tools/call',
      { name: toolName, arguments: toolArguments },
      operation,
      signal
    );
    const envelope = this.#readEnvelope(result, operation);
    if (!envelope.ok) {
      if (
        options.allowTaskGenesisChallenge === true &&
        toolName === 'spec_patch' &&
        operation === 'upsertTask'
      ) {
        validateTaskGenesisChallengeEnvelope(envelope, toolArguments, operation);
        return envelope;
      }
      const failure = envelope.error;
      throw new RegistryTaskRequestFailedError(
        operation,
        failure?.code ?? 'UNKNOWN',
        failure?.message ?? `registry refused ${operation}`,
        failure?.retryable ?? false
      );
    }
    return envelope;
  }

  async listTools(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.#callRpc('tools/list', {}, 'listTools', signal);
  }

  async #callRpc(
    method: string,
    params: Record<string, unknown>,
    operation: string,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      throw new RegistryTaskAbortedError(operation);
    }

    const rpcId = this.#nextRequestId++;
    const scope = createAbortScope(signal, this.#requestTimeoutMs);
    let responseText: string;
    try {
      const response = await this.#fetchImpl(this.#url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.#token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: rpcId,
          method,
          params,
        }),
        signal: scope.signal,
      });

      if (response.status === 401 || response.status === 403) {
        throw new RegistryTaskAuthenticationError(response.status, operation);
      }
      if (!response.ok) {
        throw new RegistryTaskHttpError(response.status, operation);
      }

      responseText = await response.text();
    } catch (error) {
      throw this.#mapTransportFailure(error, operation, scope, signal);
    } finally {
      scope.dispose();
    }

    const message = parseRpcMessage(responseText, operation, rpcId);
    if (!isRecord(message)) {
      throw new RegistryTaskProtocolError(
        operation,
        'registry returned a non-object JSON-RPC message'
      );
    }
    if ('error' in message) {
      throw this.#mapRpcError(message.error, operation);
    }

    const result = message.result;
    if (!isRecord(result)) {
      throw new RegistryTaskProtocolError(operation, 'registry returned no JSON-RPC result');
    }
    return result;
  }

  #readEnvelope(result: Record<string, unknown>, operation: string): RegistryToolEnvelope<unknown> {
    let data: unknown = null;
    const content = result.content;
    if (Array.isArray(content)) {
      const textPart = content.find(
        (part): part is { type?: unknown; text?: unknown } =>
          isRecord(part) && part.type === 'text' && typeof part.text === 'string'
      );
      if (textPart && typeof textPart.text === 'string') {
        try {
          data = JSON.parse(textPart.text);
        } catch (error) {
          throw new RegistryTaskProtocolError(
            operation,
            'registry tool content is not valid JSON',
            { cause: error instanceof Error ? error.message : 'unknown parse failure' }
          );
        }
      }
    }
    if (data === null && isRecord(result.structuredContent)) {
      data = result.structuredContent;
    }
    if (!isRecord(data)) {
      throw new RegistryTaskProtocolError(
        operation,
        'registry tool result carries no JSON envelope'
      );
    }

    const envelope: RegistryToolEnvelope<unknown> = {
      schemaVersion: stringOrNull(data.schemaVersion),
      requestId: stringOrNull(data.requestId),
      operation: stringOrNull(data.operation),
      ok: data.ok === true,
      page: readPage(data.page),
      data: data.data ?? null,
      error: readEnvelopeError(data.error, (text) => this.redact(text)),
      diagnostics: Array.isArray(data.diagnostics) ? data.diagnostics : [],
      provenance: data.provenance ?? null,
    };
    return envelope;
  }

  #mapRpcError(rawError: unknown, operation: string): RegistryTaskRpcError {
    const message = isRecord(rawError) ? stringOrNull(rawError.message) : null;
    const code = isRecord(rawError) && typeof rawError.code === 'number' ? rawError.code : -32_603;
    return new RegistryTaskRpcError(
      operation,
      code,
      this.redact(message ?? `registry JSON-RPC error ${code}`)
    );
  }

  #mapTransportFailure(
    error: unknown,
    operation: string,
    scope: AbortScope,
    callerSignal: AbortSignal | undefined
  ):
    | RegistryTaskAuthenticationError
    | RegistryTaskHttpError
    | RegistryTaskTimeoutError
    | RegistryTaskAbortedError
    | RegistryTaskTransportError {
    if (
      error instanceof RegistryTaskAuthenticationError ||
      error instanceof RegistryTaskHttpError
    ) {
      return error;
    }
    if (scope.timedOut()) {
      return new RegistryTaskTimeoutError(operation, this.#requestTimeoutMs);
    }
    if (callerSignal?.aborted) {
      return new RegistryTaskAbortedError(operation);
    }
    return new RegistryTaskTransportError(operation, this.#endpointHost, error);
  }
}
function validateTaskGenesisChallengeEnvelope(
  envelope: RegistryToolEnvelope<unknown>,
  requestArguments: Record<string, unknown>,
  operation: string
): void {
  const fail = (): never => {
    throw new RegistryTaskProtocolError(
      operation,
      'Registry returned an invalid initial-policy challenge'
    );
  };
  const error = envelope.error;
  const requestId = stringOrNull(requestArguments.requestId);
  const project = stringOrNull(requestArguments.project);
  const spec = stringOrNull(requestArguments.spec);
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
  const digest = /^[0-9a-f]{64}$/u;
  const oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
  if (
    envelope.ok ||
    error === null ||
    error.code !== 'TASK_GENESIS_CHALLENGE_REQUIRED' ||
    error.retryable ||
    requestId === null ||
    envelope.requestId !== requestId ||
    project === null ||
    spec === null
  ) {
    return fail();
  }

  const data = requireRecord(envelope.data, fail);
  const dataKeys = ['outcome', 'batchId', 'requestId', 'payloadDigest', 'challenges'];
  const batchId = stringOrNull(data.batchId);
  const payloadDigest = stringOrNull(data.payloadDigest);
  if (
    Reflect.ownKeys(data).length !== dataKeys.length ||
    !dataKeys.every((key) => Object.hasOwn(data, key)) ||
    data.outcome !== 'CHALLENGE_REQUIRED' ||
    data.requestId !== requestId ||
    batchId === null ||
    !uuid.test(batchId) ||
    payloadDigest === null ||
    !digest.test(payloadDigest)
  ) {
    return fail();
  }
  const challenges = unknownArrayOrFail(data.challenges, fail);
  if (challenges.length === 0) return fail();

  const operations = unknownArrayOrFail(requestArguments.operations, fail);
  const requiredOperations = operations.filter(isRequiredTaskUpsertOperation);
  if (requiredOperations.length !== challenges.length) return fail();

  const operationIds = new Set<string>();
  const nonces = new Set<string>();
  for (let index = 0; index < challenges.length; index++) {
    const challenge = requireRecord(challenges[index], fail);
    const expectedOperation = requiredOperations[index];
    if (expectedOperation === undefined) return fail();
    const teamId = stringOrNull(expectedOperation.teamId);
    const localId = stringOrNull(expectedOperation.localId);
    if (teamId === null || localId === null) return fail();
    const expectedTaskId = localId.startsWith('TASK-') ? localId : `TASK-${localId}`;

    const challengeKeys = ['operationId', 'nonce', 'keyId', 'payload'];
    const operationId = stringOrNull(challenge.operationId);
    const nonce = stringOrNull(challenge.nonce);
    const keyId = stringOrNull(challenge.keyId);
    if (
      Reflect.ownKeys(challenge).length !== challengeKeys.length ||
      !challengeKeys.every((key) => Object.hasOwn(challenge, key)) ||
      operationId === null ||
      !uuid.test(operationId) ||
      operationIds.has(operationId) ||
      nonce === null ||
      !digest.test(nonce) ||
      nonces.has(nonce) ||
      keyId === null ||
      !digest.test(keyId)
    ) {
      return fail();
    }

    const payload = requireChallengePayload(challenge.payload, fail);
    if (payload.length !== 25) return fail();
    const taskId = stringOrNull(payload[8]);
    const generationId = stringOrNull(payload[9]);
    const parentOid = stringOrNull(payload[12]);
    const commitOid = stringOrNull(payload[13]);
    const payloadBatchId = stringOrNull(payload[14]);
    const payloadOperationId = stringOrNull(payload[15]);
    const reservationId = stringOrNull(payload[16]);
    const payloadRequestId = stringOrNull(payload[17]);
    const payloadDigestValue = stringOrNull(payload[18]);
    const creationTokenDigest = stringOrNull(payload[19]);
    const taskRevisionSha256 = stringOrNull(payload[20]);
    const policyDigest = stringOrNull(payload[21]);
    const payloadKeyId = stringOrNull(payload[22]);
    const payloadNonce = stringOrNull(payload[23]);
    const expiresAt = payload[24];
    const serializedPayload = JSON.stringify(payload);
    if (
      payload[0] !== 'omp-spec-kit/task-genesis-attestation@1' ||
      !payload.slice(1, 12).every(isNonEmptyString) ||
      taskId === null ||
      !/^TASK-[1-9][0-9]*$/u.test(taskId) ||
      taskId !== expectedTaskId ||
      generationId === null ||
      !uuid.test(generationId) ||
      parentOid === null ||
      !oid.test(parentOid) ||
      commitOid === null ||
      !oid.test(commitOid) ||
      parentOid.length !== commitOid.length ||
      parentOid === commitOid ||
      payload[4] !== teamId ||
      payload[6] !== project ||
      payload[7] !== spec ||
      payloadBatchId !== batchId ||
      payloadOperationId !== operationId ||
      reservationId === null ||
      !uuid.test(reservationId) ||
      payloadRequestId !== requestId ||
      payloadDigestValue !== payloadDigest ||
      payloadDigestValue === null ||
      !digest.test(payloadDigestValue) ||
      creationTokenDigest === null ||
      !digest.test(creationTokenDigest) ||
      taskRevisionSha256 === null ||
      !digest.test(taskRevisionSha256) ||
      policyDigest === null ||
      !digest.test(policyDigest) ||
      payloadKeyId !== keyId ||
      payloadKeyId === null ||
      !digest.test(payloadKeyId) ||
      payloadNonce !== nonce ||
      payloadNonce === null ||
      !digest.test(payloadNonce) ||
      typeof expiresAt !== 'number' ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= Date.now() ||
      serializedPayload === undefined ||
      Buffer.byteLength(serializedPayload, 'utf8') > 16_384
    ) {
      return fail();
    }
    operationIds.add(operationId);
    nonces.add(nonce);
  }
}

interface RequiredTaskUpsertOperation extends Record<string, unknown> {
  policy: Record<string, unknown> & { required: true };
}

function isRequiredTaskUpsertOperation(value: unknown): value is RequiredTaskUpsertOperation {
  return (
    isRecord(value) &&
    value.kind === 'upsert_task' &&
    isRecord(value.policy) &&
    value.policy.required === true
  );
}

function requireRecord(value: unknown, fail: () => never): Record<string, unknown> {
  if (!isRecord(value)) return fail();
  return value;
}

function unknownArrayOrFail(value: unknown, fail: () => never): readonly unknown[] {
  if (!Array.isArray(value)) return fail();
  return value;
}

type TaskGenesisChallengePayload = readonly (string | number | null)[];

function requireChallengePayload(value: unknown, fail: () => never): TaskGenesisChallengePayload {
  if (!isTaskGenesisChallengePayload(value)) return fail();
  return value;
}

function isTaskGenesisChallengePayload(value: unknown): value is TaskGenesisChallengePayload {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.hasOwn(value, index)) return false;
  }
  return value.every(
    (entry: unknown) => entry === null || typeof entry === 'string' || typeof entry === 'number'
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

interface AbortScope {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
}

function createAbortScope(callerSignal: AbortSignal | undefined, timeoutMs: number): AbortScope {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`${REGISTRY_TIMEOUT_ABORT_REASON} timed out`));
  }, timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

function parseRpcMessage(body: string, operation: string, rpcId: number): unknown {
  const trimmed = body.trim();
  if (trimmed === '') {
    throw new RegistryTaskProtocolError(operation, 'registry returned an empty response body');
  }
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) {
    try {
      return pickRpcMessage(JSON.parse(trimmed), rpcId, operation);
    } catch (error) {
      if (error instanceof RegistryTaskProtocolError) {
        throw error;
      }
      throw new RegistryTaskProtocolError(operation, 'registry returned invalid JSON');
    }
  }

  for (const block of trimmed.split(/\r?\n\r?\n/u)) {
    const payload = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (payload === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const message = pickRpcMessage(parsed, rpcId, operation, true);
    if (message !== null) {
      return message;
    }
  }
  throw new RegistryTaskProtocolError(operation, 'no JSON-RPC message matched the request id');
}

function pickRpcMessage(
  parsed: unknown,
  rpcId: number,
  operation: string,
  fallbackToFirst = false
): unknown {
  if (Array.isArray(parsed)) {
    const match = parsed.find((entry) => isRecord(entry) && entry.id === rpcId);
    return match ?? (fallbackToFirst ? null : (parsed[0] ?? null));
  }
  if (isRecord(parsed)) {
    if (parsed.id === rpcId || fallbackToFirst) {
      return parsed;
    }
    throw new RegistryTaskProtocolError(
      operation,
      'JSON-RPC response id does not match the request'
    );
  }
  return null;
}

function readPage(rawPage: unknown): RegistryToolEnvelope<unknown>['page'] {
  if (!isRecord(rawPage)) {
    return null;
  }
  return {
    limit: numberOrNull(rawPage.limit),
    returned: numberOrNull(rawPage.returned),
    totalMatched: numberOrNull(rawPage.totalMatched),
    cursor: stringOrNull(rawPage.cursor),
    nextCursor: stringOrNull(rawPage.nextCursor),
    truncated: rawPage.truncated === true,
  };
}

function readEnvelopeError(
  rawError: unknown,
  redact: (text: string) => string
): RegistryEnvelopeError | null {
  if (!isRecord(rawError)) {
    return null;
  }
  const message = stringOrNull(rawError.message);
  return {
    code: stringOrNull(rawError.code),
    message: message === null ? null : redact(message),
    retryable: rawError.retryable === true,
    parameter: stringOrNull(rawError.parameter),
    expected: stringOrNull(rawError.expected),
    currentStatus: stringOrNull(rawError.currentStatus),
    expectedStatus: stringOrNull(rawError.expectedStatus),
    localId: stringOrNull(rawError.localId),
    canonicalId: stringOrNull(rawError.canonicalId),
    causeCode: stringOrNull(rawError.causeCode),
  };
}

function describeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return 'invalid-url';
  }
}
