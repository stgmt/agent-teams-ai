/**
 * One outage of one team, from the moment the app learns the team stopped working
 * until it works again (or a launch starts). Two things the owner must hear about:
 * the process exit the app witnessed (`exit`) and every message the owner writes to
 * a team that cannot answer (`ownerMessageAt`). `dismissed` records that the owner
 * has seen the notice and answered it; the next owner message shows it again.
 */
export interface ProcessExit {
  exitCode: number | null;
  occurredAt: string;
  cliLogsTail?: string;
}

export interface DowntimeEpisode {
  exit: ProcessExit | null;
  /** Time of the last owner message written while the team was stopped. */
  ownerMessageAt: string | null;
  dismissed: boolean;
}

/** Everything about the screen that decides whether the notice may appear right now. */
export interface DowntimePresentationContext {
  isTabActive: boolean;
  isAlive: boolean;
  isProvisioning: boolean;
  isLaunchDialogOpen: boolean;
}

/** The first exit wins: a later one describes the same outage and adds nothing. */
export function recordProcessExit(
  current: DowntimeEpisode | undefined,
  exit: ProcessExit
): DowntimeEpisode {
  if (current?.exit) return current;
  return { exit, ownerMessageAt: current?.ownerMessageAt ?? null, dismissed: false };
}

/** Every owner message to a stopped team is news: the result is always a new, shown episode. */
export function recordOwnerMessage(
  current: DowntimeEpisode | undefined,
  occurredAt: string
): DowntimeEpisode {
  return { exit: current?.exit ?? null, ownerMessageAt: occurredAt, dismissed: false };
}

export function dismissDowntimeEpisode(episode: DowntimeEpisode): DowntimeEpisode {
  return episode.dismissed ? episode : { ...episode, dismissed: true };
}

export function shouldPresentDowntimeEpisode(
  episode: DowntimeEpisode | undefined,
  context: DowntimePresentationContext
): boolean {
  return (
    episode !== undefined &&
    !episode.dismissed &&
    context.isTabActive &&
    !context.isAlive &&
    !context.isProvisioning &&
    !context.isLaunchDialogOpen
  );
}
