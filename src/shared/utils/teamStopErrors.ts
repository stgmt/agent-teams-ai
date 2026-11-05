/** The previous run's stop returned, but task activity could not be finalized. */
export const TASK_ACTIVITY_STOP_UNCONFIRMED = 'task_activity_interval_pause_failed_after_stop';

export class TaskActivityStopError extends Error {
  readonly code = TASK_ACTIVITY_STOP_UNCONFIRMED;

  constructor(
    readonly pendingTransition: boolean,
    readonly cleanupUnconfirmed = false
  ) {
    const instruction = pendingTransition
      ? 'Inspect the pending review transition on the board, resolve it if possible, then check the task timer.'
      : 'Inspect the team tasks and task timers before deciding what to do next.';
    const detail = cleanupUnconfirmed
      ? 'Stop-state publication or cleanup and task timers could not be confirmed.'
      : 'Task timers could not be confirmed.';
    super(
      `${TASK_ACTIVITY_STOP_UNCONFIRMED}:${pendingTransition ? 'pending' : 'unknown'}:${cleanupUnconfirmed ? 'cleanup_unconfirmed:' : ''} Stop for the previous run completed. ${detail} Check whether a new run has started. ${instruction}`
    );
    this.name = 'TaskActivityStopError';
  }
}

/** A separate cleanup/publication outcome can also be uncertain. */
export function isTaskActivityStopCleanupUnconfirmed(error: unknown): boolean {
  if (error instanceof TaskActivityStopError) return error.cleanupUnconfirmed;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.startsWith(`${TASK_ACTIVITY_STOP_UNCONFIRMED}:pending:cleanup_unconfirmed:`) ||
    message.startsWith(`${TASK_ACTIVITY_STOP_UNCONFIRMED}:unknown:cleanup_unconfirmed:`)
  );
}

/** Preserve the pending-review distinction across string-only IPC and HTTP. */
export function isTaskActivityStopPendingReview(error: unknown): boolean {
  if (error instanceof TaskActivityStopError) return error.pendingTransition;
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${TASK_ACTIVITY_STOP_UNCONFIRMED}:pending:`);
}

/** IPC and HTTP preserve only error text; use the dedicated prefix at that boundary. */
export function isTaskActivityStopError(error: unknown): boolean {
  if (error instanceof TaskActivityStopError) return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${TASK_ACTIVITY_STOP_UNCONFIRMED}:`);
}
