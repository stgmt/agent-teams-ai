import type { TeamRunIdentity } from '../../../contracts';

/** Identity of one member inside one run; the map key for everything per-member. */
export function memberKey(team: TeamRunIdentity, memberName: string): string {
  return JSON.stringify([
    team.appInstanceId,
    team.dataRootFingerprint,
    team.connectionGeneration,
    team.teamName,
    team.runId,
    memberName,
  ]);
}

/** Identity of one adapter lane inside one run. */
export function laneGroupKey(team: TeamRunIdentity, laneId: string): string {
  return `${memberKey(team, '')}|${laneId}`;
}
