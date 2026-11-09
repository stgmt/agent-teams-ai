import {
  classifyNativeVersion,
  getLatestQualifiedOpenCodeV2Version,
  isOpenCodeVersionProductionEligible,
  isOpenCodeVersionServedByRuntime,
  isRecognizedOpenCodeRuntimeVersion,
  negotiateOpenCodeProtocol,
} from '@features/opencode-compatibility';
import { evaluateOpenCodeSupport } from '@main/services/team/opencode/version/OpenCodeVersionPolicy';
import {
  compareVersions,
  getUnsupportedAgentTeamsOpenCodeVersionMessage,
  isAgentTeamsOpenCodeVersionSupported,
  normalizeVersion,
} from '@shared/utils/version';
import { describe, expect, it, vi } from 'vitest';

import runtimeLock from '../../../runtime.lock.json';
import {
  engineForNativeVersion,
  openCodeV2ContractCovers,
  openCodeV2ContractQualifies,
  openCodeV2ContractShipsV2,
  openCodeV2PlatformKeys,
  readOpenCodeV2Contract,
} from '../../../src/features/opencode-compatibility/core/domain/openCodeV2Contract';

import { isOpenCodeRuntimeUsable } from '../../../src/features/runtime-provider-management/core/domain/runtimeProviderQuickConnect';
import type { OpenCodeApiCapabilities } from '@main/services/team/opencode/capabilities/OpenCodeApiCapabilities';


describe('published OpenCode V2 support boundary', () => {
  it('honestly reflects the V1-only release and supplies no V2 engine', () => {
    expect(Object.hasOwn(runtimeLock, 'opencodeV2')).toBe(false);
    expect(runtimeLock.opencodeV2Delivery).toBe('off');
    expect(getLatestQualifiedOpenCodeV2Version('win32', 'x64')).toBeNull();
    expect(getLatestQualifiedOpenCodeV2Version('win32', 'arm64')).toBeNull();
    expect(classifyNativeVersion('2.0.32')).toEqual({
      kind: 'blocked',
      reason: 'unknown_generation',
    });
    expect(isRecognizedOpenCodeRuntimeVersion('2.0.32')).toBe(false);
    expect(isOpenCodeVersionServedByRuntime('2.0.32')).toBe(false);
    expect(isOpenCodeVersionProductionEligible('2.0.32')).toBe(false);
    expect(isAgentTeamsOpenCodeVersionSupported('2.0.32')).toBe(false);
    expect(negotiateOpenCodeProtocol({ version: '2.0.32' }).kind).toBe('blocked');
  });
});

