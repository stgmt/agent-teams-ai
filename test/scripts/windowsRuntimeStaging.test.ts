import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { constants, runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error Existing Node scripts are untyped.
import { matchesRuntimeCliVersion } from '../../scripts/lib/runtime-cli-version.mjs';
// @ts-expect-error Existing Node scripts are untyped.
import { validateWindowsRuntimeLock } from '../../scripts/lib/windows-runtime-lock.mjs';

const lock = {
  schemaVersion: 1,
  releaseKind: 'windows-x64-claude-only',
  version: '0.0.158',
  cliVersion: '2.777.777',
  sourceRepository: 'stgmt/agent_teams_orchestrator',
  releaseRepository: 'stgmt/agent_teams_orchestrator',
  sourceRef: 'refs/tags/v0.0.158',
  sourceCommit: 'a'.repeat(40),
  targetReleaseTag: 'runtime-v0.0.158',
  releaseTag: 'runtime-v0.0.158',
  opencodeV2Delivery: 'off',
  assets: {
    'win32-x64': {
      file: 'agent-teams-runtime-win32-x64-v0.0.158.zip',
      archiveKind: 'zip',
      binaryName: 'claude-multimodel.exe',
      sha256: 'b'.repeat(64),
    },
  },
};

const stagePath = path.resolve(process.cwd(), 'scripts/stage-runtime.mjs');
const stageSource = fs.readFileSync(stagePath, 'utf8');
const verifySource = stageSource.slice(
  stageSource.indexOf('function verifyStagedRuntime('),
  stageSource.indexOf('\nasync function stageRuntime(')
);
const stageFunctionSource = stageSource.slice(
  stageSource.indexOf('async function stageRuntime('),
  stageSource.indexOf('\nasync function main()')
);
const lockReaderSource = stageSource.slice(
  stageSource.indexOf('function readRuntimeLock()'),
  stageSource.indexOf('\nfunction getDefaultPlatformKey()')
);

function loadVerifyStagedRuntime(cliVersion: string) {
  return runInNewContext(`${verifySource}; verifyStagedRuntime`, {
    fs,
    path,
    runtimeDir: '',
    spawnSync: () => ({ status: 0, stdout: `${cliVersion} (Claude Code)\n` }),
    matchesRuntimeCliVersion,
  }) as (
    runtimeLock: typeof lock,
    asset: typeof lock.assets['win32-x64'],
    platformKey: string,
    payloadDir: string
  ) => void;
}

function loadRuntimeLockReader(runtimeLockPath: string) {
  return runInNewContext(`${lockReaderSource}; readRuntimeLock`, {
    fs,
    runtimeLockPath,
    validateWindowsRuntimeLock,
  }) as () => typeof lock;
}

describe('Windows runtime staging safety', () => {
  let directory = '';
  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = '';
  });

  it('preserves the installed runtime when the downloaded binary CLI version is not pinned', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-staging-test-'));
    const runtimeDir = path.join(directory, 'resources', 'runtime');
    const downloadRoot = path.join(directory, '.runtime-download');
    const payloadDir = path.join(directory, 'extracted', 'runtime');
    const runtimeLockPath = path.join(directory, 'runtime.lock.json');
    fs.writeFileSync(runtimeLockPath, JSON.stringify(lock));
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.mkdirSync(payloadDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'existing-install'), 'keep');
    fs.writeFileSync(path.join(payloadDir, 'VERSION'), lock.version);
    fs.writeFileSync(path.join(payloadDir, 'COMMIT_SHA'), lock.sourceCommit);
    fs.writeFileSync(path.join(payloadDir, lock.assets['win32-x64'].binaryName), 'fixture');

    let cleanCalled = false;
    const cleanRuntimeDir = () => {
      cleanCalled = true;
      for (const entry of fs.readdirSync(runtimeDir))
        fs.rmSync(path.join(runtimeDir, entry), { recursive: true, force: true });
    };
    const stageRuntime = runInNewContext(`${stageFunctionSource}; stageRuntime`, {
      fs,
      path,
      process: { pid: 123, stdout: { write() {} } },
      downloadRoot,
      runtimeDir,
      readRuntimeLock: loadRuntimeLockReader(runtimeLockPath),
      getReleaseAssetUrl: () => 'https://fixture.invalid/runtime.zip',
      downloadReleaseAssetWithGh: (
        runtimeLock: typeof lock,
        releaseTag: string,
        asset: typeof lock.assets['win32-x64'],
        archivePath: string
      ) => {
        expect(runtimeLock.releaseRepository).toBe(lock.releaseRepository);
        expect(releaseTag).toBe(lock.releaseTag);
        expect(asset.file).toBe(lock.assets['win32-x64'].file);
        expect(asset.sha256).toBe(lock.assets['win32-x64'].sha256);
        fs.writeFileSync(archivePath, 'fixture archive');
        return true;
      },
      downloadFile: async () => { throw new Error('unexpected network fallback'); },
      verifyRuntimeArchiveChecksum: async () => {},
      extractArchive: () => {},
      findRuntimePayloadDir: () => payloadDir,
      verifyExternalOpenCodeV2Base: () => false,
      verifyStagedRuntime: loadVerifyStagedRuntime('2.777.778'),
      cleanRuntimeDir,
    }, {
      filename: stagePath,
      importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
    }) as (options: { platform: string }) => Promise<void>;

    await expect(stageRuntime({ platform: 'win32-x64' })).rejects.toThrow(/CLI version mismatch/);
    expect(cleanCalled).toBe(false);
    expect(fs.readFileSync(path.join(runtimeDir, 'existing-install'), 'utf8')).toBe('keep');
    expect(fs.readdirSync(downloadRoot)).toEqual([]);
  });

  it('rejects an unmarked upstream lock before touching the installed runtime', async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-staging-lock-'));
    const runtimeDir = path.join(directory, 'resources', 'runtime');
    const downloadRoot = path.join(directory, '.runtime-download');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'existing-install'), 'keep');
    const upstreamLock = {
      version: '0.0.157',
      cliVersion: '2.777.777',
      sourceRepository: '777genius/agent_teams_orchestrator',
    };
    const runtimeLockPath = path.join(directory, 'runtime.lock.json');
    fs.writeFileSync(runtimeLockPath, JSON.stringify(upstreamLock));
    const stageRuntime = runInNewContext(`${stageFunctionSource}; stageRuntime`, {
      readRuntimeLock: loadRuntimeLockReader(runtimeLockPath),
    }) as (options: { platform: string }) => Promise<void>;

    await expect(stageRuntime({ platform: 'win32-x64' })).rejects.toThrow(
      /Unsupported runtime release kind/
    );
    expect(fs.readFileSync(path.join(runtimeDir, 'existing-install'), 'utf8')).toBe('keep');
    expect(fs.existsSync(downloadRoot)).toBe(false);
  });


  it('accepts only the exact runtime metadata and CLI version before publication', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-staging-verify-'));
    fs.writeFileSync(path.join(directory, 'VERSION'), lock.version);
    fs.writeFileSync(path.join(directory, 'COMMIT_SHA'), lock.sourceCommit);
    fs.writeFileSync(path.join(directory, lock.assets['win32-x64'].binaryName), 'fixture');

    expect(() => validateWindowsRuntimeLock(lock)).not.toThrow();
    expect(() => loadVerifyStagedRuntime(lock.cliVersion)(
      lock,
      lock.assets['win32-x64'],
      'win32-x64',
      directory
    )).not.toThrow();
    expect(() => loadVerifyStagedRuntime('2.777.778')(
      lock,
      lock.assets['win32-x64'],
      'win32-x64',
      directory
    )).toThrow(/CLI version mismatch/);
    expect(() => loadVerifyStagedRuntime(lock.cliVersion)(
      { ...lock, sourceCommit: 'c'.repeat(40) },
      lock.assets['win32-x64'],
      'win32-x64',
      directory
    )).toThrow(/source commit mismatch/);
    expect(() => loadVerifyStagedRuntime(lock.cliVersion)(
      { ...lock, version: '0.0.159' },
      lock.assets['win32-x64'],
      'win32-x64',
      directory
    )).toThrow(/runtime version mismatch/);
  });
});
