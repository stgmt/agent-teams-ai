import {
  isTaskActivityStopCleanupUnconfirmed,
  isTaskActivityStopError,
  isTaskActivityStopPendingReview,
} from '@shared/utils/teamStopErrors';

export type TeamStopActionOutcome =
  | 'stopped'
  | 'stopped_activity_unconfirmed'
  | 'stopped_activity_review_pending'
  | 'activity_and_cleanup_unconfirmed'
  | 'still_running'
  | 'status_unknown';

export type TeamStopFailureKind = Extract<
  TeamStopActionOutcome,
  | 'still_running'
  | 'status_unknown'
  | 'stopped_activity_unconfirmed'
  | 'stopped_activity_review_pending'
  | 'activity_and_cleanup_unconfirmed'
>;

export interface TeamStopActionPorts {
  teamName: string;
  stop(teamName: string): Promise<void>;
  processAlive(teamName: string): Promise<boolean>;
  refresh(): Promise<void>;
  setBusy(busy: boolean): void;
  reportFailure(kind: TeamStopFailureKind, message: string): void;
  logError(error: unknown): void;
  logRefreshError(error: unknown): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}

/** Runs one stop request, probes an uncertain transport result, and refreshes once. */
export async function runTeamStopAction(
  ports: TeamStopActionPorts
): Promise<TeamStopActionOutcome> {
  ports.setBusy(true);
  let outcome: TeamStopActionOutcome;

  try {
    try {
      await ports.stop(ports.teamName);
      outcome = 'stopped';
    } catch (stopError) {
      ports.logError(stopError);
      if (isTaskActivityStopError(stopError)) {
        outcome = isTaskActivityStopCleanupUnconfirmed(stopError)
          ? 'activity_and_cleanup_unconfirmed'
          : isTaskActivityStopPendingReview(stopError)
            ? 'stopped_activity_review_pending'
            : 'stopped_activity_unconfirmed';
        ports.reportFailure(outcome, errorMessage(stopError));
      } else if (errorMessage(stopError).startsWith('team_stop_unconfirmed:')) {
        // A liveness probe cannot settle an unconfirmed stop or its task-clock writes.
        outcome = 'status_unknown';
        ports.reportFailure(outcome, errorMessage(stopError));
      } else {
        try {
          const alive = await ports.processAlive(ports.teamName);
          outcome = alive ? 'still_running' : 'status_unknown';
          ports.reportFailure(outcome, errorMessage(stopError));
        } catch (probeError) {
          ports.logError(probeError);
          outcome = 'status_unknown';
          ports.reportFailure(outcome, errorMessage(probeError));
        }
      }
    }

    try {
      await ports.refresh();
    } catch (refreshError) {
      ports.logRefreshError(refreshError);
    }

    return outcome;
  } finally {
    ports.setBusy(false);
  }
}
