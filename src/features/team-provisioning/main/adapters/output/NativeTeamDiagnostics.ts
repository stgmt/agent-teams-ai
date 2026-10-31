import type { TeamRunRegistryRead } from '../../../contracts';
import type { TeamLiveStatusQueries } from '../../composition/createBoundTeamLiveStatusQueries';
import type { NativeTeamLogStore } from './NativeTeamLogStore';
import type {
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

interface Dependencies {
  statuses: Pick<TeamLiveStatusQueries, 'runtimeSnapshot'>;
  runs: Pick<TeamRunRegistryRead, 'find' | 'isLive'>;
  logs: Pick<NativeTeamLogStore, 'read'>;
}

/** Top-level stream-json events that mean a lead turn is still running. */
const ACTIVE_EVENT_TYPES = new Set(['assistant', 'user', 'tool_use', 'tool_result']);
const IDLE_EVENT_TYPES = new Set(['result', 'system']);

/**
 * Diagnostics that have a native source. Lead activity is derived from the last
 * stream-json event in the bounded log tail; context usage still needs a
 * provider-specific usage parser and fails closed.
 */
export class NativeTeamDiagnostics {
  constructor(private readonly deps: Dependencies) {}

  getLeadActivityState(teamName: string): LeadActivitySnapshot {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot || !this.deps.runs.isLive(snapshot.identity))
      return { state: 'offline', runId: null };
    const lead = Object.values(snapshot.members).find(
      (member) => member.role === 'lead' && member.membership === 'configured'
    );
    if (!lead || (!lead.process && !lead.lane) || lead.phase !== 'ready')
      return { state: 'offline', runId: null };
    return {
      state: activityFromLogTail(this.deps.logs.read(teamName, { limit: 50 }).lines),
      runId: snapshot.identity.runId,
    };
  }

  getLeadContextUsage(_teamName: string): LeadContextUsageSnapshot {
    throw new Error('Lead context usage diagnostics are not migrated');
  }

  getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    return this.deps.statuses.runtimeSnapshot({ teamName });
  }
}

function activityFromLogTail(lines: readonly string[]): 'active' | 'idle' {
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const type = (event as { type?: unknown }).type;
    if (typeof type !== 'string') continue;
    if (ACTIVE_EVENT_TYPES.has(type)) return 'active';
    if (IDLE_EVENT_TYPES.has(type)) return 'idle';
  }
  return 'idle';
}
