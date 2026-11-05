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
    signal?: AbortSignal
  ): Promise<RegistryToolEnvelope<unknown>> {
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
          method: 'tools/call',
          params: { name: toolName, arguments: toolArguments },
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

    const envelope = this.#readEnvelope(result, operation);
    if (!envelope.ok) {
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
