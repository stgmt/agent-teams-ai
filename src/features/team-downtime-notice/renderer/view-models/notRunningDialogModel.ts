import type { DowntimeEpisode, ProcessExit } from '../../core/domain/downtimeEpisode';

export type NotRunningReasonKey =
  | 'detail.notRunning.exitedAt'
  | 'detail.notRunning.exitedNormally'
  | 'detail.notRunning.exitedNoCode'
  | 'detail.notRunning.savedForLater';

export interface NotRunningText<TKey extends string> {
  key: TKey;
  values: Record<string, string | number>;
}

export interface NotRunningDialogModel {
  /** Why the team does not answer: the witnessed exit, or only that the message was saved. */
  reason: NotRunningText<NotRunningReasonKey>;
  /** The owner just wrote and the exit is already the reason: say the message was saved. */
  saved: NotRunningText<'detail.notRunning.savedForLater'> | null;
  /** Owner messages still waiting for the team; shown when the owner did not just write. */
  queued: NotRunningText<'detail.notRunning.queued'> | null;
  /** Last lines of the process log; only after a witnessed exit. */
  details: string | null;
}

const SAVED_FOR_LATER: NotRunningText<'detail.notRunning.savedForLater'> = {
  key: 'detail.notRunning.savedForLater',
  values: {},
};

function exitText(
  exit: ProcessExit,
  formatTime: (iso: string) => string
): NotRunningText<NotRunningReasonKey> {
  const time = formatTime(exit.occurredAt);
  if (exit.exitCode === null) {
    return { key: 'detail.notRunning.exitedNoCode', values: { time } };
  }
  if (exit.exitCode === 0) {
    return { key: 'detail.notRunning.exitedNormally', values: { time } };
  }
  return { key: 'detail.notRunning.exitedAt', values: { time, code: exit.exitCode } };
}

export function buildNotRunningDialogModel(
  episode: DowntimeEpisode,
  queuedCount: number,
  formatTime: (iso: string) => string
): NotRunningDialogModel {
  const { exit, ownerMessageAt } = episode;
  if (!exit) {
    return { reason: SAVED_FOR_LATER, saved: null, queued: null, details: null };
  }
  const ownerJustWrote = ownerMessageAt !== null;
  return {
    reason: exitText(exit, formatTime),
    saved: ownerJustWrote ? SAVED_FOR_LATER : null,
    queued:
      !ownerJustWrote && queuedCount > 0
        ? { key: 'detail.notRunning.queued', values: { queued: queuedCount } }
        : null,
    details: exit.cliLogsTail?.trim() ? exit.cliLogsTail : null,
  };
}
