import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { sliceClaudeLogs } from '@main/services/team/provisioning/TeamProvisioningLogSlice';
import { validateTeamName } from '@main/services/team/TeamIdentifierValidation';

import type { TeamClaudeLogsQuery } from '@shared/types';

const MAX_LINES = 2_000;
const FLUSH_DELAY_MS = 250;

interface RunLogs {
  teamName: string;
  lines: string[];
  updatedAt: string;
}

interface PersistedRunLogs extends RunLogs {
  version: 1;
  runId: string;
}

/**
 * Bounded logs for native runs. When `teamsRoot` is provided the last run per
 * team is flushed to `<teamsRoot>/<team>/native-logs.json`, so `getClaudeLogs`
 * survives an app restart. Flushes are debounced; shutdown flushes synchronously.
 */
export class NativeTeamLogStore {
  private readonly runs = new Map<string, RunLogs>();
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: { teamsRoot?: string } = {}) {}

  append(runId: string, teamName: string, line: string, now = new Date().toISOString()): void {
    const entry = this.runs.get(runId) ?? { teamName, lines: [], updatedAt: now };
    entry.lines.push(line);
    if (entry.lines.length > MAX_LINES) entry.lines.splice(0, entry.lines.length - MAX_LINES);
    entry.updatedAt = now;
    this.runs.set(runId, entry);
    this.scheduleFlush(runId);
  }

  read(teamName: string, query?: TeamClaudeLogsQuery): ReturnType<typeof sliceClaudeLogs> {
    const entry = this.currentEntry(teamName) ?? this.loadPersisted(teamName);
    if (!entry) return { lines: [], total: 0, hasMore: false };
    return sliceClaudeLogs(entry.lines, entry.updatedAt, query);
  }

  clear(runId: string): void {
    const entry = this.runs.get(runId);
    this.cancelFlush(runId);
    this.runs.delete(runId);
    if (!entry || !this.options.teamsRoot) return;
    const path = this.logPath(entry.teamName);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { runId?: unknown };
      if (parsed.runId === runId) unlinkSync(path);
    } catch {
      // Missing or already removed files are fine.
    }
  }

  /** Keeps only the given run for the team, so the last logs survive a stop. */
  retainLast(teamName: string, runId: string): void {
    for (const [key, entry] of this.runs) {
      if (key !== runId && entry.teamName === teamName) {
        this.cancelFlush(key);
        this.runs.delete(key);
      }
    }
    this.scheduleFlush(runId, 0);
  }

  /** Flushes pending writes; call before process shutdown. */
  dispose(): void {
    for (const [runId, timer] of this.flushTimers) {
      clearTimeout(timer);
      this.flushSync(runId);
    }
    this.flushTimers.clear();
  }

  private currentEntry(teamName: string): RunLogs | undefined {
    return [...this.runs.values()]
      .filter((candidate) => candidate.teamName === teamName)
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
      .at(-1);
  }

  private loadPersisted(teamName: string): RunLogs | undefined {
    if (!this.options.teamsRoot || !validateTeamName(teamName).valid) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(this.logPath(teamName), 'utf8')) as unknown;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as PersistedRunLogs).version !== 1 ||
        !Array.isArray((parsed as PersistedRunLogs).lines) ||
        typeof (parsed as PersistedRunLogs).updatedAt !== 'string'
      )
        return undefined;
      const persisted = parsed as PersistedRunLogs;
      const lines = persisted.lines.filter((line): line is string => typeof line === 'string');
      const entry = { teamName, lines, updatedAt: persisted.updatedAt };
      this.runs.set(persisted.runId, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  private scheduleFlush(runId: string, delayMs = FLUSH_DELAY_MS): void {
    if (!this.options.teamsRoot) return;
    this.cancelFlush(runId);
    const timer = setTimeout(() => {
      this.flushTimers.delete(runId);
      void this.flush(runId);
    }, delayMs);
    timer.unref?.();
    this.flushTimers.set(runId, timer);
  }

  private cancelFlush(runId: string): void {
    const timer = this.flushTimers.get(runId);
    if (!timer) return;
    clearTimeout(timer);
    this.flushTimers.delete(runId);
  }

  private async flush(runId: string): Promise<void> {
    const entry = this.runs.get(runId);
    if (!entry || !this.options.teamsRoot) return;
    const path = this.logPath(entry.teamName);
    const temp = `${path}.tmp-${process.pid}`;
    try {
      await mkdir(join(this.options.teamsRoot, entry.teamName), { recursive: true });
      await writeFile(
        temp,
        JSON.stringify({
          version: 1,
          runId,
          teamName: entry.teamName,
          updatedAt: entry.updatedAt,
          lines: entry.lines,
        } satisfies PersistedRunLogs)
      );
      await rename(temp, path);
    } catch {
      // Log persistence is best-effort; the in-memory tail stays readable.
    }
  }

  private flushSync(runId: string): void {
    const entry = this.runs.get(runId);
    if (!entry || !this.options.teamsRoot) return;
    const path = this.logPath(entry.teamName);
    const temp = `${path}.tmp-${process.pid}`;
    try {
      mkdirSync(join(this.options.teamsRoot, entry.teamName), { recursive: true });
      writeFileSync(
        temp,
        JSON.stringify({
          version: 1,
          runId,
          teamName: entry.teamName,
          updatedAt: entry.updatedAt,
          lines: entry.lines,
        } satisfies PersistedRunLogs)
      );
      renameSync(temp, path);
    } catch {
      // Best-effort.
    }
  }

  private logPath(teamName: string): string {
    if (!this.options.teamsRoot) throw new Error('Native log store has no teams root');
    return join(this.options.teamsRoot, teamName, 'native-logs.json');
  }
}
