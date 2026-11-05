import type { NativeTeamLogStore } from './NativeTeamLogStore';
import type { TeamClaudeLogsQuery, TeamClaudeLogsResponse } from '@shared/types';

/** `getClaudeLogs` over the native bounded log store. */
export class NativeTeamClaudeLogs {
  constructor(private readonly logs: Pick<NativeTeamLogStore, 'read'>) {}

  async getClaudeLogs(
    teamName: string,
    query?: TeamClaudeLogsQuery
  ): Promise<TeamClaudeLogsResponse> {
    return this.logs.read(teamName, query);
  }
}
