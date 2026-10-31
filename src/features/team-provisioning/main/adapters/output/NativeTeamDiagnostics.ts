import type { TeamLiveStatusQueries } from '../../composition/createBoundTeamLiveStatusQueries';
import type {
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

/**
 * Diagnostics that already have a native source. Lead activity and context
 * usage still depend on legacy run payloads and fail closed until migrated.
 */
export class NativeTeamDiagnostics {
  constructor(private readonly statuses: Pick<TeamLiveStatusQueries, 'runtimeSnapshot'>) {}

  getLeadActivityState(_teamName: string): LeadActivitySnapshot {
    throw new Error('Lead activity diagnostics are not migrated');
  }

  getLeadContextUsage(_teamName: string): LeadContextUsageSnapshot {
    throw new Error('Lead context usage diagnostics are not migrated');
  }

  getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    return this.statuses.runtimeSnapshot({ teamName });
  }
}
