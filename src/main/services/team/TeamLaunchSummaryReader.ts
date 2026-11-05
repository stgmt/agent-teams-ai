import { readFileUtf8WithTimeout } from '@main/utils/fsRead';
import * as fs from 'fs';
import * as path from 'path';

import { readBootstrapLaunchSnapshot } from './TeamBootstrapStateReader';
import { readLaunchStatusAuthority } from './TeamLaunchFreshness';
import { normalizePersistedLaunchSnapshot } from './TeamLaunchStateEvaluator';
import {
  choosePreferredLaunchStateSummary,
  normalizePersistedLaunchSummaryProjection,
  TEAM_LAUNCH_SUMMARY_FILE,
} from './TeamLaunchSummaryProjection';

import type { LaunchStateSummary } from './TeamLaunchSummaryProjection';

async function readSummary(
  teamDir: string,
  worker: boolean
): Promise<{ summary: LaunchStateSummary | null; cacheable: boolean }> {
  const teamName = path.basename(teamDir);
  const before = await readLaunchStatusAuthority(teamDir);
  if (before === 'unreadable') return { summary: {}, cacheable: false };
  if (before?.native && before.kind === 'stop') return { summary: {}, cacheable: true };
  const nativeRunId = before?.native && before.kind === 'launch' ? before.runId : null;
  // Historical bootstrap is never evidence about the native owner's run.
  const bootstrapSnapshot = nativeRunId ? null : await readBootstrapLaunchSnapshot(teamName);
  const read = async (file: string): Promise<unknown> => {
    try {
      const stat = await fs.promises.stat(file);
      if (!stat.isFile() || stat.size > 32 * 1024) return null;
      const raw = worker
        ? await fs.promises.readFile(file, 'utf8')
        : await readFileUtf8WithTimeout(file, 5_000);
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  const [state, projection] = await Promise.all([
    read(path.join(teamDir, 'launch-state.json')),
    read(path.join(teamDir, TEAM_LAUNCH_SUMMARY_FILE)),
  ]);
  const after = await readLaunchStatusAuthority(teamDir);
  if (after === 'unreadable' || JSON.stringify(after) !== JSON.stringify(before))
    return { summary: {}, cacheable: false };
  const isCurrent = (value: unknown): boolean =>
    !nativeRunId ||
    Boolean(
      value &&
      typeof value === 'object' &&
      (value as { publicationRunId?: unknown }).publicationRunId === nativeRunId
    );
  const launchSnapshot = normalizePersistedLaunchSnapshot(
    teamName,
    isCurrent(state) ? state : null
  );
  const summary = choosePreferredLaunchStateSummary({
    bootstrapSnapshot,
    launchSnapshot,
    launchSummaryProjection: normalizePersistedLaunchSummaryProjection(
      teamName,
      isCurrent(projection) ? projection : null
    ),
  });
  const cacheable = Boolean(
    launchSnapshot ||
    !bootstrapSnapshot ||
    (bootstrapSnapshot.launchPhase === 'finished' &&
      bootstrapSnapshot.teamLaunchState !== 'partial_pending')
  );
  // An empty object suppresses the legacy artifact heuristic for native runs.
  return { summary: nativeRunId ? (summary ?? {}) : summary, cacheable };
}

export async function readLaunchStateSummary(teamDir: string): Promise<LaunchStateSummary | null> {
  return (await readSummary(teamDir, false)).summary;
}

export async function readLaunchStateForWorker(
  teamsDir: string,
  teamName: string
): Promise<{ summary: LaunchStateSummary | null; cacheable: boolean }> {
  return readSummary(path.join(teamsDir, teamName), true);
}
