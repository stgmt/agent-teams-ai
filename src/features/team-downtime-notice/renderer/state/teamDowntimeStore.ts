import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  dismissDowntimeEpisode,
  type DowntimeEpisode,
  type ProcessExit,
  recordOwnerMessage,
  recordProcessExit,
} from '../../core/domain/downtimeEpisode';

export interface TeamDowntimeState {
  episodes: Readonly<Record<string, DowntimeEpisode>>;
  recordProcessExit: (teamName: string, exit: ProcessExit) => void;
  recordOwnerMessage: (teamName: string, occurredAt: string) => void;
  dismiss: (teamName: string) => void;
  clear: (teamName: string) => void;
}

export function createTeamDowntimeStore(): StoreApi<TeamDowntimeState> {
  return createStore<TeamDowntimeState>()((set, get) => {
    const setEpisode = (teamName: string, episode: DowntimeEpisode): void => {
      if (get().episodes[teamName] === episode) return;
      set((state) => ({ episodes: { ...state.episodes, [teamName]: episode } }));
    };

    return {
      episodes: {},
      recordProcessExit: (teamName, exit) =>
        setEpisode(teamName, recordProcessExit(get().episodes[teamName], exit)),
      recordOwnerMessage: (teamName, occurredAt) =>
        setEpisode(teamName, recordOwnerMessage(get().episodes[teamName], occurredAt)),
      dismiss: (teamName) => {
        const episode = get().episodes[teamName];
        if (episode) setEpisode(teamName, dismissDowntimeEpisode(episode));
      },
      clear: (teamName) => {
        if (!(teamName in get().episodes)) return;
        set((state) => {
          const episodes = { ...state.episodes };
          delete episodes[teamName];
          return { episodes };
        });
      },
    };
  });
}

export const teamDowntimeStore = createTeamDowntimeStore();
