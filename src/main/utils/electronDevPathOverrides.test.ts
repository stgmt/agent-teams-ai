// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV,
  AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV,
  applyElectronDevClaudeRootOverrideForWorker,
  applyElectronDevPathOverrides,
} from './electronDevPathOverrides';
import { getClaudeBasePath, setAppDataBasePath, setClaudeBasePathOverride } from './pathDecoder';

describe('applyElectronDevPathOverrides', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    setClaudeBasePathOverride(null);
    setAppDataBasePath(null);
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies absolute userData and Claude root overrides before Electron storage migration', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-overrides-'));
    tempDirs.push(tempRoot);
    const userDataDir = path.join(tempRoot, 'user-data');
    const claudeRoot = path.join(tempRoot, '.claude');
    const setPathCalls: Array<{ name: string; value: string }> = [];
    const result = applyElectronDevPathOverrides(
      {
        setPath: (name, value) => setPathCalls.push({ name, value }),
      },
      {
        [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: userDataDir,
        [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: claudeRoot,
      }
    );

    expect(result).toEqual({
      userDataDir,
      claudeRoot,
      warnings: [],
    });
    expect(setPathCalls).toEqual([
      {
        name: 'userData',
        value: userDataDir,
      },
      { name: 'sessionData', value: path.join(userDataDir, 'session') },
      { name: 'logs', value: path.join(userDataDir, 'logs') },
      { name: 'crashDumps', value: path.join(userDataDir, 'crashes') },
    ]);
    expect(getClaudeBasePath()).toBe(claudeRoot);
    for (const { value } of setPathCalls) {
      expect(fs.statSync(value).isDirectory()).toBe(true);
    }
    expect(fs.existsSync(claudeRoot)).toBe(true);
  });

  it('fails closed for an explicit relative userData path', () => {
    const setPathCalls: Array<{ name: string; value: string }> = [];
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath: (name, value) => setPathCalls.push({ name, value }) },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: 'relative-user-data' }
      )
    ).toThrow(`${AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV} must be an absolute path.`);
    expect(setPathCalls).toEqual([]);
  });

  it('keeps the warning for a relative Claude root without changing Electron paths', () => {
    const setPathCalls: Array<{ name: string; value: string }> = [];
    const result = applyElectronDevPathOverrides(
      { setPath: (name, value) => setPathCalls.push({ name, value }) },
      { [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: 'relative-claude-root' }
    );
    expect(result.userDataDir).toBeNull();
    expect(result.claudeRoot).toBeNull();
    expect(result.warnings).toEqual([
      `${AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV} must be an absolute path.`,
    ]);
    expect(setPathCalls).toEqual([]);
  });

  it.each([
    ['userData', null],
    ['sessionData', 'session'],
    ['logs', 'logs'],
    ['crashDumps', 'crashes'],
  ])('fails before changing Electron paths when %s cannot be created', (_name, suffix) => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-blocked-'));
    tempDirs.push(tempRoot);
    const userDataDir = path.join(tempRoot, 'user-data');
    if (suffix !== null) fs.mkdirSync(userDataDir);
    fs.writeFileSync(suffix === null ? userDataDir : path.join(userDataDir, suffix), 'blocked');
    const setPathCalls: Array<{ name: string; value: string }> = [];

    expect(() =>
      applyElectronDevPathOverrides(
        { setPath: (name, value) => setPathCalls.push({ name, value }) },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: userDataDir }
      )
    ).toThrow(/could not be created/);
    expect(setPathCalls).toEqual([]);
  });

  it('rejects an isolated subdirectory that redirects outside userData', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-link-'));
    tempDirs.push(tempRoot);
    const userDataDir = path.join(tempRoot, 'user-data');
    const redirectedDir = path.join(tempRoot, 'redirected');
    fs.mkdirSync(userDataDir);
    fs.mkdirSync(redirectedDir);
    fs.symlinkSync(
      redirectedDir,
      path.join(userDataDir, 'session'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const setPathCalls: Array<{ name: string; value: string }> = [];

    expect(() =>
      applyElectronDevPathOverrides(
        { setPath: (name, value) => setPathCalls.push({ name, value }) },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: userDataDir }
      )
    ).toThrow(/sessionData must be a real directory/);
    expect(setPathCalls).toEqual([]);
  });

  it('requires the Electron path API for an explicit userData override', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-no-path-api-'));
    tempDirs.push(tempRoot);
    expect(() =>
      applyElectronDevPathOverrides(
        {},
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: path.join(tempRoot, 'user-data') }
      )
    ).toThrow('Electron path overrides require app.setPath');
  });

  it('does not change Electron paths when no override is requested', () => {
    const setPathCalls: Array<{ name: string; value: string }> = [];
    const result = applyElectronDevPathOverrides(
      { setPath: (name, value) => setPathCalls.push({ name, value }) },
      {}
    );
    expect(result).toEqual({ userDataDir: null, claudeRoot: null, warnings: [] });
    expect(setPathCalls).toEqual([]);
  });

  it('applies the explicit Claude root inside worker-thread startup', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-worker-root-'));
    tempDirs.push(tempRoot);
    const claudeRoot = path.join(tempRoot, '.claude');

    const result = applyElectronDevClaudeRootOverrideForWorker({
      [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: claudeRoot,
    });

    expect(result).toBe(claudeRoot);
    expect(getClaudeBasePath()).toBe(claudeRoot);
  });
});
