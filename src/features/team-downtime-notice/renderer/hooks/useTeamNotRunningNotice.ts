import { useCallback, useEffect } from 'react';

import { useStore } from '@renderer/store';
import { selectTeamMessages } from '@renderer/store/team/teamMessagesCache';
import { useStore as useVanillaStore } from 'zustand';

import { shouldPresentDowntimeEpisode } from '../../core/domain/downtimeEpisode';
import { countOwnerQueuedMessages } from '../state/ownerQueue';
import { teamDowntimeStore } from '../state/teamDowntimeStore';

import type { TeamNotRunningDialogProps } from '../ui/TeamNotRunningDialog';

export interface TeamNotRunningNoticeParams {
  teamName: string;
  /** The single liveness signal of the team view (`data.isAlive`). */
  isAlive: boolean;
  isProvisioning: boolean;
  isLaunchDialogOpen: boolean;
  isTabActive: boolean;
  /** Opens the one existing launch form. */
  onLaunch: () => void;
}

/** Everything the dialog needs except the team name. */
export function useTeamNotRunningNotice(
  params: TeamNotRunningNoticeParams
): Omit<TeamNotRunningDialogProps, 'teamName'> {
  const { teamName, isAlive, isProvisioning, isLaunchDialogOpen, isTabActive, onLaunch } = params;
  const episode = useVanillaStore(teamDowntimeStore, (state) => state.episodes[teamName]);
  const queuedCount = useStore((state) =>
    countOwnerQueuedMessages(selectTeamMessages(state, teamName))
  );

  useEffect(() => {
    if (isAlive) teamDowntimeStore.getState().clear(teamName);
  }, [isAlive, teamName]);

  const dismiss = useCallback(() => teamDowntimeStore.getState().dismiss(teamName), [teamName]);
  const launch = useCallback(() => {
    dismiss();
    onLaunch();
  }, [dismiss, onLaunch]);

  return {
    open: shouldPresentDowntimeEpisode(episode, {
      isTabActive,
      isAlive,
      isProvisioning,
      isLaunchDialogOpen,
    }),
    episode: episode ?? null,
    queuedCount,
    onClose: dismiss,
    onLaunch: launch,
  };
}
