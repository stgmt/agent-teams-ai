import {
  toMemberSpawnStatuses,
  toTeamAgentRuntimeSnapshot,
} from '@main/team-runtime/nativeTeamRuntimeProjection';

import type { LifecycleQueries } from '../../core/application/ports/LifecycleQueries';
import type { AppConnectionContext } from '@features/external-agent-connection/contracts';
import type { MemberSpawnStatusesSnapshot, TeamAgentRuntimeSnapshot } from '@shared/types';

export interface TeamLiveStatusQueries {
  memberSpawnStatuses(input: { teamName: string }): Promise<MemberSpawnStatusesSnapshot>;
  runtimeSnapshot(input: { teamName: string }): Promise<TeamAgentRuntimeSnapshot>;
}

/**
 * Live member/runtime projections over the authoritative snapshot. Reads are
 * fenced by the same expected context as every other lifecycle query; a team the
 * current registry never saw answers with an empty live projection, never with
 * invented members.
 */
export function createBoundTeamLiveStatusQueries(deps: {
  owner: Readonly<AppConnectionContext>;
  queries: Pick<LifecycleQueries, 'snapshot'>;
  now(): string;
}): TeamLiveStatusQueries {
  const owner = Object.freeze({ ...deps.owner });
  const read = (teamName: string) => deps.queries.snapshot({ expectedContext: owner, teamName });

  return {
    async memberSpawnStatuses({ teamName }) {
      const snapshot = await read(teamName);
      if (!snapshot) {
        return {
          statuses: {},
          runId: null,
          expectedMembers: [],
          updatedAt: deps.now(),
          source: 'live',
        };
      }
      return toMemberSpawnStatuses(snapshot, deps.now());
    },

    async runtimeSnapshot({ teamName }) {
      const snapshot = await read(teamName);
      if (!snapshot) {
        return { teamName, updatedAt: deps.now(), runId: null, members: {} };
      }
      return toTeamAgentRuntimeSnapshot(snapshot, deps.now());
    },
  };
}
