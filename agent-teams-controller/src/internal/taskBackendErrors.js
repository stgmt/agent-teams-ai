/**
 * Typed failures of the task backends.
 *
 * The registry backend never falls back to the local task files: a caller that
 * sees one of these errors knows the canonical state is unknown, and that a
 * silently empty board or a partial write would be a lie.
 */

const TASK_BACKEND_ERROR_CODES = Object.freeze({
  /** The control API of the desktop app could not be reached or refused the request. */
  REGISTRY_UNAVAILABLE: 'REGISTRY_UNAVAILABLE',
  /** The control API answered with a payload that is not a TeamTask envelope. */
  REGISTRY_PROTOCOL_ERROR: 'REGISTRY_PROTOCOL_ERROR',
  /** The registry refuses tasks that do not name the requirements they implement. */
  REQUIREMENTS_REQUIRED: 'REQUIREMENTS_REQUIRED',
  /** Optimistic status transition lost a race; `currentStatus` carries the live status. */
  STATUS_CONFLICT: 'STATUS_CONFLICT',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  /** Any other 4xx from the control API. */
  REQUEST_REJECTED: 'REQUEST_REJECTED',
  /** The registry cannot express the mutation the local caller asked for. */
  FIELD_UNSUPPORTED: 'REGISTRY_FIELD_UNSUPPORTED',
  /** The registry cannot clear a task owner. */
  OWNER_CLEAR_UNSUPPORTED: 'OWNER_CLEAR_UNSUPPORTED',
  /** Registry ids are allocated by the registry; a caller cannot choose one. */
  TASK_ID_UNSUPPORTED: 'TASK_ID_UNSUPPORTED',
  /** File-only store operations (creation reconciliation) have no registry shape. */
  OPERATION_UNSUPPORTED: 'REGISTRY_OPERATION_UNSUPPORTED',
});

class TaskBackendError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'TaskBackendError';
    this.code = code;
    if (details && typeof details === 'object') {
      Object.assign(this, details);
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

module.exports = {
  TASK_BACKEND_ERROR_CODES,
  TaskBackendError,
};
