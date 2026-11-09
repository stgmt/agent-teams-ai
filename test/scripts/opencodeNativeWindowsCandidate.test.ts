import { describe, expect, it } from 'vitest';

import { candidateRuntimeLock } from '../../scripts/e2e/opencode-native-windows-candidate';
import { readOpenCodeV2DeliveryMap } from '../../src/features/opencode-runtime-installer/core/domain/v2Delivery';

const sourceSha = 'a'.repeat(40);
const archiveSha256 = 'b'.repeat(64);
// Candidate-script tests use a standalone synthetic base, not the published runtime lock.
const candidateBase = {
  version: '0.0.100',
  assets: {
    'win32-x64': { file: 'TEST-base-x64.zip', sha256: 'c'.repeat(64) },
    'win32-arm64': { file: 'TEST-base-arm64.zip', sha256: 'd'.repeat(64) },
  },
  opencodeV2: { qualified: { 'win32-x64': ['2.0.32'] } },
  opencodeV2Delivery: { 'win32-x64': { stale: true } },
};
const contract = {
  range: { minimum: '2.0.0', below: '3.0.0' },
  qualified: { 'win32-arm64': ['2.1.4'] },
};
const descriptor = {
  schemaVersion: 1,
  runtimeVersion: candidateBase.version,
  sourceCommit: sourceSha,
  bridgeProtocol: 1,
  platform: 'win32',
  arch: 'arm64',
  requiredBunVersion: '1.4.3',
  engineVersions: ['2.1.4'],
  archive: {
    file: `agent-teams-opencode-v2-support-win32-arm64-v${candidateBase.version}.zip`,
    kind: 'zip',
    sha256: 'e'.repeat(64),
    bytes: 1024,
    entries: 2,
    expandedBytes: 512,
  },
  manifest: {
    file: 'opencode-v2-engine-manifest.json',
    sha256: 'f'.repeat(64),
    bytes: 128,
    files: 1,
  },
};
const input = {
  version: candidateBase.version,
  sourceSha,
  archiveSha256,
  platform: 'win32-arm64',
  descriptor,
  contract,
};
const originalSnapshot = JSON.stringify(candidateBase);

describe('native Windows candidate split delivery', () => {
  it('replaces stale synthetic base descriptors with the selected candidate descriptor', () => {
    const lock = candidateRuntimeLock(candidateBase, input);
    expect(Object.keys(lock.assets)).toEqual(['win32-arm64']);
    expect(readOpenCodeV2DeliveryMap(lock)).toEqual({ 'win32-arm64': descriptor });
    expect(lock.sourceRef).toBe(sourceSha);
    expect(lock.releaseTag).toBe(`TEST-native-candidate-${sourceSha}`);
    expect(lock.assets['win32-arm64']).toMatchObject({
      file: 'TEST-runtime-win32-arm64.zip',
      sha256: archiveSha256,
    });
    expect(JSON.stringify(candidateBase)).toBe(originalSnapshot);
  });

  it('stages an explicit x64 V1-only candidate without reading or retaining V2 metadata', () => {
    const lock = candidateRuntimeLock(candidateBase, {
      version: candidateBase.version,
      sourceSha,
      archiveSha256,
      platform: 'win32-x64',
      versions: 'v1',
      get contract() {
        throw new Error('V1 must not read the synthetic registry contract');
      },
      get descriptor() {
        throw new Error('V1 must not read a synthetic support descriptor');
      },
    });
    expect(lock.version).toBe(candidateBase.version);
    expect(lock.sourceRef).toBe(sourceSha);
    expect(lock.assets).toEqual({
      'win32-x64': {
        ...candidateBase.assets['win32-x64'],
        file: 'TEST-runtime-win32-x64.zip',
        sha256: archiveSha256,
      },
    });
    expect(Object.hasOwn(lock, 'opencodeV2')).toBe(false);
    expect(Object.hasOwn(lock, 'opencodeV2Delivery')).toBe(false);
    expect(readOpenCodeV2DeliveryMap(lock)).toBeNull();
    expect(JSON.stringify(candidateBase)).toBe(originalSnapshot);
    expect(() => candidateRuntimeLock(candidateBase, { ...input, versions: 'v1' })).toThrow(
      'V1 candidate requires Windows x64'
    );
  });

  it.each([
    ['missing contract', { contract: undefined }],
    ['missing descriptor', { descriptor: undefined }],
    ['source', { descriptor: { ...descriptor, sourceCommit: 'c'.repeat(40) } }],
    ['version', { version: '0.0.999' }],
    ['platform', { descriptor: { ...descriptor, arch: 'x64' } }],
    ['engine roster', { descriptor: { ...descriptor, engineVersions: ['2.0.0'] } }],
    ['Bun', { descriptor: { ...descriptor, requiredBunVersion: '1.3.11' } }],
    [
      'archive identity',
      { descriptor: { ...descriptor, archive: { ...descriptor.archive, file: 'TEST-support.zip' } } },
    ],
  ])('rejects a mismatched %s before packaging', (_label, patch) => {
    expect(() => candidateRuntimeLock(candidateBase, { ...input, ...patch })).toThrow();
  });
});
