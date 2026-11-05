const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { withTeamBoardLock, tryWithTeamBoardLock } = require('../src/internal/boardLock.js');
const { withFileLockSync } = require('../src/internal/fileLock.js');

describe('board lock relocation', () => {
  let root;
  let teamDir;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-relocation-test-'));
    teamDir = path.join(root, 'teams', 'fixture');
    fs.mkdirSync(teamDir, { recursive: true });
  });
  afterEach(() => {
    const parent = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(parent, target);
    if (!relative.startsWith('board-relocation-test-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    vi.restoreAllMocks();
  });

  it('does not strand a live owner when the directory moves and a legacy client reacquires', () => {
    const moved = path.join(root, 'moved');
    let renamed = false;
    withTeamBoardLock({ teamDir }, () => {
      try {
        fs.renameSync(teamDir, moved);
        renamed = true;
      } catch (error) {
        if (process.platform !== 'win32' || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code))
          throw error;
      }
    });
    if (renamed) fs.renameSync(moved, teamDir);
    expect(
      withFileLockSync(path.join(teamDir, 'board-state'), () => 'ok', {
        acquireTimeoutMs: 200,
        retryIntervalMs: 5,
      })
    ).toBe('ok');
  });

  it.each(['team', 'teams'])(
    'excludes a second process while the %s directory is moved through a root junction',
    (kind) => {
      const alias = path.join(root, 'alias');
      fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
      const source = kind === 'team' ? teamDir : path.join(root, 'teams');
      const moved = path.join(root, `moved-${kind}`);
      let attempted = false;
      withTeamBoardLock({ teamDir, claudeDir: root }, () => {
        try {
          fs.renameSync(source, moved);
        } catch (error) {
          if (process.platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code))
            return;
          throw error;
        }
        attempted = true;
        const modulePath = require.resolve('../src/internal/boardLock.js');
        const aliasTeam = path.join(alias, 'teams', 'fixture');
        const script =
          'const {tryWithTeamBoardLock}=require(process.argv[1]);const r=tryWithTeamBoardLock({teamDir:process.argv[2],claudeDir:process.argv[3]},()=>true);console.log(JSON.stringify({entered:r===true}));';
        const child = spawnSync(process.execPath, ['-e', script, modulePath, aliasTeam, alias], {
          encoding: 'utf8',
        });
        expect(child.status, child.stderr).toBe(0);
        expect(JSON.parse(child.stdout).entered).toBe(false);
      });
      if (attempted) fs.renameSync(moved, source);
    }
  );

  it('uses one anchor for case variants of a logical team name', () => {
    const variant = path.join(root, 'teams', 'FIXTURE');
    withTeamBoardLock({ teamDir, claudeDir: root }, () => {
      const childCode =
        'const {tryWithTeamBoardLock}=require(process.argv[1]);const r=tryWithTeamBoardLock({teamDir:process.argv[2],claudeDir:process.argv[3]},()=>true);console.log(JSON.stringify({entered:r===true}));';
      const child = spawnSync(
        process.execPath,
        ['-e', childCode, require.resolve('../src/internal/boardLock.js'), variant, root],
        { encoding: 'utf8' }
      );
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout).entered).toBe(false);
    });
  });

  it('does not serialize another team or a different physical root', () => {
    const otherTeam = path.join(root, 'teams', 'other');
    const otherRoot = path.join(root, 'separate-root');
    const otherRootTeam = path.join(otherRoot, 'teams', 'fixture');
    fs.mkdirSync(otherTeam, { recursive: true });
    fs.mkdirSync(otherRootTeam, { recursive: true });
    withTeamBoardLock({ teamDir, claudeDir: root }, () => {
      expect(
        tryWithTeamBoardLock({ teamDir: otherTeam, claudeDir: root }, () => 'other-team')
      ).toBe('other-team');
      expect(
        tryWithTeamBoardLock({ teamDir: otherRootTeam, claudeDir: otherRoot }, () => 'other-root')
      ).toBe('other-root');
    });
  });

  it('publishes an old-client-readable released owner on a detached inode', () => {
    const lock = path.join(teamDir, 'board-state.lock');
    const detached = path.join(root, 'detached-lock');
    withTeamBoardLock({ teamDir }, () => {
      fs.linkSync(lock, detached);
      fs.unlinkSync(lock);
      expect(fs.readFileSync(detached, 'utf8').split('\n')[0]).toBe(String(process.pid));
    });
    fs.linkSync(detached, lock);
    fs.unlinkSync(detached);
    expect(
      withFileLockSync(path.join(teamDir, 'board-state'), () => 'legacy-ok', {
        acquireTimeoutMs: 200,
        retryIntervalMs: 5,
      })
    ).toBe('legacy-ok');
  });

  it('marks only the held inode when the original path is a byte-identical copy', () => {
    const lock = path.join(teamDir, 'board-state.lock');
    const detached = path.join(root, 'detached-lock');
    let copied;
    withTeamBoardLock({ teamDir }, () => {
      fs.linkSync(lock, detached);
      fs.unlinkSync(lock);
      fs.copyFileSync(detached, lock);
      copied = fs.readFileSync(lock, 'utf8');
    });
    expect(fs.readFileSync(lock, 'utf8')).toBe(copied);
    expect(fs.readFileSync(detached, 'utf8')).not.toBe(copied);
    expect(() =>
      withFileLockSync(path.join(teamDir, 'board-state'), () => {}, {
        acquireTimeoutMs: 20,
        retryIntervalMs: 2,
      })
    ).toThrow(/File lock timeout/);
    fs.unlinkSync(lock);
    fs.linkSync(detached, lock);
    fs.unlinkSync(detached);
    expect(
      withFileLockSync(path.join(teamDir, 'board-state'), () => 'legacy-ok', {
        acquireTimeoutMs: 200,
        retryIntervalMs: 5,
      })
    ).toBe('legacy-ok');
  });

  it('fails closed if a released PID is reused by a live unrelated process', () => {
    const scope = path.join(teamDir, 'board-state');
    const lock = `${scope}.lock`;
    withTeamBoardLock({ teamDir }, () => {});
    const releasedPid = Number(fs.readFileSync(lock, 'utf8').split('\n')[0]);
    const realKill = process.kill.bind(process);
    const probe = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (pid === releasedPid && signal === 0) return true;
      return realKill(pid, signal);
    });
    expect(() =>
      withFileLockSync(scope, () => {}, {
        acquireTimeoutMs: 20,
        retryIntervalMs: 2,
      })
    ).toThrow(/File lock timeout/);
    probe.mockRestore();
    expect(
      withFileLockSync(scope, () => 'ok', {
        acquireTimeoutMs: 200,
        retryIntervalMs: 5,
      })
    ).toBe('ok');
  });

  it('keeps ownership closed when no known-dead release PID can be established', () => {
    const scope = path.join(teamDir, 'board-state');
    const lock = `${scope}.lock`;
    expect(() =>
      withTeamBoardLock({ teamDir }, () => {
        vi.spyOn(process, 'kill').mockReturnValue(true);
      })
    ).toThrow('Cannot mark retained lock safely released');
    vi.restoreAllMocks();
    expect(fs.readFileSync(lock, 'utf8').split('\n')[0]).toBe(String(process.pid));
    expect(() =>
      withFileLockSync(scope, () => {}, {
        acquireTimeoutMs: 20,
        retryIntervalMs: 2,
      })
    ).toThrow(/File lock timeout/);
  });

  it('does not publish release before callback completion and surfaces a partial write', () => {
    const lock = path.join(teamDir, 'board-state.lock');
    const detached = path.join(root, 'detached-lock');
    const originalWrite = fs.writeSync;
    let callbackFinished = false;
    let injected = false;
    expect(() =>
      withTeamBoardLock({ teamDir }, () => {
        fs.linkSync(lock, detached);
        fs.unlinkSync(lock);
        vi.spyOn(fs, 'writeSync').mockImplementation((...args) => {
          if (!injected && args[4] === 0 && Buffer.isBuffer(args[1])) {
            expect(callbackFinished).toBe(true);
            injected = true;
            originalWrite(args[0], args[1], args[2], 1, args[4]);
            throw Object.assign(new Error('partial write'), { code: 'EIO' });
          }
          return originalWrite(...args);
        });
        callbackFinished = true;
      })
    ).toThrow('partial write');
    expect(injected).toBe(true);
    expect(fs.existsSync(detached)).toBe(true);
  });

  it('does not clear a different live lock when releasing a detached one', () => {
    const lock = path.join(teamDir, 'board-state.lock');
    const detached = path.join(root, 'detached-lock');
    const other = `${process.pid}\n0\nother-owner\n`;
    withTeamBoardLock({ teamDir }, () => {
      fs.linkSync(lock, detached);
      fs.unlinkSync(lock);
      fs.writeFileSync(lock, other);
    });
    expect(fs.readFileSync(lock, 'utf8')).toBe(other);
    expect(() =>
      withFileLockSync(path.join(teamDir, 'board-state'), () => {}, {
        acquireTimeoutMs: 20,
        retryIntervalMs: 2,
      })
    ).toThrow(/File lock timeout/);
  });
});
