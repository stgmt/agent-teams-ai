import * as path from 'node:path';

import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { boardLocks } from 'agent-teams-controller';

/**
 * Wait without holding either lock, then run the operation without yielding.
 *
 * A live team has the lead, its members and the app reading the board at the
 * same time; five seconds ran out under that load and a task write failed as a
 * timeout while the retry succeeded. Twenty seconds covers the contention
 * without making a genuinely stuck lock wait forever.
 */
export async function withTeamBoardLockForSyncOperation<T>(
  paths: { teamDir: string; claudeDir?: string },
  operation: () => T,
  options: { createParent?: boolean; acquireTimeoutMs?: number; retryIntervalMs?: number } = {}
): Promise<T> {
  const deadline = Date.now() + (options.acquireTimeoutMs ?? 20_000);
  const retryIntervalMs = options.retryIntervalMs ?? 20;
  for (;;) {
    const acquired = boardLocks.tryWithTeamBoardLock(
      paths,
      () => ({ value: operation() }),
      options
    );
    if (acquired !== null) return acquired.value;
    if (Date.now() >= deadline) throw new Error(`File lock timeout: ${paths.teamDir}`);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(retryIntervalMs, Math.max(0, deadline - Date.now())))
    );
  }
}

/** Background work must not block an older in-process holder of the inner lock. */
export function tryTeamBoardOperation<T>(teamName: string, operation: () => T, busy: T): T {
  const teamsBase = getTeamsBasePath();
  const result = boardLocks.tryWithTeamBoardLock(
    { teamDir: path.join(teamsBase, teamName), claudeDir: path.dirname(teamsBase) },
    () => ({ value: operation() })
  );
  return result === null ? busy : result.value;
}
