import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { withFileLock } from './fileLock';

/** Resolve aliases even when the teams directory has not been created yet. */
export function resolveLaunchPublicationRoot(teamsRoot = getTeamsBasePath()): string {
  const absolute = path.resolve(teamsRoot);
  let existing = absolute;
  while (true) {
    try {
      return path.resolve(fs.realpathSync.native(existing), path.relative(existing, absolute));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

/** Serialize launch-state publication across current-version app processes. */
export function withLaunchPublicationFileLock<T>(
  teamName: string,
  operation: () => Promise<T>,
  teamsRoot = getTeamsBasePath()
): Promise<T> {
  const root = path.dirname(teamsRoot);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = path.dirname(resolveLaunchPublicationRoot(teamsRoot));
  const key = createHash('sha256').update(teamName.normalize('NFC').toLowerCase()).digest('hex');
  const scope = path.join(realRoot, '.agent-teams-launch-publications', key);
  return withFileLock(scope, operation, {
    preventLiveOwnerTakeover: true,
    retainOwnerHandle: true,
  });
}
