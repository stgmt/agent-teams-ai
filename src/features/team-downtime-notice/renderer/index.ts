import { api } from '@renderer/api';

import { watchTeamDowntime } from './adapters/watchTeamDowntime';
import { teamDowntimeStore } from './state/teamDowntimeStore';

export { noteOwnerMessageSent } from './adapters/noteOwnerMessageSent';
export { TeamNotRunningNotice } from './ui/TeamNotRunningNotice';

/** Starts the live watcher that opens an outage episode when a team process exits. */
export function startTeamDowntimeWatch(): () => void {
  return watchTeamDowntime(
    (listener) => api.teams.onProvisioningProgress(listener),
    teamDowntimeStore
  );
}
