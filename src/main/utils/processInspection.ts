import { execFile } from 'node:child_process';

import { processProbeDiagnostic } from '@main/utils/processProbeDiagnostics';

/**
 * Outcome of looking one process up by pid.
 *
 * `unreadable` is not `not_found` and not a foreign process: the lookup itself failed (timeout,
 * missing tool), so nothing is known about the process. Callers must not treat it as a mismatch.
 */
export type ProcessInspection =
  /** `startedAt` is the process creation time (epoch ms) when the platform exposes it. */
  | { status: 'found'; command: string; startedAt?: number }
  | { status: 'not_found' }
  | { status: 'unreadable'; cause: string };

export interface InspectProcessOptions {
  timeoutMs?: number;
  platform?: NodeJS.Platform;
  /** Called after every unreadable attempt, including the last one. */
  onUnreadable?: (attempt: number, cause: string) => void;
}

/** Windows PowerShell start-up alone is 0.6-2 s and reached 4 s under load (measured 22.10.2026). */
export const PROCESS_INSPECTION_TIMEOUT_MS = 15_000;
/** One retry after an unreadable lookup; a second failure is reported with its cause. */
export const PROCESS_INSPECTION_ATTEMPTS = 2;

const MAX_BUFFER_BYTES = 1024 * 1024;

