import { useStore } from '@renderer/store';
import { isTeamProvisioningActive } from '@renderer/store/slices/teamSlice';

import { teamDowntimeStore } from '../state/teamDowntimeStore';

/**
 * Call after the owner's message was accepted. When the team is known to be stopped
 * and no launch is running, the message is only queued: remember that, so the owner
 * is told every time. Same condition as the offline banner of the team view.
 */
export function noteOwnerMessageSent(teamName: string): void {
  const state = useStore.getState();
  if (state.teamDataCacheByName[teamName]?.isAlive !== false) return;
  if (isTeamProvisioningActive(state, teamName)) return;
  teamDowntimeStore.getState().recordOwnerMessage(teamName, new Date().toISOString());
}
