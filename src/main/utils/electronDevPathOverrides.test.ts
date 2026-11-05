// @vitest-environment node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
      { name: 'sessionData', value: userDataDir },
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

  it.each(['', '  '])('fails closed for an explicitly empty userData path', (value) => {
    const setPath = vi.fn();
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: value }
      )
    ).toThrow('must be an absolute path');
    expect(setPath).not.toHaveBeenCalled();
  });

  it('rejects a dev root that aliases the regular profile before creating children', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-regular-'));
    tempDirs.push(tempRoot);
    const regular = path.join(tempRoot, 'regular');
    const alias = path.join(tempRoot, 'alias');
    fs.mkdirSync(regular);
    fs.symlinkSync(regular, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const setPath = vi.fn();
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath, getPath: () => regular },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: path.join(alias, 'nested') }
      )
    ).toThrow(/overlaps regular userData/);
    expect(setPath).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(regular, 'nested'))).toBe(false);
  });

  it('rejects a junction used as the dev profile root', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-path-root-link-'));
    tempDirs.push(tempRoot);
    const target = path.join(tempRoot, 'target');
    const alias = path.join(tempRoot, 'alias');
    fs.mkdirSync(target);
    fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const setPath = vi.fn();
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: alias }
      )
    ).toThrow(/must not be a symlink or junction/);
    expect(setPath).not.toHaveBeenCalled();
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it.each(['relative-claude-root', '', '  '])(
    'fails closed for an invalid Claude root without changing Electron paths',
    (invalidRoot) => {
      const setPathCalls: Array<{ name: string; value: string }> = [];
      expect(() =>
        applyElectronDevPathOverrides(
          { setPath: (name, value) => setPathCalls.push({ name, value }) },
          { [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: invalidRoot }
        )
      ).toThrow(`${AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV} must be an absolute path.`);
      expect(setPathCalls).toEqual([]);
    }
  );

  it('rejects an uncreatable explicit Claude root before changing Electron paths', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-claude-blocked-'));
    tempDirs.push(tempRoot);
    const claudeRoot = path.join(tempRoot, 'blocked');
    fs.writeFileSync(claudeRoot, 'file');
    const setPath = vi.fn();
    expect(() =>
      applyElectronDevPathOverrides(
        { setPath },
        {
          [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: claudeRoot,
          [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: path.join(tempRoot, 'profile'),
        }
      )
    ).toThrow(/could not be created/);
    expect(setPath).not.toHaveBeenCalled();
  });

  it('rejects an invalid explicit Claude root inside worker startup too', () => {
    expect(() =>
      applyElectronDevClaudeRootOverrideForWorker({ [AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]: '' })
    ).toThrow(/must be an absolute path/);
  });

  it.each([
    ['userData', null],
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
      path.join(userDataDir, 'logs'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const setPathCalls: Array<{ name: string; value: string }> = [];

    expect(() =>
      applyElectronDevPathOverrides(
        { setPath: (name, value) => setPathCalls.push({ name, value }) },
        { [AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]: userDataDir }
      )
    ).toThrow(/logs must be a real directory/);
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
