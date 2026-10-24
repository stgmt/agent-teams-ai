import { inspectProcessByPid, type ProcessInspection } from '@main/utils/processInspection';
import { killProcessByPidAndWait } from '@main/utils/processKill';
import { createLogger } from '@shared/utils/logger';

const logger = createLogger('Service:TeamProvisioning');

/**
 * Longest wait for a stopped teammate process (and its tree) to disappear.
 * `taskkill /T /F` of a live agent tree took 1.3-6 s on the owner's machine under load
 * (measured 22.10.2026); 20 s is more than three times the worst case.
 */
export const MEMBER_PROCESS_STOP_TIMEOUT_MS = 20_000;

/** Look a teammate process up without blocking the main thread; one retry when unreadable. */
export function inspectMemberProcess(pid: number): Promise<ProcessInspection> {
  return inspectProcessByPid(pid, {
    onUnreadable: (attempt, cause) =>
      logger.diagnostic(
        `Lookup of teammate process pid=${pid} was unreadable (attempt ${attempt}): ${cause}`
      ),
  });
}

/** Terminate a teammate process tree and resolve only after the pid is gone. */
export function terminateMemberProcess(pid: number): Promise<void> {
  return killProcessByPidAndWait(pid, { timeoutMs: MEMBER_PROCESS_STOP_TIMEOUT_MS });
}

export type { ProcessInspection };
