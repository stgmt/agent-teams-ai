import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';

/** Stable physical directory identity; do not substitute a path string on failure. */
export function getTaskWriteRootFingerprint(root: string): string | null {
  try {
    const stat = statSync(root, { bigint: true });
    if (!stat.isDirectory() || stat.dev === 0n || stat.ino === 0n) return null;
    return createHash('sha256')
      .update(`task-write-root-v1\0${stat.dev}\0${stat.ino}`)
      .digest('hex');
  } catch {
    return null;
  }
}

/** Call under the existing expected-context admission immediately before a task write. */
export function assertTaskWriteRootFingerprint(root: string, expected: unknown): void {
  const actual = getTaskWriteRootFingerprint(root);
  if (!actual || typeof expected !== 'string' || expected !== actual) {
    throw new Error('Task write data root is unavailable or changed');
  }
}
