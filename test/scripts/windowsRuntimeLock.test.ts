import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readOpenCodeV2DeliveryMap } from '../../src/features/opencode-runtime-installer/core/domain/v2Delivery';
import { verifyExternalOpenCodeV2Base } from '../../scripts/lib/opencode-v2-base-inventory.mts';
// @ts-expect-error Existing Node scripts are untyped.
import { validateWindowsRuntimeLock } from '../../scripts/lib/windows-runtime-lock.mjs';

const lock = () => ({
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
  assets: { 'win32-x64': {
    file: 'agent-teams-runtime-win32-x64-v0.0.158.zip', archiveKind: 'zip',
    binaryName: 'claude-multimodel.exe', sha256: 'b'.repeat(64),
  } },
});

describe('Windows Claude-only runtime lock', () => {
  let directory = '';
  afterEach(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); directory = ''; });

  it('accepts only the explicit fork release identity and one pinned asset', () => {
    expect(() => validateWindowsRuntimeLock(lock())).not.toThrow();
    for (const patch of [
      { releaseKind: undefined }, { cliVersion: undefined }, { cliVersion: '2.777' },
      { sourceRepository: 'other/fork' }, { releaseRepository: 'other/fork' },
      { sourceRef: 'refs/heads/main' }, { sourceCommit: 'bad' },
      { targetReleaseTag: 'runtime-v0.0.159' }, { opencodeV2Delivery: {} },
      { assets: { ...lock().assets, 'linux-x64': {} } },
      { assets: { 'win32-x64': { ...lock().assets['win32-x64'], sha256: 'invalid' } } },
      { opencodeV2: {} }, { releaseKind: 'unknown' },
    ]) expect(() => validateWindowsRuntimeLock({ ...lock(), ...patch })).toThrow();
    expect(() => validateWindowsRuntimeLock({
      version: '0.0.157',
      sourceRepository: '777genius/agent_teams_orchestrator',
      releaseRepository: '777genius/agent_teams_orchestrator_binaries',
    })).toThrow();
  });

  it('treats disabled V2 as unavailable rather than legacy bundled support', () => {
    expect(readOpenCodeV2DeliveryMap(lock())).toEqual({});
    expect(() => readOpenCodeV2DeliveryMap({ ...lock(), opencodeV2Delivery: {} })).toThrow();
    expect(() => readOpenCodeV2DeliveryMap({ ...lock(), cliVersion: undefined })).toThrow();
    expect(() => readOpenCodeV2DeliveryMap({ ...lock(), releaseKind: 'unsupported' })).toThrow();
    expect(readOpenCodeV2DeliveryMap({ version: '0.0.157' })).toBeNull();
  });

  it('checks exact extracted commit and version before staging and rejects other targets', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'windows-runtime-lock-'));
    fs.writeFileSync(path.join(directory, 'COMMIT_SHA'), lock().sourceCommit);
    fs.writeFileSync(path.join(directory, 'VERSION'), lock().version);
    expect(verifyExternalOpenCodeV2Base(directory, lock(), 'win32-x64')).toBe(false);
    expect(() => verifyExternalOpenCodeV2Base(directory, lock(), 'linux-x64')).toThrow();
    fs.writeFileSync(path.join(directory, 'VERSION'), `prefix-${lock().version}`);
    expect(() => verifyExternalOpenCodeV2Base(directory, lock(), 'win32-x64')).toThrow();
    fs.writeFileSync(path.join(directory, 'VERSION'), lock().version);
    fs.writeFileSync(path.join(directory, 'COMMIT_SHA'), 'c'.repeat(40));
    expect(() => verifyExternalOpenCodeV2Base(directory, lock(), 'win32-x64')).toThrow();
  });
});
