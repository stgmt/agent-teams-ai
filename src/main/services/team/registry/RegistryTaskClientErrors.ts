import type { RegistryTaskRefusal } from './RegistryTaskClientTypes';

/**
 * Typed failures of the registry task client. Every failure mode is explicit:
 * the client never falls back to a local task store, so a caller that sees one
 * of these knows the registry did not confirm the write.
 */
export type RegistryTaskClientErrorCode =
  | 'MISSING_TOKEN'
  | 'INVALID_URL'
  | 'TOKEN_READ_FAILED'
  | 'CREDENTIAL_STORE_UNREADABLE'
  | 'INVALID_ARGUMENT'
  | 'UNAUTHORIZED'
  | 'HTTP_ERROR'
  | 'TRANSPORT_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'INVALID_RESPONSE'
  | 'RPC_ERROR'
  | 'REGISTRY_REQUEST_FAILED'
  | 'REGISTRY_REFUSED'
  | 'STATUS_CONFLICT';

export interface RegistryTaskClientErrorInit {
  code: RegistryTaskClientErrorCode;
  message: string;
  operation?: string | null;
  registryCode?: string | null;
  retryable?: boolean;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

/**
 * Base error. `details` never carries the bearer token: transports redact it
 * before any server-provided text reaches a message or a detail field.
 */
export class RegistryTaskClientError extends Error {
  readonly code: RegistryTaskClientErrorCode;
  readonly operation: string | null;
  readonly registryCode: string | null;
  readonly retryable: boolean;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(init: RegistryTaskClientErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.code = init.code;
    this.operation = init.operation ?? null;
    this.registryCode = init.registryCode ?? null;
    this.retryable = init.retryable ?? false;
    this.details = init.details ?? {};
  }
}

/** Configuration could not be resolved; no request was made. */
export class RegistryTaskClientConfigError extends RegistryTaskClientError {}

/** The registry rejected the bearer token (HTTP 401/403). */
export class RegistryTaskAuthenticationError extends RegistryTaskClientError {
  readonly status: number;

  constructor(status: number, operation: string) {
    super({
      code: 'UNAUTHORIZED',
      message: `spec registry rejected the bearer token (HTTP ${status})`,
      operation,
      details: { status },
    });
    this.status = status;
  }
}

/** The registry answered with an unexpected HTTP status. */
export class RegistryTaskHttpError extends RegistryTaskClientError {
  readonly status: number;

  constructor(status: number, operation: string) {
    super({
      code: 'HTTP_ERROR',
      message: `spec registry answered HTTP ${status}`,
      operation,
      details: { status },
    });
    this.status = status;
  }
}

/** The request never reached the registry (DNS, refused connection, reset). */
export class RegistryTaskTransportError extends RegistryTaskClientError {
  constructor(operation: string, endpointHost: string, cause: unknown) {
    super({
      code: 'TRANSPORT_ERROR',
      message: `spec registry request failed before a response (${endpointHost})`,
      operation,
      retryable: true,
      details: { endpointHost },
      cause,
    });
  }
}

/** The request exceeded the configured deadline. */
export class RegistryTaskTimeoutError extends RegistryTaskClientError {
  readonly timeoutMs: number;

  constructor(operation: string, timeoutMs: number) {
    super({
      code: 'TIMEOUT',
      message: `spec registry request timed out after ${timeoutMs}ms`,
      operation,
      retryable: true,
      details: { timeoutMs },
    });
    this.timeoutMs = timeoutMs;
  }
}

/** The caller's AbortSignal cancelled the request. */
export class RegistryTaskAbortedError extends RegistryTaskClientError {
  constructor(operation: string) {
    super({
      code: 'ABORTED',
      message: 'spec registry request was aborted by the caller',
      operation,
    });
  }
}

/** The registry returned a body the client cannot trust. */
export class RegistryTaskProtocolError extends RegistryTaskClientError {
  constructor(operation: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super({ code: 'INVALID_RESPONSE', message, operation, retryable: false, details });
  }
}

/** JSON-RPC-level failure reported by the MCP endpoint. */
export class RegistryTaskRpcError extends RegistryTaskClientError {
  readonly rpcCode: number;

  constructor(operation: string, rpcCode: number, message: string) {
    super({
      code: 'RPC_ERROR',
      message,
      operation,
      details: { rpcCode },
    });
    this.rpcCode = rpcCode;
  }
}

/** The registry replied `ok: false` (bad request, forbidden path, …). */
export class RegistryTaskRequestFailedError extends RegistryTaskClientError {
  constructor(operation: string, code: string, message: string, retryable: boolean) {
    super({
      code: 'REGISTRY_REQUEST_FAILED',
      message,
      operation,
      registryCode: code,
      retryable,
      details: { registryCode: code },
    });
  }
}

/**
 * `replace_task_status` lost an expectedStatus race. `currentStatus` is the
 * registry's observed status at refusal time; the caller must re-read and
 * decide instead of retrying blindly.
 */
export class RegistryStatusConflictError extends RegistryTaskClientError {
  readonly currentStatus: string | null;
  readonly expectedStatus: string | null;
  readonly localId: string | null;

  constructor(input: {
    operation: string;
    message: string;
    currentStatus: string | null;
    expectedStatus: string | null;
    localId: string | null;
  }) {
    super({
      code: 'STATUS_CONFLICT',
      message: input.message,
      operation: input.operation,
      registryCode: 'STATUS_CONFLICT',
      details: {
        currentStatus: input.currentStatus,
        expectedStatus: input.expectedStatus,
        localId: input.localId,
      },
    });
    this.currentStatus = input.currentStatus;
    this.expectedStatus = input.expectedStatus;
    this.localId = input.localId;
  }
}

/** A structured write was refused for a reason other than a status race. */
export class RegistryTaskWriteRefusedError extends RegistryTaskClientError {
  readonly refusal: RegistryTaskRefusal;

  constructor(operation: string, refusal: RegistryTaskRefusal) {
    super({
      code: 'REGISTRY_REFUSED',
      message: refusal.message,
      operation,
      registryCode: refusal.code,
      retryable: refusal.retryable,
      details: { refusal },
    });
    this.refusal = refusal;
  }
}