function normalizePid(pid: number): number | null {
  const normalized = Math.trunc(pid);
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function windowsScript(pid: number): string {
  return [
    '$ErrorActionPreference = "Stop"',
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`,
  ].join('; ');
}

/** WMI reports `CreationDate` as a CIM datetime; Date.parse does not read it. */
function parseCimDate(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/u);
  if (!match) return undefined;
  const [, y, mo, d, h, mi, sec] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec));
  return Number.isFinite(ms) ? ms : undefined;
}

interface ExecResult {
  error: (Error & { code?: unknown }) | null;
  stdout: string;
  stderr: string;
}

function run(
  file: string,
  args: string[],
  timeoutMs: number,
  windowsHide: boolean
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', timeout: timeoutMs, windowsHide, maxBuffer: MAX_BUFFER_BYTES },
      (error, stdout, stderr) => {
        resolve({
          error: error ?? null,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      }
    );
  });
}

function unreadable(
  operation: string,
  startedAt: number,
  timeoutMs: number,
  result: ExecResult
): ProcessInspection {
  return {
    status: 'unreadable',
    cause: processProbeDiagnostic(
      operation,
      startedAt,
      timeoutMs,
      result.error ? 'probe failed' : 'stderr received',
      result.error,
      result.stderr
    ),
  };
}

async function inspectWindows(pid: number, timeoutMs: number): Promise<ProcessInspection> {
  const startedAt = performance.now();
  const result = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', windowsScript(pid)],
    timeoutMs,
    true
  );
  if (result.error || result.stderr.trim()) {
    return unreadable('windows_process_inspection', startedAt, timeoutMs, result);
  }
  const trimmed = result.stdout.trim();
  if (!trimmed) {
    return { status: 'not_found' };
  }
  try {
    const row = JSON.parse(trimmed) as { CommandLine?: string | null; CreationDate?: unknown };
    const startedAt = parseCimDate(row.CreationDate);
    return {
      status: 'found',
      command: row.CommandLine?.trim() ?? '',
      ...(startedAt === undefined ? {} : { startedAt }),
    };
  } catch {
    return unreadable('windows_process_inspection', startedAt, timeoutMs, {
      ...result,
      stderr: 'unparseable output',
    });
  }
}

async function inspectPosix(pid: number, timeoutMs: number): Promise<ProcessInspection> {
  const startedAt = performance.now();
  const result = await run('/bin/ps', ['-p', String(pid), '-o', 'command='], timeoutMs, false);
  if (!result.error) {
    const command = result.stdout.trim();
    return command ? { status: 'found', command } : { status: 'not_found' };
  }
  // ps exits with 1 and prints nothing when no process matches the pid.
  if (result.error.code === 1 && !result.stdout.trim() && !result.stderr.trim()) {
    return { status: 'not_found' };
  }
  return unreadable('posix_process_inspection', startedAt, timeoutMs, result);
}

/** One asynchronous lookup of a process command line; never blocks the event loop. */
export async function inspectProcessByPidOnce(
  pid: number,
  options: InspectProcessOptions = {}
): Promise<ProcessInspection> {
  const normalizedPid = normalizePid(pid);
  if (normalizedPid === null) {
    return { status: 'not_found' };
  }
  const timeoutMs = options.timeoutMs ?? PROCESS_INSPECTION_TIMEOUT_MS;
  return (options.platform ?? process.platform) === 'win32'
    ? inspectWindows(normalizedPid, timeoutMs)
    : inspectPosix(normalizedPid, timeoutMs);
}

/** Repeats an unreadable lookup; `found` and `not_found` are final on the first attempt. */
export async function inspectWithRetry(
  inspectOnce: () => Promise<ProcessInspection>,
  attempts: number = PROCESS_INSPECTION_ATTEMPTS,
  onUnreadable?: (attempt: number, cause: string) => void
): Promise<ProcessInspection> {
  let last: ProcessInspection = { status: 'unreadable', cause: 'no attempt was made' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    last = await inspectOnce();
    if (last.status !== 'unreadable') {
      return last;
    }
    onUnreadable?.(attempt, last.cause);
  }
  return last;
}


function windowsBatchScript(pids: readonly number[]): string {
  const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
  return [
    '$ErrorActionPreference = "Stop"',
    `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress`,
  ].join('; ');
}

function readBatchRows(stdout: string): { pid: number; command: string; startedAt?: number }[] | null {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row): row is { ProcessId?: unknown; CommandLine?: unknown; CreationDate?: unknown } =>
        row !== null && typeof row === 'object'
      )
      .map((row) => ({
        pid: typeof row.ProcessId === 'number' ? row.ProcessId : Number(row.ProcessId),
        command: typeof row.CommandLine === 'string' ? row.CommandLine.trim() : '',
        startedAt: parseCimDate(row.CreationDate),
      }))
      .filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0);
  } catch {
    return null;
  }
}

/**
 * One lookup for a whole roster: a launch inspects every recorded member pid, and
 * ten separate PowerShell starts were the slow part of `prepare()` on Windows.
 * Unknown pids are simply absent from the map; callers treat absence as unknown.
 */
export async function inspectProcessesByPid(
  pids: readonly number[],
  options: InspectProcessOptions = {}
): Promise<Map<number, ProcessInspection>> {
  const wanted = [...new Set(pids.map(normalizePid).filter((pid): pid is number => pid !== null))];
  const result = new Map<number, ProcessInspection>();
  if (wanted.length === 0) return result;
  const timeoutMs = options.timeoutMs ?? PROCESS_INSPECTION_TIMEOUT_MS;
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') {
    const startedAt = performance.now();
    const probe = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        windowsBatchScript(wanted),
      ],
      timeoutMs,
      true
    );
    const rows = probe.error || probe.stderr.trim() ? null : readBatchRows(probe.stdout);
    if (rows) {
      for (const row of rows) {
        if (wanted.includes(row.pid)) {
          result.set(row.pid, {
            status: 'found',
            command: row.command,
            ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
          });
        }
      }
      for (const pid of wanted) {
        if (!result.has(pid)) result.set(pid, { status: 'not_found' });
      }
      return result;
    }
    const cause = unreadable('windows_process_batch_inspection', startedAt, timeoutMs, probe);
    for (const pid of wanted) result.set(pid, cause);
    return result;
  }
  for (const pid of wanted) {
    result.set(pid, await inspectProcessByPidOnce(pid, options));
  }
  return result;
}

export function inspectProcessByPid(
  pid: number,
  options: InspectProcessOptions = {}
): Promise<ProcessInspection> {
  return inspectWithRetry(
    () => inspectProcessByPidOnce(pid, options),
    PROCESS_INSPECTION_ATTEMPTS,
    options.onUnreadable
  );
}