describe('synthetic OpenCode V2 contract algorithms', () => {
  it('rejects an absent contract input', () => {
    expect(readOpenCodeV2Contract(undefined)).toBeNull();
  });
  it('reports no V2 shipped by an empty synthetic qualification fixture', () => {
    const withoutV2 = readOpenCodeV2Contract({
      range: { minimum: '2.0.0', below: '3.0.0' },
      qualified: { 'darwin-arm64': [], 'linux-x64': [], 'win32-x64': [] },
    })!;
    expect(openCodeV2ContractShipsV2(withoutV2)).toBe(false);
  });

  const fixture = readOpenCodeV2Contract({
    range: { minimum: '2.0.0', below: '3.0.0' },
    qualified: { 'darwin-arm64': ['2.0.0', '2.1.4'], 'linux-x64': ['2.0.0'], 'win32-arm64': [] },
  })!;

  it('qualifies a version only on the platforms its synthetic records list', () => {
    expect(openCodeV2ContractShipsV2(fixture)).toBe(true);
    expect(openCodeV2ContractQualifies(fixture, ['darwin-arm64'], '2.1.4')).toBe(true);
    expect(openCodeV2ContractQualifies(fixture, ['linux-x64'], '2.1.4')).toBe(false);
    expect(openCodeV2ContractQualifies(fixture, ['linux-x64'], '2.0.0')).toBe(true);
    expect(openCodeV2ContractQualifies(fixture, ['win32-arm64'], '2.0.0')).toBe(false);
    expect(openCodeV2ContractQualifies(fixture, ['darwin-x64'], '2.0.0')).toBe(false);
    expect(openCodeV2ContractQualifies(fixture, [], '2.0.0')).toBe(false);
    expect(openCodeV2ContractCovers(fixture, '2.37.105')).toBe(true);
    expect(openCodeV2ContractQualifies(fixture, ['darwin-arm64'], '2.37.105')).toBe(false);
    for (const version of ['1.99.0', '3.0.0', '2.1.4-rc.1', 'opencode v2.1.4', ' 2.1.4'])
      expect(openCodeV2ContractCovers(fixture, version)).toBe(false);
  });

  it('keeps old contracts strict and maps flexible native identities only to qualified platform engines', () => {
    const flexible = readOpenCodeV2Contract({
      ...fixture,
      cliVersionPolicy: 'stable-v2-qualified-engine',
    })!;
    expect(engineForNativeVersion(fixture, ['darwin-arm64'], '2.37.105')).toBeNull();
    expect(engineForNativeVersion(flexible, ['darwin-arm64'], '2.37.105')).toBe('2.1.4');
    expect(engineForNativeVersion(flexible, ['darwin-arm64'], '2.0.0')).toBe('2.0.0');
    expect(engineForNativeVersion(flexible, ['linux-x64'], '2.37.105')).toBe('2.0.0');
    expect(engineForNativeVersion(flexible, ['win32-arm64'], '2.37.105')).toBeNull();
    expect(engineForNativeVersion(flexible, [], '2.37.105')).toBeNull();
    expect(openCodeV2ContractQualifies(flexible, ['darwin-arm64'], '2.37.105')).toBe(false);
    for (const version of ['2.1.4-rc.1', '2.1.4+build.1', '3.0.0', '1.18.3'])
      expect(engineForNativeVersion(flexible, ['darwin-arm64'], version)).toBeNull();
  });

  it('uses the preload target for each Mac architecture and refuses ambiguous flexible selection', () => {
    const contract = readOpenCodeV2Contract({
      range: { minimum: '2.0.0', below: '3.0.0' },
      cliVersionPolicy: 'stable-v2-qualified-engine',
      qualified: { 'darwin-arm64': ['2.0.32', '2.1.4'], 'darwin-x64': ['2.0.32'] },
    })!;
    const navigator = { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' };
    for (const [arch, expected] of [
      ['arm64', '2.1.4'],
      ['x64', '2.0.32'],
    ] as const) {
      const keys = openCodeV2PlatformKeys({
        electronAPI: { openCodeRuntime: { platform: 'darwin', arch } },
        navigator,
      });
      expect(keys).toEqual([`darwin-${arch}`]);
      expect(engineForNativeVersion(contract, keys, '2.37.105')).toBe(expected);
    }
    expect(
      openCodeV2PlatformKeys({
        electronAPI: { openCodeRuntime: { platform: 'darwin', arch: 'x64' } },
        process: { platform: 'darwin', arch: 'arm64' },
        navigator,
      })
    ).toEqual(['darwin-x64']);
    const ambiguous = openCodeV2PlatformKeys({ navigator });
    expect(engineForNativeVersion(contract, ambiguous, '2.37.105')).toBeNull();
    expect(engineForNativeVersion(contract, ambiguous, '2.0.32')).toBeNull();
    const legacy = readOpenCodeV2Contract({
      range: contract.range,
      qualified: contract.qualified,
    })!;
    expect(engineForNativeVersion(legacy, ambiguous, '2.0.32')).toBe('2.0.32');
  });

  it('classifies native V2 versions against an explicitly synthetic qualification contract', async () => {
    vi.resetModules();
    vi.doMock('../../../runtime.lock.json', () => ({
      default: {
        opencodeV2: {
          range: { minimum: '2.0.0', below: '3.0.0' },
          cliVersionPolicy: 'stable-v2-qualified-engine',
          qualified: { [`${process.platform}-${process.arch}`]: ['2.0.32', '2.1.4'] },
        },
      },
    }));
    try {
      const generation =
        await import('../../../src/features/opencode-compatibility/core/domain/generation');
      expect(generation.classifyNativeVersion('opencode v2.37.105')).toEqual({
        kind: 'recognized',
        generation: 'v2',
        version: '2.37.105',
        apiDialect: 'v2-2.1.4',
        productionEligible: true,
      });
      expect(generation.classifyNativeVersion('2.0.32')).toMatchObject({
        version: '2.0.32',
        apiDialect: 'v2-2.0.32',
        productionEligible: true,
      });
      for (const version of ['2.37.105-beta.1', '2.37.105+build.1', '3.0.0'])
        expect(generation.classifyNativeVersion(version).kind).toBe('blocked');
    } finally {
      vi.doUnmock('../../../runtime.lock.json');
      vi.resetModules();
    }
  });

  it.each([
    ['main process', { process: { platform: 'linux', arch: 'x64' } }, ['linux-x64']],
    [
      'sandboxed macOS renderer',
      { navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } },
      ['darwin-arm64', 'darwin-x64'],
    ],
    [
      'sandboxed Windows renderer',
      { navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } },
      ['win32-arm64', 'win32-x64'],
    ],
    [
      'sandboxed Linux renderer',
      { navigator: { userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' } },
      ['linux-arm64', 'linux-x64'],
    ],
    ['unknown environment', { navigator: { userAgent: 'Other' } }, []],
    ['no environment', {}, []],
  ] as const)('derives platform keys for a %s', (_name, environment, keys) => {
    expect(openCodeV2PlatformKeys(environment)).toEqual(keys);
  });


  it.each([null, {}, { 'linux-arm64': null }])(
    'refuses malformed delivery metadata in synthetic lock fixtures (%j)',
    async (delivery) => {
      vi.resetModules();
      const platformKey = `${process.platform}-${process.arch}`;
      vi.doMock('../../../runtime.lock.json', () => ({
        default: {
          assets: { [platformKey]: { file: 'TEST-base-archive' } },
          opencodeV2: {
            range: { minimum: '2.0.0', below: '3.0.0' },
            qualified: { [platformKey]: ['2.0.32'] },
          },
          opencodeV2Delivery: delivery,
        },
      }));
      try {
        const pinned =
          await import('../../../src/features/opencode-compatibility/core/domain/pinnedOpenCodeV2Contract');
        expect(
          pinned.getLatestQualifiedOpenCodeV2Version(process.platform, process.arch)
        ).toBeNull();
        expect(pinned.getOpenCodeV2EngineVersion('2.0.32')).toBeNull();
        expect(pinned.pinnedRuntimeShipsOpenCodeV2()).toBe(false);
      } finally {
        vi.doUnmock('../../../runtime.lock.json');
        vi.resetModules();
      }
    }
  );

  it('recognizes no V2 version when a synthetic pinned contract is malformed', async () => {
    vi.resetModules();
    vi.doMock('../../../runtime.lock.json', () => ({
      default: { opencodeV2: { range: { minimum: '2.0.0', below: '4.0.0' }, qualified: {} } },
    }));
    try {
      const generation =
        await import('../../../src/features/opencode-compatibility/core/domain/generation');
      expect(generation.classifyNativeVersion('2.0.0')).toEqual({
        kind: 'blocked',
        reason: 'unknown_generation',
      });
      expect(generation.isOpenCodeVersionProductionEligible('2.0.0')).toBe(false);
      expect(generation.classifyNativeVersion('1.16.0').kind).toBe('recognized');
    } finally {
      vi.doUnmock('../../../runtime.lock.json');
      vi.resetModules();
    }
  });

  it('fails closed for V2 against the actual V1-only release', () => {
    expect(Object.hasOwn(runtimeLock, 'opencodeV2')).toBe(false);
    expect(runtimeLock.opencodeV2Delivery).toBe('off');

    expect(isOpenCodeRuntimeUsable({
      installed: true,
      version: '2.0.32',
      source: 'path',
      state: 'ready',
    })).toBe(false);
    expect(isOpenCodeRuntimeUsable({
      installed: true,
      version: '1.19.4',
      source: 'path',
      state: 'ready',
    })).toBe(true);
    expect(classifyNativeVersion('2.0.32')).toEqual({
      kind: 'blocked',
      reason: 'unknown_generation',
    });
    expect(isOpenCodeVersionServedByRuntime('2.0.32')).toBe(false);
    expect(isOpenCodeVersionProductionEligible('2.0.32')).toBe(false);
    expect(isOpenCodeVersionServedByRuntime('1.19.4')).toBe(true);
  });


  it.each([
    ['missing', undefined],
    ['unknown CLI version policy', { ...fixture, cliVersionPolicy: 'all-2x' }],
    ['null CLI version policy', { ...fixture, cliVersionPolicy: null }],
    ['inverted range', { range: { minimum: '3.0.0', below: '2.0.0' }, qualified: {} }],
    ['range below V2', { range: { minimum: '1.16.0', below: '3.0.0' }, qualified: {} }],
    ['range beyond V2', { range: { minimum: '2.0.0', below: '4.0.0' }, qualified: {} }],
    ['prerelease bound', { range: { minimum: '2.0.0-rc.1', below: '3.0.0' }, qualified: {} }],
    [
      'out-of-range record',
      { range: { minimum: '2.0.0', below: '3.0.0' }, qualified: { 'darwin-arm64': ['3.0.0'] } },
    ],
    [
      'unsorted records',
      {
        range: { minimum: '2.0.0', below: '3.0.0' },
        qualified: { 'linux-x64': ['2.1.4', '2.0.32'] },
      },
    ],
    [
      'duplicate records',
      {
        range: { minimum: '2.0.0', below: '3.0.0' },
        qualified: { 'win32-x64': ['2.1.4', '2.1.4'] },
      },
    ],
    [
      'prerelease record',
      { range: { minimum: '2.0.0', below: '3.0.0' }, qualified: { 'darwin-x64': ['2.1.4-rc.1'] } },
    ],
    ['flat list', { range: { minimum: '2.0.0', below: '3.0.0' }, qualified: ['2.1.4'] }],
    [
      'unknown platform',
      { range: { minimum: '2.0.0', below: '3.0.0' }, qualified: { 'freebsd-x64': ['2.1.4'] } },
    ],
  ])('refuses a malformed contract (%s)', (_name, contract) => {
    expect(readOpenCodeV2Contract(contract)).toBeNull();
  });
});

describe('native runtime discovery', () => {
  it.each([
    ['1.18.35', true],
    ['1.16.0', true],
    ['2.0.0', false],
    ['opencode v2.0.32', false],
    ['3.0.0', false],
    ['2.0.32-beta.1', false],
    ['2.0.32+build.7', false],
    ['1.15.9', false],
    [undefined, false],
  ])('recognizes stable V1 but not V2 for the published runtime (%s)', (version, recognized) => {
    expect(isRecognizedOpenCodeRuntimeVersion(version)).toBe(recognized);
  });
});

// The published runtime is V1-only; its public consumers must refuse every unsupported V2 input.
describe('current public OpenCode policy consumers', () => {
  it.each([
    '2.0.0',
    '2.0.32',
    '2.1.0',
    '3.0.0',
    '999.0.0',
    '1.16.0-beta.1',
    '1.16.0 garbage',
    'OpenCode 1.16.0',
    '01.16.0',
    '1.16.0+',
    '1.16.0-01',
    '1.16.0\n2.0.0',
  ])('rejects %s even with ready V1 capabilities', (version) => {
    const capabilities = {
      requiredForTeamLaunch: { ready: true, missing: [] },
    } as unknown as OpenCodeApiCapabilities;
    expect(evaluateOpenCodeSupport({ version, capabilities }).supported).toBe(false);
    expect(isAgentTeamsOpenCodeVersionSupported(version)).toBe(false);
  });

  it.each(['2.0.0', '2.0.32', '3.0.0', 'garbage'])(
    'vetoes %s before accessing V1 evidence',
    (version) => {
      let reads = 0;
      const input = {
        version,
        get capabilities(): OpenCodeApiCapabilities {
          reads++;
          throw new Error('V1 native capability probing must not run');
        },
      };
      expect(evaluateOpenCodeSupport(input).supported).toBe(false);
      expect(reads).toBe(0);
    }
  );

  it.each(['1.16.0', 'v1.18.0\n', '1.99.12', '1.16.0+build.7'])(
    'retains V1 support for %s',
    (version) => {
      expect(isAgentTeamsOpenCodeVersionSupported(version)).toBe(true);
      expect(
        evaluateOpenCodeSupport({
          version,
          capabilities: {
            requiredForTeamLaunch: { ready: true, missing: [] },
          } as unknown as OpenCodeApiCapabilities,
        })
      ).toEqual({
        supported: true,
        supportLevel: 'production_supported',
        semver: {
          major: 1,
          minor: Number(version.replace(/^v/, '').split('.')[1]),
          patch: version.includes('1.99') ? 12 : 0,
          prerelease: [],
        },
        diagnostics: [],
      });
    }
  );

  it('retains pre-change V1 missing-capability and below-minimum diagnostics', () => {
    expect(
      evaluateOpenCodeSupport({
        version: '1.16.0',
        capabilities: {
          requiredForTeamLaunch: { ready: false, missing: ['POST permission reply route'] },
        } as unknown as OpenCodeApiCapabilities,
      })
    ).toEqual({
      supported: false,
      supportLevel: 'supported_capabilities_pending',
      semver: { major: 1, minor: 16, patch: 0, prerelease: [] },
      diagnostics: ['POST permission reply route'],
    });
    expect(
      evaluateOpenCodeSupport({ version: '1.4.0', capabilities: {} as OpenCodeApiCapabilities })
    ).toEqual({
      supported: false,
      supportLevel: 'unsupported_too_old',
      semver: { major: 1, minor: 4, patch: 0, prerelease: [] },
      diagnostics: ['OpenCode 1.4.0 is below supported minimum 1.16.0'],
    });
    expect(getUnsupportedAgentTeamsOpenCodeVersionMessage('1.4.0')).toBe(
      'OpenCode 1.4.0 is below the supported minimum 1.16.0. Update OpenCode before loading providers, models, or launching teammates.'
    );
  });

  it('cannot override the stable V1 generation boundary', () => {
    expect(
      evaluateOpenCodeSupport({
        version: '2.0.0',
        capabilities: {} as OpenCodeApiCapabilities,
        policy: { minimumVersion: '1.0.0', allowedPrerelease: true, requireCapabilities: false },
      }).supported
    ).toBe(false);
    expect(
      evaluateOpenCodeSupport({
        version: '1.16.0-beta.1',
        capabilities: {} as OpenCodeApiCapabilities,
        policy: { minimumVersion: '1.0.0', allowedPrerelease: true, requireCapabilities: false },
      }).supported
    ).toBe(false);
  });

  it.each(['2.0.0', '2.0.32', '2.0.21', '2.1.4', '2.37.105'])(
    'reports unsupported native V2 output as blocked by this release',
    (version) => {
      const stdout = `opencode v${version}\n`;
      expect(classifyNativeVersion(stdout)).toEqual({
        kind: 'blocked',
        reason: 'unknown_generation',
      });
      expect(isRecognizedOpenCodeRuntimeVersion(stdout)).toBe(false);
      expect(isOpenCodeVersionServedByRuntime(stdout)).toBe(false);
      expect(isOpenCodeVersionProductionEligible(stdout)).toBe(false);
      expect(isAgentTeamsOpenCodeVersionSupported(stdout)).toBe(false);
      expect(negotiateOpenCodeProtocol({ version: stdout }).kind).toBe('blocked');
      let reads = 0;
      expect(
        evaluateOpenCodeSupport({
          version: stdout,
          get capabilities(): OpenCodeApiCapabilities {
            reads++;
            throw new Error('unsupported V2 must not read V1 capabilities');
          },
        }).supported
      ).toBe(false);
      expect(reads).toBe(0);
    }
  );

  it.each(['3.0.0', 'garbage', '1.16.0-beta.1'])(
    'reports the actual rejection for %s',
    (version) => {
      const message = getUnsupportedAgentTeamsOpenCodeVersionMessage(version);
      expect(message).toContain(version);
      expect(message).not.toContain('below');
      expect(message).toContain('stable OpenCode V1');
    }
  );


  it.each([
    'opencode v1.18.34',
    'OpenCode v2.0.0',
    'diagnostic: opencode v2.0.0',
    'opencode v2.0.0\n2.0.32',
    '\u001b[32mopencode v2.0.0\u001b[0m',
    'opencode v2.0.0+build.7',
    'opencode v2.0.0-beta.1',
    'opencode v3.0.0',
  ])('keeps decorated or out-of-range CLI text %s blocked', (stdout) => {
    expect(classifyNativeVersion(stdout).kind).toBe('blocked');
    expect(isAgentTeamsOpenCodeVersionSupported(stdout)).toBe(false);
  });

  it('keeps generic version helpers permissive for other products', () => {
    expect(normalizeVersion('2.1.34 (Claude Code)\n')).toBe('2.1.34');
    expect(compareVersions('v3.0.0 (Other)', '2.1.0')).toBe(1);
    expect(compareVersions('1.2.3-beta', 'v1.2.3')).toBe(0);
  });
});
