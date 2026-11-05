import { RegistryTaskClientError, RegistryTaskWriteRefusedError } from './RegistryTaskClientErrors';

export type RegistryTeamTaskWriteErrorCode =
  | 'REQUIREMENTS_REQUIRED'
  | 'LOCAL_ID_TAKEN'
  | 'TASK_NOT_FOUND'
  | 'STATUS_CONFLICT'
  | 'STATUS_UNSUPPORTED'
  | 'OWNER_CLEAR_UNSUPPORTED'
  | 'LINK_CYCLE'
  | 'REGISTRY_REFUSED'
  | 'OPERATION_UNSUPPORTED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CREATION_OUTCOME_UNKNOWN'
  | 'DESCRIPTION_UNSUPPORTED'
  | 'RELATIONSHIP_PARTIAL'
  | 'RELATIONSHIP_OUTCOME_UNKNOWN';

/**
 * Typed failure of a canonical write. `code` is stable; the message is safe to
 * show in the renderer and never contains registry tokens.
 */
export class RegistryTeamTaskWriteError extends Error {
  readonly code: RegistryTeamTaskWriteErrorCode;
  readonly taskId: string | null;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: RegistryTeamTaskWriteErrorCode,
    message: string,
    options: {
      taskId?: string | null;
      details?: Readonly<Record<string, unknown>>;
      cause?: unknown;
    } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'RegistryTeamTaskWriteError';
    this.code = code;
    this.taskId = options.taskId ?? null;
    this.details = options.details ?? {};
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function refusalToWriteError(
  error: RegistryTaskWriteRefusedError,
  operation: string,
  taskId: string | null
): RegistryTeamTaskWriteError {
  return new RegistryTeamTaskWriteError(
    'REGISTRY_REFUSED',
    `The spec registry refused ${operation}: ${error.message}`,
    {
      taskId,
      details: {
        registryCode: error.refusal.code,
        retryable: error.refusal.retryable,
        currentStatus: error.refusal.currentStatus,
      },
      cause: error,
    }
  );
}

/** Client failures stay typed; unknown values must not look like a successful write. */
export function toTypedWriteError(
  error: unknown,
  operation: string,
  taskId: string | null
): RegistryTeamTaskWriteError {
  if (error instanceof RegistryTeamTaskWriteError) return error;
  if (error instanceof RegistryTaskWriteRefusedError) {
    return refusalToWriteError(error, operation, taskId);
  }
  if (error instanceof RegistryTaskClientError) {
    return new RegistryTeamTaskWriteError(
      'REGISTRY_REFUSED',
      `The spec registry did not confirm ${operation}: ${error.message}`,
      {
        taskId,
        details: {
          clientCode: error.code,
          registryCode: error.registryCode,
          retryable: error.retryable,
        },
        cause: error,
      }
    );
  }
  return new RegistryTeamTaskWriteError(
    'REGISTRY_REFUSED',
    `The spec registry did not confirm ${operation}: ${error instanceof Error ? error.message : String(error)}`,
    { taskId, cause: error }
  );
}
