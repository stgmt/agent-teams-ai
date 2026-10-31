import { sliceClaudeLogs } from '@main/services/team/provisioning/TeamProvisioningLogSlice';

import type { TeamClaudeLogsQuery } from '@shared/types';

const MAX_LINES = 2_000;

interface RunLogs {
  teamName: string;
  lines: string[];
  updatedAt: string;
}

/**
 * In-memory bounded logs for native runs. Persistence across app restart is a
 * separate recovery concern; the store never grows past the per-run cap.
 */
export class NativeTeamLogStore {
  private readonly runs = new Map<string, RunLogs>();

  append(runId: string, teamName: string, line: string, now = new Date().toISOString()): void {
    const entry = this.runs.get(runId) ?? { teamName, lines: [], updatedAt: now };
    entry.lines.push(line);
    if (entry.lines.length > MAX_LINES) entry.lines.splice(0, entry.lines.length - MAX_LINES);
    entry.updatedAt = now;
    this.runs.set(runId, entry);
  }

  read(teamName: string, query?: TeamClaudeLogsQuery): ReturnType<typeof sliceClaudeLogs> {
    const entry = [...this.runs.values()]
      .filter((candidate) => candidate.teamName === teamName)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .at(-1);
    if (!entry) return { lines: [], total: 0, hasMore: false };
    return sliceClaudeLogs(entry.lines, entry.updatedAt, query);
  }

  clear(runId: string): void {
    this.runs.delete(runId);
  }

  /** Keeps only the given run for the team, so the last logs survive a stop. */
  retainLast(teamName: string, runId: string): void {
    for (const [key, entry] of this.runs) {
      if (key !== runId && entry.teamName === teamName) this.runs.delete(key);
    }
  }
}
