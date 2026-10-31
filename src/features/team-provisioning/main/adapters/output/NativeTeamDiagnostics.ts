import { deriveContextMetrics } from '@shared/utils/contextMetrics';

import type { TeamRunRegistryRead } from '../../../contracts';
import type { TeamLiveStatusQueries } from '../../composition/createBoundTeamLiveStatusQueries';
import type { NativeTeamLogStore } from './NativeTeamLogStore';
import type {
  LeadActivitySnapshot,
  LeadContextUsage,
  LeadContextUsageSnapshot,
  TeamAgentRuntimeSnapshot,
} from '@shared/types';

interface Dependencies {
  statuses: Pick<TeamLiveStatusQueries, 'runtimeSnapshot'>;
  runs: Pick<TeamRunRegistryRead, 'find' | 'isLive'>;
  logs: Pick<NativeTeamLogStore, 'read'>;
}

/** Top-level stream-json events that mean a lead turn is still running. */
const ACTIVE_EVENT_TYPES = new Set([
  'assistant',
  'user',
  'tool_use',
  'tool_result',
  'turn.started',
  'item.started',
  'item.updated',
  'item.completed',
]);
const IDLE_EVENT_TYPES = new Set([
  'result',
  'system',
  'turn.completed',
  'turn.failed',
  'thread.started',
  'thread.completed',
  'error',
]);

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
      state: activityFromLogTail(this.deps.logs.read(teamName, { limit: 200 }).lines),
      runId: snapshot.identity.runId,
    };
  }

  getLeadContextUsage(teamName: string): LeadContextUsageSnapshot {
    const snapshot = this.deps.runs.find(teamName);
    if (!snapshot || !this.deps.runs.isLive(snapshot.identity)) return { usage: null, runId: null };
    const lead = Object.values(snapshot.members).find(
      (member) => member.role === 'lead' && member.membership === 'configured'
    );
    if (!lead || (!lead.process && !lead.lane) || lead.phase !== 'ready')
      return { usage: null, runId: null };
    const tail = this.deps.logs.read(teamName, { limit: 200 });
    const observed = usageFromLogTail(tail.lines);
    if (!observed) return { usage: null, runId: snapshot.identity.runId };
    const metrics = deriveContextMetrics({
      usage: observed.usage,
      modelName: observed.modelName,
    });
    const usage: LeadContextUsage = {
      promptInputTokens: metrics.promptInputTokens,
      outputTokens: metrics.outputTokens,
      contextUsedTokens: metrics.contextUsedTokens,
      contextWindowTokens: metrics.contextWindowTokens,
      contextUsedPercent: metrics.contextUsedPercentOfContextWindow,
      promptInputSource: metrics.promptInputSource,
      updatedAt: tail.updatedAt ?? new Date().toISOString(),
    };
    return { usage, runId: snapshot.identity.runId };
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

interface UsageObservation {
  usage: Record<string, unknown>;
  modelName: string | undefined;
}

function usageFromLogTail(lines: readonly string[]): UsageObservation | null {
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) continue;
    const record = event as Record<string, unknown>;
    const message =
      record.message && typeof record.message === 'object' && !Array.isArray(record.message)
        ? (record.message as Record<string, unknown>)
        : null;
    const usage =
      record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
        ? (record.usage as Record<string, unknown>)
        : message?.usage && typeof message.usage === 'object' && !Array.isArray(message.usage)
          ? (message.usage as Record<string, unknown>)
          : null;
    if (!usage) continue;
    if (
      !['input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens'].some(
        (key) => typeof usage[key] === 'number'
      )
    )
      continue;
    const modelName =
      typeof message?.model === 'string'
        ? message.model
        : typeof record.model === 'string'
          ? record.model
          : undefined;
    return { usage, modelName };
  }
  return null;
}
