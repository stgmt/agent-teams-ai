import * as fs from 'fs';

import type { TeamConfigFingerprint } from './TeamConfigReader';
import type { TeamConfig, TeamSummary } from '@shared/types';

export const PER_TEAM_READ_TIMEOUT_MS = 5_000;

export interface InternalTeamConfigFingerprint extends TeamConfigFingerprint {
  isFile: boolean;
  highResolution: boolean;
  numericSize: number;
}

export type TeamConfigReadMode = 'verified' | 'snapshot';

export interface ConfigReadTiming {
  teamName: string;
  mode: TeamConfigReadMode;
  configPath: string;
  size: number | null;
  statMs: number | null;
  readMs: number | null;
  parseMs: number | null;
  totalMs: number;
  likelyCause: string;
  fingerprintHighResolution: boolean | null;
  cacheGeneration: number | null;
  currentGeneration: number;
  caller: string | null;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = new Array(workerCount).fill(0).map(async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function withReadTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('Team config read timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function cloneConfig(config: TeamConfig): TeamConfig {
  return structuredClone(config);
}

export function cloneTeamSummaries(teams: readonly TeamSummary[]): TeamSummary[] {
  return structuredClone([...teams]);
}

// Deep-freeze a team-summary snapshot so it can be shared by every listTeams() reader
// (and concurrent in-flight awaiters) instead of deep-cloning all summaries on every
// call -- that per-read structuredClone was the single largest memory allocator during
// launch. Consumers treat the result as read-only (audited: all iterate / map / filter
// / serialize, none mutate), and freezing turns any stray future mutation into a loud
// error instead of silent cross-caller corruption.
export function freezeTeamSummariesDeep(teams: TeamSummary[]): TeamSummary[] {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
      return;
    }
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      freeze(nested);
    }
  };
  freeze(teams);
  return teams;
}

export function classifyConfigReadTiming(timing: {
  statMs: number | null;
  readMs: number | null;
  parseMs: number | null;
}): string {
  const statMs = timing.statMs ?? 0;
  const readMs = timing.readMs ?? 0;
  const parseMs = timing.parseMs ?? 0;
  if (readMs >= 1_000 && readMs >= statMs * 2 && readMs >= parseMs * 2) {
    return 'io_read_slow';
  }
  if (statMs >= 1_000 && statMs >= readMs * 2 && statMs >= parseMs * 2) {
    return 'io_stat_slow';
  }
  if (parseMs >= 500 && parseMs >= readMs && parseMs >= statMs) {
    return 'json_parse_slow';
  }
  if (statMs + readMs >= 1_000) {
    return 'filesystem_pressure';
  }
  return 'mixed_or_unknown';
}

export function captureConfigReadCaller(): string | null {
  const stack = new Error().stack?.split('\n').slice(2) ?? [];
  const frame = stack.find((line) => {
    const normalized = line.trim();
    return (
      normalized.length > 0 &&
      !normalized.includes('TeamConfigReader.') &&
      !normalized.includes('TeamConfigReader.ts') &&
      !normalized.includes('captureConfigReadCaller') &&
      !normalized.includes('node:internal')
    );
  });
  return frame?.trim().slice(0, 240) ?? null;
}

export async function readConfigFingerprint(
  configPath: string
): Promise<InternalTeamConfigFingerprint | null> {
  let stat: fs.BigIntStats;
  try {
    stat = await withReadTimeout(
      fs.promises.stat(configPath, { bigint: true }),
      PER_TEAM_READ_TIMEOUT_MS
    );
  } catch (error) {
    const code = typeof error === 'object' && error ? (error as { code?: unknown }).code : null;
    if (code === 'ENOENT') {
      return null;
    }
    throw error;
  }

  const highResStat = stat as fs.BigIntStats & {
    mtimeNs?: bigint;
    ctimeNs?: bigint;
    birthtimeNs?: bigint;
  };
  const mtimeNs = highResStat.mtimeNs;
  const ctimeNs = highResStat.ctimeNs;
  const birthtimeNs = highResStat.birthtimeNs;

  return {
    size: stat.size.toString(),
    mode: stat.mode.toString(),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    mtimeNs: typeof mtimeNs === 'bigint' ? mtimeNs.toString() : undefined,
    ctimeNs: typeof ctimeNs === 'bigint' ? ctimeNs.toString() : undefined,
    birthtimeNs: typeof birthtimeNs === 'bigint' ? birthtimeNs.toString() : undefined,
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
    birthtimeMs: Number(stat.birthtimeMs),
    isFile: stat.isFile(),
    highResolution: typeof mtimeNs === 'bigint' || typeof ctimeNs === 'bigint',
    numericSize: Number(stat.size),
  };
}

export function fingerprintsEqual(
  a: InternalTeamConfigFingerprint,
  b: InternalTeamConfigFingerprint
): boolean {
  return (
    a.size === b.size &&
    a.mode === b.mode &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs &&
    a.birthtimeNs === b.birthtimeNs &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.birthtimeMs === b.birthtimeMs
  );
}
