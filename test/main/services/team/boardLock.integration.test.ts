import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

import { withTeamBoardLockForSyncOperation } from '@main/services/team/boardLock';
import { TeamTaskActivityIntervalService } from '@main/services/team/TeamTaskActivityIntervalService';
import { setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const requireFromTest = createRequire(import.meta.url);
const { withFileLock } = requireFromTest(
  '../../../../agent-teams-controller/src/internal/fileLock.js'
) as {
  withFileLock: <T>(scope: string, fn: () => Promise<T>) => Promise<T>;
};
const { boardLocks } = requireFromTest('../../../../agent-teams-controller/src/index.js') as {
  boardLocks: {
    withTeamBoardLock: <T>(paths: { teamDir: string; claudeDir: string }, fn: () => T) => T;
    tryWithTeamBoardLock: <T>(
      paths: { teamDir: string; claudeDir: string },
      fn: () => T
    ) => T | null;
  };
};

describe('desktop and controller board-lock coordination', () => {
  let root: string;
  let paths: { teamDir: string; claudeDir: string };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-lock-coordination-'));
    paths = { claudeDir: root, teamDir: path.join(root, 'teams', 'fixture') };
    fs.mkdirSync(paths.teamDir, { recursive: true });
  });
  afterEach(() => {
    setClaudeBasePathOverride(null);
    const parent = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(parent, target);
    if (!relative.startsWith('team-lock-coordination-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it('never yields while holding the outer lock when the legacy inner lock is busy', async () => {
    const inner = path.join(paths.teamDir, 'board-state');
    let release!: () => void;
    let announce!: () => void;
    const locked = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withFileLock(inner, async () => {
      announce();
      await gate;
    });
    await locked;
    let writes = 0;
    const operation = withTeamBoardLockForSyncOperation(
      paths,
      () => {
        writes += 1;
      },
      { acquireTimeoutMs: 2_000, retryIntervalMs: 5 }
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes).toBe(0);
    expect(boardLocks.tryWithTeamBoardLock(paths, () => 'unexpected')).toBeNull();
    release();
    await holder;
    await operation;
    expect(writes).toBe(1);
  });

  it('returns a known busy result for background activity rather than blocking its lock owner', async () => {
    setClaudeBasePathOverride(root);
    const taskDir = path.join(root, 'tasks', 'fixture');
    fs.mkdirSync(taskDir, { recursive: true });
    const taskPath = path.join(taskDir, 'task.json');
    const before = JSON.stringify({
      id: 'task',
      status: 'in_progress',
      workIntervals: [{ startedAt: '2026-01-01T00:00:00Z' }],
      historyEvents: [],
    });
    fs.writeFileSync(taskPath, before);
    let release!: () => void;
    let announce!: () => void;
    const locked = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = withFileLock(path.join(paths.teamDir, 'board-state'), async () => {
      announce();
      await gate;
    });
    await locked;
    try {
      const result = new TeamTaskActivityIntervalService().pauseActiveIntervalsForTeam(
        'fixture',
        '2026-01-01T01:00:00Z'
      );
      expect(result).toMatchObject({ changedTasks: 0, failed: true });
      expect(fs.readFileSync(taskPath, 'utf8')).toBe(before);
    } finally {
      release();
      await holder;
    }
  });

  it('releases both locks before running microtasks in the same event loop', async () => {
    let next: string | undefined;
    await withTeamBoardLockForSyncOperation(paths, () => {
      queueMicrotask(() => {
        next = boardLocks.withTeamBoardLock(paths, () => 'acquired');
      });
    });
    await Promise.resolve();
    expect(next).toBe('acquired');
  });
});
