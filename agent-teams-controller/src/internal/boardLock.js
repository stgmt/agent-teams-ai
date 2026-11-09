const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { withFileLockSync, tryWithFileLockSync } = require('./fileLock.js');
const { isReadOnlyTaskSnapshot } = require('./taskBackendSelection.js');

// An anchor intentionally groups case/Unicode variants. It must not identify
// reentrant operations: on some filesystems those variants are different teams.
const heldAnchors = new Set();
const heldTeams = new Map();

function getTeamBoardLockScope(paths) {
  return path.join(paths.teamDir, 'board-state');
}

function getClaudeRoot(paths) {
  return path.resolve(paths.claudeDir || path.dirname(path.dirname(paths.teamDir)));
}

// The outer lock lives at the physical Claude root, so moving either the team
// directory or the teams directory does not move it. Older cooperating clients
// still synchronize through the original inner team-directory lock.
function getTeamBoardAnchorScope(paths, options = {}) {
  const root = getClaudeRoot(paths);
  if (options.createParent !== false) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync.native(root);
  const name = path.basename(path.resolve(paths.teamDir));
  const normalizedName = name.normalize('NFC').toLowerCase();
  const key = crypto.createHash('sha256').update(normalizedName).digest('hex');
  return path.join(realRoot, '.agent-teams-board-locks', key);
}

function physicalTeamKey(paths) {
  try {
    const root = fs.statSync(getClaudeRoot(paths), { bigint: true });
    const team = fs.statSync(paths.teamDir, { bigint: true });
    if (!root.isDirectory() || !team.isDirectory() || !root.ino || !team.ino) {
      throw new Error('Cannot establish physical team lock identity');
    }
    return `${root.dev}:${root.ino}:${team.dev}:${team.ino}`;
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function getTeamBoardLockContext(paths) {
  const key = physicalTeamKey(paths);
  return key === null ? undefined : heldTeams.get(key);
}

function withTeamContext(paths, fn) {
  const key = physicalTeamKey(paths);
  if (key === null) throw new Error('Cannot establish physical team lock identity');
  const context = new Map();
  heldTeams.set(key, context);
  try {
    return fn();
  } finally {
    heldTeams.delete(key);
  }
}

function tryInner(paths, fn, options) {
  return tryWithFileLockSync(
    getTeamBoardLockScope(paths),
    () => ({ value: withTeamContext(paths, fn) }),
    { ...options, retainOwnerHandle: true }
  );
}

function tryWithTeamBoardLock(paths, fn, options = {}) {
  const key = physicalTeamKey(paths);
  if (key !== null && heldTeams.has(key)) return fn();
  const scope = getTeamBoardAnchorScope(paths, options);
  if (heldAnchors.has(scope)) {
    const inner = tryInner(paths, fn, options);
    return inner === null ? null : inner.value;
  }
  const attempt = tryWithFileLockSync(
    scope,
    () => {
      heldAnchors.add(scope);
      try {
        return { inner: tryInner(paths, fn, options) };
      } finally {
        heldAnchors.delete(scope);
      }
    },
    { ...options, createParent: true, retainOwnerHandle: true }
  );
  if (!attempt || !attempt.inner) return null;
  return attempt.inner.value;
}

function withTeamBoardLock(paths, fn, options = {}) {
  const key = physicalTeamKey(paths);
  if (key !== null && heldTeams.has(key)) return fn();
  // Nested acquisition cannot block the event loop or form an AB/BA deadlock.
  // A busy inner or outer lock is known not to have been acquired.
  if (heldAnchors.size > 0) {
    const result = tryWithTeamBoardLock(paths, () => ({ value: fn() }), options);
    if (result === null) throw new Error(`File lock busy: ${paths.teamDir}`);
    return result.value;
  }
  const scope = getTeamBoardAnchorScope(paths, options);
  return withFileLockSync(
    scope,
    () => {
      heldAnchors.add(scope);
      try {
        return withFileLockSync(getTeamBoardLockScope(paths), () => withTeamContext(paths, fn), {
          ...options,
          retainOwnerHandle: true,
        });
      } finally {
        heldAnchors.delete(scope);
      }
    },
    { ...options, createParent: true, retainOwnerHandle: true }
  );
}

// Detached snapshots do not wait behind an app-main async lock holder.
function withTeamBoardReadLock(paths, fn) {
  return isReadOnlyTaskSnapshot(paths) ? fn() : withTeamBoardLock(paths, fn);
}

module.exports = {
  getTeamBoardAnchorScope,
  getTeamBoardLockContext,
  getTeamBoardLockScope,
  tryWithTeamBoardLock,
  withTeamBoardLock,
  withTeamBoardReadLock,
};
