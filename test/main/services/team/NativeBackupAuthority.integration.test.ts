// @vitest-environment node
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { TeamBackupRestoreService } from '@main/services/team/TeamBackupRestoreService';
import { createPersistedLaunchSnapshot } from '@main/services/team/TeamLaunchStateEvaluator';
import { TeamLaunchStateStore } from '@main/services/team/TeamLaunchStateStore';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const nativeFs = createRequire(import.meta.url)('node:fs') as typeof import('node:fs');
let root: string;
let teamDir: string;
let backupDir: string;
let store: TeamLaunchStateStore;
const teamName = 'sandbox';

beforeEach(async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'native-backup-authority-'));
  const parent = await fs.realpath(os.tmpdir());
  root = await fs.realpath(scratch);
  const relative = path.relative(parent, root);
  if (!relative.startsWith('native-backup-authority-') || relative.includes(path.sep))
    throw new Error('Invalid fixture root');
  setClaudeBasePathOverride(root);
  const teamsRoot = path.join(root, 'teams');
  teamDir = path.join(teamsRoot, teamName);
  backupDir = path.join(root, 'backups', teamName);
  await fs.mkdir(teamDir, { recursive: true });
  await fs.mkdir(backupDir, { recursive: true });
  await fs.writeFile(
    path.join(teamDir, 'config.json'),
    JSON.stringify({ name: teamName, members: [], _backupIdentityId: 'fixture-id' })
  );
  store = new TeamLaunchStateStore(teamsRoot);
  expect(await store.beginLaunch(teamName, 'old-run', ['lead'], () => true)).toBe(true);
  expect(await store.markStopped(teamName)).toBe(true);
  expect(await store.beginNativeLaunch(teamName, 'native-run', () => true)).toBe(true);
  const snapshot = createPersistedLaunchSnapshot({
    teamName,
    expectedMembers: ['lead'],
    launchPhase: 'active',
    members: {},
  });
  expect(await store.write(teamName, snapshot, { runId: 'native-run' })).toBe(true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  setClaudeBasePathOverride(null);
  const parent = await fs.realpath(os.tmpdir());
  const target = await fs.realpath(root);
  const relative = path.relative(parent, target);
  if (!relative.startsWith('native-backup-authority-') || relative.includes(path.sep))
    throw new Error('Invalid fixture cleanup');
  await fs.rm(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

async function backupAndRemoveLive(runId?: string): Promise<Buffer> {
  const file = path.join(teamDir, 'launch-state.json');
  const content = JSON.parse(await fs.readFile(file, 'utf8'));
  if (runId) content.publicationRunId = runId;
  const bytes = Buffer.from(JSON.stringify(content));
  await fs.writeFile(path.join(backupDir, 'launch-state.json'), bytes);
  await fs.unlink(file);
  return bytes;
}

function restoreService(): TeamBackupRestoreService {
  return new TeamBackupRestoreService({
    loadManifest: async () => ({
      teamName,
      identityId: 'fixture-id',
      status: 'active',
      firstBackupAt: 'now',
      lastBackupAt: 'now',
      fileStats: { 'launch-state.json': { mtime: 1, size: 1 } },
    }),
    getBackupDir: () => backupDir,
    getSourcePathForRelPath: (_name: string, rel: string) => path.join(teamDir, rel),
    enumerateBackupFiles: async () => [],
  } as never);
}

describe('backup restore of native launch authority', () => {
  it('restores a current native snapshot despite the retained older stop marker', async () => {
    const bytes = await backupAndRemoveLive();
    expect(await store.isStopped(teamName)).toBe(false);
    expect(await restoreService().restoreMissingGenericFromManifest(teamName)).toBe(true);
    expect(await fs.readFile(path.join(teamDir, 'launch-state.json'))).toEqual(bytes);
  });
  it('does not restore a snapshot from a different run', async () => {
    await backupAndRemoveLive('other-run');
    expect(await restoreService().restoreMissingGenericFromManifest(teamName)).toBe(false);
    await expect(fs.stat(path.join(teamDir, 'launch-state.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('keeps a retained marker authoritative when freshness is absent', async () => {
    await backupAndRemoveLive();
    await fs.unlink(path.join(teamDir, 'launch-freshness.json'));
    expect(await restoreService().restoreMissingGenericFromManifest(teamName)).toBe(false);
  });
  it('does not restore a stopped native run', async () => {
    const stop = await store.beginStop(teamName, 'native-run');
    expect(await store.markStopped(teamName, stop)).toBe(true);
    await backupAndRemoveLive();
    expect(await restoreService().restoreMissingGenericFromManifest(teamName)).toBe(false);
  });
  it('fails closed when freshness cannot be read', async () => {
    await backupAndRemoveLive();
    const stat = nativeFs.promises.stat.bind(nativeFs.promises);
    const spy = vi.spyOn(nativeFs.promises, 'stat').mockImplementation(async (file, options) => {
      if (String(file) === path.join(teamDir, 'launch-freshness.json'))
        throw Object.assign(new Error('freshness EIO'), { code: 'EIO' });
      return stat(file, options as never) as never;
    });
    try {
      expect(await restoreService().restoreMissingGenericFromManifest(teamName)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
  it('still restores a current legacy successor', async () => {
    expect(await store.beginLaunch(teamName, 'legacy-successor', ['lead'], () => true)).toBe(true);
    const bytes = await backupAndRemoveLive();
    expect(await restoreService().restoreMissingGenericFromManifest(teamName)).toBe(true);
    expect(await fs.readFile(path.join(teamDir, 'launch-state.json'))).toEqual(bytes);
  });
});
