import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { isFileLockActive, withFileLockForSyncOperation } from '@main/services/team/fileLock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { withFileLockSync: withControllerLock } = createRequire(import.meta.url)(
  '../../../../agent-teams-controller/src/internal/fileLock.js'
) as {
  withFileLockSync: <T>(scope: string, fn: () => T, options?: object) => T;
};

describe('desktop board lock relocation', () => {
  let root: string;
  let teamDir: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-board-relocation-'));
    teamDir = path.join(root, 'fixture');
    fs.mkdirSync(teamDir);
  });
  afterEach(() => {
    const parent = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(parent, target);
    if (!relative.startsWith('desktop-board-relocation-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it('leaves a detached lock reclaimable by the legacy controller', async () => {
    const scope = path.join(teamDir, 'board-state');
    const lock = `${scope}.lock`;
    const detached = path.join(root, 'detached');
    await withFileLockForSyncOperation(
      scope,
      () => {
        expect(isFileLockActive(lock)).toBe(true);
        fs.linkSync(lock, detached);
        fs.unlinkSync(lock);
      },
      { retainOwnerHandle: true }
    );
    fs.linkSync(detached, lock);
    fs.unlinkSync(detached);
    expect(isFileLockActive(lock)).toBe(false);
    expect(
      withControllerLock(scope, () => 'ok', { acquireTimeoutMs: 200, retryIntervalMs: 5 })
    ).toBe('ok');
  });

  it('does not alter a copied lock with the same bytes but a different inode', async () => {
    const scope = path.join(teamDir, 'board-state');
    const lock = `${scope}.lock`;
    const detached = path.join(root, 'detached');
    let copy = '';
    await withFileLockForSyncOperation(
      scope,
      () => {
        fs.linkSync(lock, detached);
        fs.unlinkSync(lock);
        fs.copyFileSync(detached, lock);
        copy = fs.readFileSync(lock, 'utf8');
      },
      { retainOwnerHandle: true }
    );
    expect(fs.readFileSync(lock, 'utf8')).toBe(copy);
    expect(fs.readFileSync(detached, 'utf8')).not.toBe(copy);
    expect(isFileLockActive(lock)).toBe(true);
  });
});
