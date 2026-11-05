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

type FakeLifecycle = NativeTeamLifecycle & { shutdown: ReturnType<typeof vi.fn> };

function fakeLifecycle(shutdown = vi.fn(() => Promise.resolve())): FakeLifecycle {
  return { shutdown } as unknown as FakeLifecycle;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('desktop native lifecycle host', () => {
  it('builds the first lifecycle from the current owner snapshot', () => {
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

  it('builds the replacement before shutting down the current lifecycle', async () => {
    const first = fakeLifecycle();
    const second = fakeLifecycle();
    const build = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const host = new DesktopTeamLifecycleHost({ owner: () => owner(1), build });
    await expect(host.replaceOwner(owner(2))).resolves.toBe(true);
    expect(first.shutdown).toHaveBeenCalledOnce();
    expect(host.current).toBe(second);
    expect(host.currentOwner).toEqual(owner(2));
    expect(build.mock.invocationCallOrder[1]).toBeLessThan(
      first.shutdown.mock.invocationCallOrder[0]
    );
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

  it('rejects a stale owner generation without rebuilding', async () => {
    const first = fakeLifecycle();
    const build = vi.fn(() => first);
    const host = new DesktopTeamLifecycleHost({ owner: () => owner(2), build });
    await expect(host.replaceOwner(owner(1))).rejects.toThrow('stale');
    expect(build).toHaveBeenCalledOnce();
    expect(first.shutdown).not.toHaveBeenCalled();
  });

  it('shuts down the unadopted replacement when the old lifecycle shutdown fails', async () => {
    const first = fakeLifecycle(vi.fn(() => Promise.reject(new Error('TEST release failed'))));
    const second = fakeLifecycle();
    const build = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const host = new DesktopTeamLifecycleHost({ owner: () => owner(1), build });
    await expect(host.replaceOwner(owner(2))).rejects.toThrow('recomposition failed');
    expect(second.shutdown).toHaveBeenCalledOnce();
    expect(host.current).toBe(first);
    expect(host.currentOwner).toEqual(owner(1));
  });

  it('serializes concurrent replacements and keeps one owner', async () => {
    const first = fakeLifecycle();
    const second = fakeLifecycle();
    const build = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const host = new DesktopTeamLifecycleHost({ owner: () => owner(1), build });
    const [a, b] = await Promise.all([host.replaceOwner(owner(2)), host.replaceOwner(owner(2))]);
    expect([a, b]).toEqual([true, false]);
    expect(host.current).toBe(second);
  });

  it('rejects replacement after terminal shutdown', async () => {
    const lifecycle = fakeLifecycle();
    const host = new DesktopTeamLifecycleHost({
      owner: () => owner(1),
      build: () => lifecycle,
    });
    await host.shutdown();
    await expect(host.replaceOwner(owner(2))).rejects.toThrow('stopped');
  });

  it('shuts down the current lifecycle once', async () => {
    const lifecycle = fakeLifecycle();
    const host = new DesktopTeamLifecycleHost({
      owner: () => owner(1),
      build: () => lifecycle,
    });
    await host.shutdown();
    await host.shutdown();
    expect(lifecycle.shutdown).toHaveBeenCalledOnce();
  });

  it('orders shutdown after an in-flight replacement', async () => {
    const first = fakeLifecycle();
    const second = fakeLifecycle();
    const oldShutdown = deferred<void>();
    first.shutdown.mockReturnValueOnce(oldShutdown.promise);
    const build = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const host = new DesktopTeamLifecycleHost({ owner: () => owner(1), build });
    const replacement = host.replaceOwner(owner(2));
    const stop = host.shutdown();
    oldShutdown.resolve();
    await expect(replacement).resolves.toBe(true);
    await stop;
    expect(second.shutdown).toHaveBeenCalledOnce();
  });
});
