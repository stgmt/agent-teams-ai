import { promises as fs, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

import { getTeamsBasePath } from '@main/utils/pathDecoder';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

export interface OpenCodeTranscriptBindingIdentity {
  memberName: string;
  laneId: string;
  runId: string;
  sessionId: string;
}

const exactIdentity = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 256 &&
  value.trim() === value &&
  !value.includes('\0');

/** Invalid optional history never invalidates the Stop authority itself. */
function parseTranscriptBindings(value: unknown): OpenCodeTranscriptBindingIdentity[] {
  if (!Array.isArray(value) || value.length > 128) return [];
  const bindings: OpenCodeTranscriptBindingIdentity[] = [];
  const members = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    const { memberName, laneId, runId, sessionId } = record;
    if (
      !exactIdentity(memberName) ||
      !exactIdentity(laneId) ||
      !exactIdentity(runId) ||
      !exactIdentity(sessionId)
    )
      return [];
    const key = JSON.stringify([memberName, laneId]);
    if (members.has(key)) return [];
    members.add(key);
    bindings.push({ memberName, laneId, runId, sessionId });
  }
  return bindings;
}

/** The current publication already persisted these runtime IDs before readiness. */
export function captureOpenCodeTranscriptBindings(
  snapshot: PersistedTeamLaunchSnapshot
): OpenCodeTranscriptBindingIdentity[] {
  const bindings = [];
  for (const [memberName, member] of Object.entries(snapshot.members)) {
    if (member.providerId !== 'opencode') continue;
    const binding = {
      memberName,
      laneId: member.laneId,
      runId: member.runtimeRunId,
      sessionId: member.runtimeSessionId,
    };
    if (member.name !== memberName || !Object.values(binding).every(exactIdentity)) continue;
    const candidate = member.appManagedBootstrapCandidate;
    if (member.bootstrapEvidenceSource === 'app_managed_bootstrap' && !candidate) continue;
    if (
      candidate &&
      (candidate.teamName !== snapshot.teamName ||
        candidate.memberName !== memberName ||
        candidate.laneId !== binding.laneId ||
        candidate.runId !== binding.runId ||
        candidate.runtimeSessionId !== binding.sessionId)
    )
      continue;
    bindings.push(binding);
  }
  return parseTranscriptBindings(bindings);
}

/** Live authority, deliberately not restored from backups. Missing retains legacy restore. */
export const TEAM_LAUNCH_FRESHNESS_FILE = 'launch-freshness.json';
export type TeamLaunchFreshness =
  | { version: 1; teamName: string; kind: 'launch'; runId: string; native?: true }
  | {
      version: 1;
      teamName: string;
      kind: 'stop';
      stopId: string;
      native?: true;
      stoppedRunId?: string;
      transcriptBindings?: OpenCodeTranscriptBindingIdentity[];
    };

export function getTeamLaunchFreshnessPath(
  teamName: string,
  teamsRoot = getTeamsBasePath()
): string {
  return path.join(teamsRoot, teamName, TEAM_LAUNCH_FRESHNESS_FILE);
}

export function parseTeamLaunchFreshness(
  teamName: string,
  value: unknown
): TeamLaunchFreshness | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const record = value as {
    version?: unknown;
    teamName?: unknown;
    kind?: unknown;
    runId?: unknown;
    native?: unknown;
    stopId?: unknown;
    stoppedRunId?: unknown;
    transcriptBindings?: unknown;
  };
  if (record.version !== 1 || record.teamName !== teamName) {
    return null;
  }
  if (record.kind === 'launch' && typeof record.runId === 'string' && record.runId) {
    return {
      version: 1,
      teamName,
      kind: 'launch',
      runId: record.runId,
      ...(record.native === true ? { native: true as const } : {}),
    };
  }
  if (record.kind === 'stop' && typeof record.stopId === 'string' && record.stopId) {
    return {
      version: 1,
      teamName,
      kind: 'stop',
      stopId: record.stopId,
      ...(record.native === true ? { native: true as const } : {}),
      ...(typeof record.stoppedRunId === 'string' && record.stoppedRunId
        ? { stoppedRunId: record.stoppedRunId }
        : {}),
      ...(record.transcriptBindings !== undefined
        ? {
            transcriptBindings: exactIdentity(record.stoppedRunId)
              ? parseTranscriptBindings(record.transcriptBindings)
              : [],
          }
        : {}),
    };
  }
  return null;
}

export function isStopLaunchFreshness(
  value: TeamLaunchFreshness | TeamLaunchFreshness['kind'] | null | undefined
): boolean {
  if (value == null) return false;
  if (typeof value === 'string') return value === 'stop';
  return value.kind === 'stop';
}

export async function readTeamLaunchFreshness(
  teamName: string,
  teamsRoot?: string
): Promise<TeamLaunchFreshness | null> {
  let raw: string;
  try {
    const file = getTeamLaunchFreshnessPath(teamName, teamsRoot);
    if ((await fs.stat(file)).size > 256 * 1024)
      throw new Error('Launch freshness exceeds size limit');
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = parseTeamLaunchFreshness(teamName, JSON.parse(raw));
  if (!parsed) {
    throw new Error('Invalid launch freshness authority');
  }
  return parsed;
}

/** Read the authority alongside snapshots; an unreadable fence cannot validate old status. */
export async function readLaunchStatusAuthority(
  teamDir: string
): Promise<TeamLaunchFreshness | null | 'unreadable'> {
  try {
    return await readTeamLaunchFreshness(path.basename(teamDir), path.dirname(teamDir));
  } catch {
    return 'unreadable';
  }
}

/** Capture the publication visible at Stop invocation, before waiting for locks. */
export function readTeamLaunchFreshnessSync(
  teamName: string,
  teamsRoot?: string
): TeamLaunchFreshness | null {
  let raw: string;
  try {
    const file = getTeamLaunchFreshnessPath(teamName, teamsRoot);
    if (statSync(file).size > 256 * 1024) throw new Error('Launch freshness exceeds size limit');
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const parsed = parseTeamLaunchFreshness(teamName, JSON.parse(raw));
  if (!parsed) throw new Error('Invalid launch freshness authority');
  return parsed;
}

export async function readTeamLaunchFreshnessFromTeamDir(
  teamDir: string,
  teamName: string
): Promise<TeamLaunchFreshness | null> {
  try {
    const raw = await fs.readFile(path.join(teamDir, TEAM_LAUNCH_FRESHNESS_FILE), 'utf8');
    return parseTeamLaunchFreshness(teamName, JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function canRestoreTeamStopMarker(
  teamName: string,
  content: Buffer
): Promise<boolean> {
  const freshness = await readTeamLaunchFreshness(teamName);
  if (!freshness) return true;
  if (freshness.kind === 'launch') return false;
  const marker = JSON.parse(content.toString('utf8'));
  return marker.teamName === teamName && marker.stopId === freshness.stopId;
}
