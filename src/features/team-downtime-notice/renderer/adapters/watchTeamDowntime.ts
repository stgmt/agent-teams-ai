import type { TeamDowntimeState } from '../state/teamDowntimeStore';
import type { TeamProvisioningProgress } from '@shared/types';
import type { StoreApi } from 'zustand/vanilla';

export type ProvisioningProgressSubscribe = (
  listener: (event: unknown, progress: TeamProvisioningProgress) => void
) => () => void;

/**
 * Feeds the downtime store from the live progress stream only. Hydration reads
 * (opening a team that was already stopped) never pass through here, so an old
 * outage does not pop a notice up again.
 */
export function watchTeamDowntime(
  subscribe: ProvisioningProgressSubscribe,
  store: StoreApi<TeamDowntimeState>
): () => void {
  // A run exits once. Later progress of the same run (log refreshes spread the last
  // progress, `disconnect` included) must not open the same outage a second time.
  const reportedExits = new Set<string>();
  return subscribe((_event, progress) => {
    const { teamName } = progress;
    if (progress.state !== 'disconnected') {
      // Any other state means a launch or a live run: the outage is over.
      store.getState().clear(teamName);
      return;
    }
    if (progress.disconnect?.kind === 'process_exit') {
      if (reportedExits.has(progress.runId)) return;
      reportedExits.add(progress.runId);
      store.getState().recordProcessExit(teamName, {
        exitCode: progress.disconnect.exitCode,
        occurredAt: progress.updatedAt,
        cliLogsTail: progress.cliLogsTail,
      });
    } else if (progress.disconnect?.kind === 'user_stop') {
      store.getState().clear(teamName);
    }
  });
}
