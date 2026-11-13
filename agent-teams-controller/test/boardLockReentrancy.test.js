const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  getTeamBoardAnchorScope,
  getTeamBoardLockContext,
  tryWithTeamBoardLock,
  withTeamBoardLock,
} = require('../src/internal/boardLock.js');
const { createController } = require('../src/index.js');

describe('board lock reentrancy', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-reentrancy-test-'));
  });
  afterEach(() => {
    const parent = fs.realpathSync(os.tmpdir());
    const target = fs.realpathSync(root);
    const relative = path.relative(parent, target);
    if (!relative.startsWith('board-reentrancy-test-') || relative.includes(path.sep)) {
      throw new Error('Refusing to remove a non-fixture path');
    }
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  });

  it('reenters the same physical team through a root junction', () => {
    const teamDir = path.join(root, 'teams', 'fixture');
    const alias = path.join(root, 'root-alias');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const original = { teamDir, claudeDir: root };
    const aliased = { teamDir: path.join(alias, 'teams', 'fixture'), claudeDir: alias };
    withTeamBoardLock(original, () => {
      const context = getTeamBoardLockContext(original);
      expect(context).toBeInstanceOf(Map);
      expect(withTeamBoardLock(aliased, () => getTeamBoardLockContext(aliased))).toBe(context);
      expect(tryWithTeamBoardLock(aliased, () => 'reentered')).toBe('reentered');
    });
  });

  it('invalidates snapshots across root aliases inside one reentrant operation', () => {
    const teamDir = path.join(root, 'teams', 'fixture');
    const alias = path.join(root, 'root-alias');
    fs.mkdirSync(teamDir, { recursive: true });
    fs.symlinkSync(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const a = createController({ teamName: 'fixture', claudeDir: root, localTaskBoard: true })
      .taskBoard;
    const b = createController({ teamName: 'fixture', claudeDir: alias, localTaskBoard: true })
      .taskBoard;
    withTeamBoardLock({ teamDir, claudeDir: root }, () => {
      a.createTask({ subject: 'first', notifyOwner: false });
      expect(a.listTasks()).toHaveLength(1);
      b.createTask({ subject: 'second', notifyOwner: false });
      expect(a.listTasks()).toHaveLength(2);
    });
  });

  it('acquires a distinct inner lock for distinct teams sharing a normalized anchor', async () => {
    const a = path.join(root, 'teams', 'caf\u00e9');
    const b = path.join(root, 'teams', 'cafe\u0301');
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    if (sa.dev === sb.dev && sa.ino === sb.ino) return;
    const pathsA = { teamDir: a, claudeDir: root };
    const pathsB = { teamDir: b, claudeDir: root };
    expect(getTeamBoardAnchorScope(pathsA)).toBe(getTeamBoardAnchorScope(pathsB));

    const ready = path.join(root, 'child-ready');
    const release = path.join(root, 'child-release');
    const code = `
      const fs = require('node:fs');
      const { withFileLockSync } = require(process.argv[1]);
      withFileLockSync(process.argv[2], () => {
        fs.writeFileSync(process.argv[3], 'ready');
        const limit = Date.now() + 10000;
        while (!fs.existsSync(process.argv[4]) && Date.now() < limit)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        if (!fs.existsSync(process.argv[4])) process.exitCode = 1;
      });
    `;
    const child = spawn(process.execPath, [
      '-e',
      code,
      require.resolve('../src/internal/fileLock.js'),
      path.join(b, 'board-state'),
      ready,
      release,
    ]);
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code) => resolve(code));
    });
    try {
      const limit = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < limit) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      expect(fs.existsSync(ready)).toBe(true);
      withTeamBoardLock(pathsA, () => {
        const contextA = getTeamBoardLockContext(pathsA);
        expect(getTeamBoardLockContext(pathsB)).toBeUndefined();
        expect(tryWithTeamBoardLock(pathsB, () => 'entered')).toBeNull();
        expect(() =>
          createController({ teamName: path.basename(b), claudeDir: root }).taskBoard.createTask({
            subject: 'must not enter',
            notifyOwner: false,
          })
        ).toThrow(/File lock busy/);
        expect(getTeamBoardLockContext(pathsA)).toBe(contextA);
        expect(fs.existsSync(path.join(root, 'tasks', path.basename(b)))).toBe(false);
      });
    } finally {
      fs.writeFileSync(release, 'release');
      expect(await exited).toBe(0);
    }

    withTeamBoardLock(pathsA, () => {
      const contextA = getTeamBoardLockContext(pathsA);
      expect(
        withTeamBoardLock(pathsB, () => {
          expect(fs.existsSync(path.join(b, 'board-state.lock'))).toBe(true);
          expect(getTeamBoardLockContext(pathsB)).not.toBe(contextA);
          return 'entered';
        })
      ).toBe('entered');
      expect(getTeamBoardLockContext(pathsB)).toBeUndefined();
    });
  }, 15000);
});
