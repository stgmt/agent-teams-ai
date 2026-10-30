// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { DesktopTeamLifecycleHost } from '../../../src/main/team-runtime/desktopTeamLifecycleHost';

import type { AppConnectionContext } from '../../../src/features/external-agent-connection/contracts';
import type { NativeTeamLifecycle } from '../../../src/features/team-provisioning/main';

const owner = (generation: number): AppConnectionContext => ({
  appInstanceId: 'TEST-app',
  dataRootFingerprint: 'TEST-root',
  connectionGeneration: generation,
});

function fakeLifecycle(): NativeTeamLifecycle & { shutdown: ReturnType<typeof vi.fn> } {
  return { shutdown: vi.fn(() => Promise.resolve()) } as unknown as NativeTeamLifecycle & {
    shutdown: ReturnType<typeof vi.fn>;
  };
}

describe('desktop native lifecycle host', () => {
  it('builds the first lifecycle lazily from the current owner', () => {
    const build = vi.fn(() => fakeLifecycle());
    const host = new DesktopTeamLifecycleHost({ owner: () => owner(1), build });
    expect(build).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledWith(owner(1));
    expect(host.currentOwner).toEqual(owner(1));
  });

  it('does not rebuild for the same connection generation', async () => {
    const lifecycle = fakeLifecycle();
    const build = vi.fn(() => lifecycle);
    const host = new DesktopTeamLifecycleHost({ owner: () => owner(1), build });
    await expect(host.replaceOwner(owner(1))).resolves.toBe(false);
    expect(build).toHaveBeenCalledOnce();
    expect(lifecycle.shutdown).not.toHaveBeenCalled();
  });

  it('shuts down the old lifecycle before building the next generation', async () => {
    const first = fakeLifecycle();
    const second = fakeLifecycle();
    const build = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const host = new DesktopTeamLifecycleHost({ owner: () => owner(1), build });
    await expect(host.replaceOwner(owner(2))).resolves.toBe(true);
    expect(first.shutdown).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledTimes(2);
    expect(host.current).toBe(second);
    expect(host.currentOwner).toEqual(owner(2));
  });

  it('keeps the current lifecycle when the replacement cannot be composed', async () => {
    const first = fakeLifecycle();
    const build = vi
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce(() => {
        throw new Error('TEST composition failed');
      });
    const host = new DesktopTeamLifecycleHost({ owner: () => owner(1), build });
    await expect(host.replaceOwner(owner(2))).rejects.toThrow('TEST composition failed');
    expect(host.current).toBe(first);
    expect(host.currentOwner).toEqual(owner(1));
    expect(first.shutdown).not.toHaveBeenCalled();
  });

  it('shuts down only the current lifecycle once', async () => {
    const lifecycle = fakeLifecycle();
    const host = new DesktopTeamLifecycleHost({
      owner: () => owner(1),
      build: () => lifecycle,
    });
    await host.shutdown();
    await host.shutdown();
    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
  });
});
