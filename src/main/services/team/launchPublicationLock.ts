import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { withFileLock } from './fileLock';

/** Serialize launch-state publication across current-version app processes. */
export function withLaunchPublicationFileLock<T>(
  teamName: string,
  operation: () => Promise<T>
): Promise<T> {
  const root = path.dirname(getTeamsBasePath());
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync.native(root);
  const key = createHash('sha256').update(teamName.normalize('NFC').toLowerCase()).digest('hex');
  const scope = path.join(realRoot, '.agent-teams-launch-publications', key);
  return withFileLock(scope, operation, {
    preventLiveOwnerTakeover: true,
    retainOwnerHandle: true,
  });
}
