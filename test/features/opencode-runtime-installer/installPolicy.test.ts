import { getLatestQualifiedOpenCodeV2Version } from '@features/opencode-compatibility';
import {
  chooseOpenCodeInstallGeneration,
  DEFAULT_OPENCODE_V1_INSTALL_VERSION,
  parseOpenCodeInstallOptions,
} from '@features/opencode-runtime-installer';
import { selectOpenCodeInstallPackage } from '@features/opencode-runtime-installer/main';
import { describe, expect, it, vi } from 'vitest';

// A moving npm tag, an unqualified platform or a malformed IPC input must not
// authorize an arbitrary V2 package; an update must retain its generation.
describe('OpenCode installation policy', () => {
  it('defaults fresh installs to V1 and retains the installed generation', () => {
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, '2.1.4')).toBe('v1');
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, null)).toBe('v1');
    expect(chooseOpenCodeInstallGeneration(undefined, '1.18.3', '2.1.4')).toBe('v1');
    expect(chooseOpenCodeInstallGeneration(undefined, '2.9.0', '2.1.4')).toBe('v2');
    expect(chooseOpenCodeInstallGeneration('v1', '2.1.4', '2.1.4')).toBe('v1');
    expect(chooseOpenCodeInstallGeneration('v2', undefined, '2.1.4')).toBe('v2');
    const unshipped = getLatestQualifiedOpenCodeV2Version('linux', 'arm64');
    expect(unshipped).toBeNull();
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, unshipped)).toBe('v1');
    expect(getLatestQualifiedOpenCodeV2Version('unsupported', 'x64')).toBeNull();
  });

  // The pinned Claude-only runtime publishes no V2 engine on any platform, so an
  // explicit V2 request can never be satisfied by a qualified version.
  it('publishes no qualified V2 engine on ARM64 while honoring an explicit choice', () => {
    const qualified = getLatestQualifiedOpenCodeV2Version('win32', 'arm64');
    expect(qualified).toBeNull();
    expect(chooseOpenCodeInstallGeneration(undefined, undefined, qualified)).toBe('v1');
    expect(chooseOpenCodeInstallGeneration('v2', undefined, qualified)).toBe('v2');
  });

  it.each([
    null,
    'v2',
    [],
    { generation: 'latest' },
    { supportOnly: 'yes' },
    { generation: 'v1', supportOnly: true },
    { version: '2.99.0' },
    { generation: 'v2', url: 'https://other.test' },
  ])('rejects invalid install options %j', (input) => {
    expect(() => parseOpenCodeInstallOptions(input)).toThrow();
  });

  it('pins the first-time V1 package and rejects redirected root metadata', async () => {
    const fetchMetadata = vi.fn(async (name: string, version?: string) => ({
      name,
      version: name === 'opencode-ai' ? '1.19.4' : version,
      optionalDependencies: { 'opencode-linux-x64': DEFAULT_OPENCODE_V1_INSTALL_VERSION },
    }));
    await expect(
      selectOpenCodeInstallPackage(
        'v1',
        '2.1.4',
        [{ packageName: 'opencode-linux-x64' }],
        fetchMetadata,
        DEFAULT_OPENCODE_V1_INSTALL_VERSION
      )
    ).rejects.toThrow('selected generation');
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    expect(fetchMetadata).toHaveBeenCalledWith('opencode-ai', DEFAULT_OPENCODE_V1_INSTALL_VERSION);
  });

  it('refuses V2 on an unqualified platform before contacting npm', async () => {
    const fetchMetadata = vi.fn();
    await expect(selectOpenCodeInstallPackage('v2', null, [], fetchMetadata)).rejects.toThrow(
      'No compatible OpenCode V2'
    );
    expect(fetchMetadata).not.toHaveBeenCalled();
  });

  // A caller cannot smuggle in a V2 package: the pinned runtime recognizes no
  // V2 version, so the fetched root package fails generation classification.
  it('refuses a V2 package version the pinned runtime does not recognize', async () => {
    const fetchMetadata = vi.fn().mockResolvedValue({
      name: '@opencode/cli',
      version: '2.0.32',
      optionalDependencies: { '@opencode/cli-linux-x64': '2.0.32' },
    });
    await expect(
      selectOpenCodeInstallPackage(
        'v2',
        '2.0.32',
        [{ packageName: 'opencode-linux-x64' }],
        fetchMetadata
      )
    ).rejects.toThrow('does not match the selected generation');
    expect(fetchMetadata.mock.calls).toEqual([['@opencode/cli', '2.0.32']]);
  });

  it('does not upgrade a V1 installation to a different generation via npm latest', async () => {
    await expect(
      selectOpenCodeInstallPackage('v1', '2.0.32', [], () =>
        Promise.resolve({
          name: 'opencode-ai',
          version: '2.0.32',
        })
      )
    ).rejects.toThrow('selected generation');
  });
});
