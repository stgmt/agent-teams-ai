import { execFile } from 'node:child_process';

import { processProbeDiagnostic } from '@main/utils/processProbeDiagnostics';

/**
 * Outcome of looking one process up by pid.
 *
 * `unreadable` is not `not_found` and not a foreign process: the lookup itself failed (timeout,
 * missing tool), so nothing is known about the process. Callers must not treat it as a mismatch.
 */
export type ProcessInspection =
  | { status: 'found'; command: string }
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
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress`,
  ].join('; ');
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
    const row = JSON.parse(trimmed) as { CommandLine?: string | null };
    return { status: 'found', command: row.CommandLine?.trim() ?? '' };
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
