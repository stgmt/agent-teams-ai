import * as fs from 'fs';
import * as path from 'path';

import { setAppDataBasePath, setClaudeBasePathOverride } from './pathDecoder';

export const AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV = 'AGENT_TEAMS_ELECTRON_USER_DATA_DIR';
export const AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV = 'AGENT_TEAMS_ELECTRON_CLAUDE_ROOT';

export interface ElectronDevPathOverrideApp {
  setPath?(name: string, value: string): void;
}

export interface ElectronDevPathOverrideResult {
  userDataDir: string | null;
  claudeRoot: string | null;
  warnings: string[];
}

let appliedElectronDevClaudeRootOverride: string | null = null;

function normalizeAbsolutePath(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = path.normalize(trimmed);
  if (!path.isAbsolute(normalized)) {
    return null;
  }
  return path.resolve(normalized);
}

function ensureDirectory(dirPath: string, warnings: string[], envName: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(`${envName} could not be created: ${message}`);
    return false;
  }
}

export function resolveElectronDevClaudeRootOverride(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  return normalizeAbsolutePath(env[AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]);
}

export function getAppliedElectronDevClaudeRootOverride(): string | null {
  return appliedElectronDevClaudeRootOverride;
}

/**
 * Worker threads skip Electron startup, so they need to mirror the explicit
 * dev-only Claude root before constructing path-dependent services.
 */
export function applyElectronDevClaudeRootOverrideForWorker(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const claudeRoot = resolveElectronDevClaudeRootOverride(env);
  if (claudeRoot) {
    setClaudeBasePathOverride(claudeRoot);
  }
  return claudeRoot;
}

export function applyElectronDevPathOverrides(
  app: ElectronDevPathOverrideApp,
  env: NodeJS.ProcessEnv = process.env
): ElectronDevPathOverrideResult {
  const warnings: string[] = [];
  const userDataDir = normalizeAbsolutePath(env[AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]);
  const rawUserDataDir = env[AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV]?.trim();
  if (rawUserDataDir && !userDataDir) {
    throw new Error(`${AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV} must be an absolute path.`);
  }

  if (userDataDir) {
    if (typeof app.setPath !== 'function') {
      throw new Error('Electron path overrides require app.setPath');
    }

    const isolatedPaths = [
      ['userData', userDataDir],
      ['sessionData', path.join(userDataDir, 'session')],
      ['logs', path.join(userDataDir, 'logs')],
      ['crashDumps', path.join(userDataDir, 'crashes')],
    ] as const;

    // Prepare every path before changing any Electron path. A failed explicit
    // override must never continue with part of the regular user's profile.
    for (const [name, directory] of isolatedPaths) {
      if (
        !ensureDirectory(directory, warnings, `${AGENT_TEAMS_ELECTRON_USER_DATA_DIR_ENV}/${name}`)
      ) {
        throw new Error(warnings[warnings.length - 1]);
      }
    }
    const realUserDataDir = fs.realpathSync(userDataDir);
    for (const [name, directory] of isolatedPaths.slice(1)) {
      const relative = path.relative(realUserDataDir, fs.realpathSync(directory));
      if (
        fs.lstatSync(directory).isSymbolicLink() ||
        !relative ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        throw new Error(`Electron ${name} must be a real directory within the isolated userData`);
      }
    }
    for (const [name, directory] of isolatedPaths) {
      app.setPath(name, directory);
    }
    setAppDataBasePath(userDataDir);
  }

  const claudeRoot = resolveElectronDevClaudeRootOverride(env);
  const rawClaudeRoot = env[AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV]?.trim();
  if (rawClaudeRoot && !claudeRoot) {
    warnings.push(`${AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV} must be an absolute path.`);
  }

  const appliedClaudeRoot =
    claudeRoot && ensureDirectory(claudeRoot, warnings, AGENT_TEAMS_ELECTRON_CLAUDE_ROOT_ENV)
      ? claudeRoot
      : null;
  if (appliedClaudeRoot) {
    setClaudeBasePathOverride(appliedClaudeRoot);
  }
  appliedElectronDevClaudeRootOverride = appliedClaudeRoot;

  return {
    userDataDir,
    claudeRoot: appliedClaudeRoot,
    warnings,
  };
}
