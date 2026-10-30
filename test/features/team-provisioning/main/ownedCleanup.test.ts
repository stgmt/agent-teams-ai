// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

import { OwnedRuntimeCleanupError } from '../../../../src/features/team-provisioning/core/application/OwnedRuntimeCleanupError';
import { ownedCleanup } from '../../../../src/features/team-provisioning/main/infrastructure/ownedCleanup';
import { rejectAfterOwnedCleanup } from '../../../../src/features/team-provisioning/main/infrastructure/rejectAfterOwnedCleanup';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('owned setup cleanup', () => {
  it('shares an in-flight attempt, retries rejection and never repeats successful release', async () => {
    const first = deferred();
    const failure = new Error('TEST file still locked');
    const cleanup = vi
      .fn()
      .mockImplementationOnce(async () => {
        await first.promise;
        throw failure;
      })
      .mockResolvedValue(undefined);
    const release = ownedCleanup(cleanup);
    const one = release();
    const two = release();
    expect(one).toBe(two);
    const rejected = expect(one).rejects.toBe(failure);
    first.resolve();
    await rejected;
    await Promise.all([release(), release()]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    await release();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it('attempts both cleanup owners even when one throws synchronously, and retains both on failure', async () => {
    const original = new Error('TEST setup failed');
    let blocked = true;
    const inner = vi.fn(() => {
      if (blocked) throw new Error('TEST inner cleanup locked');
      return Promise.resolve();
    });
    const outerDone = deferred();
    const outer = vi.fn(async () => {
      await outerDone.promise;
    });
    let settled = false;
    const pending = rejectAfterOwnedCleanup(
      new OwnedRuntimeCleanupError(original, inner),
      outer
    ).catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(outer).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    outerDone.resolve();
    const failure = await pending;
    expect(failure).toBeInstanceOf(OwnedRuntimeCleanupError);
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).toHaveBeenCalledOnce();
    blocked = false;
    await Promise.all([
      (failure as OwnedRuntimeCleanupError).release(),
      (failure as OwnedRuntimeCleanupError).release(),
    ]);
    expect(inner).toHaveBeenCalledTimes(2);
    expect(outer).toHaveBeenCalledTimes(2);
  });

  it('rethrows the original setup failure after both owners successfully release', async () => {
    const original = new Error('TEST original setup error');
    const inner = vi.fn(async () => {});
    const outer = vi.fn(async () => {});
    await expect(
      rejectAfterOwnedCleanup(new OwnedRuntimeCleanupError(original, inner), outer)
    ).rejects.toBe(original);
    expect(inner).toHaveBeenCalledOnce();
    expect(outer).toHaveBeenCalledOnce();
  });
});
