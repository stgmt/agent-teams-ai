import { describe, expect, it, vi } from 'vitest';

import { TeamBoardSnapshotCache } from './TeamBoardSnapshotCache';

describe('TeamBoardSnapshotCache', () => {
  it('serves every caller inside the window from one load', async () => {
    let now = 1_000;
    const cache = new TeamBoardSnapshotCache<number[]>(1_000, () => now);
    const load = vi.fn(async () => [1]);

    expect(await cache.get('team', load)).toEqual([1]);
    now += 400;
    expect(await cache.get('team', load)).toEqual([1]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads again after the window and after an invalidation', async () => {
    let now = 1_000;
    const cache = new TeamBoardSnapshotCache<number[]>(1_000, () => now);
    const load = vi.fn(async () => [1]);

    await cache.get('team', load);
    now += 1_200;
    await cache.get('team', load);
    expect(load).toHaveBeenCalledTimes(2);

    cache.invalidate('team');
    now += 10;
    await cache.get('team', load);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it('shares one in-flight load between concurrent callers', async () => {
    const cache = new TeamBoardSnapshotCache<number[]>(1_000, () => 1_000);
    const pending = (
      Promise as unknown as {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      }
    ).withResolvers<number[]>();
    const load = vi.fn(() => pending.promise);

    const first = cache.get('team', load);
    const second = cache.get('team', load);
    pending.resolve([7]);

    expect(await first).toEqual([7]);
    expect(await second).toEqual([7]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending load single-flight even after multiple TTL windows', async () => {
    let now = 1_000;
    const cache = new TeamBoardSnapshotCache<number[]>(1_000, () => now);
    const pending = (
      Promise as unknown as {
        withResolvers<T>(): { promise: Promise<T>; resolve: (value: T) => void };
      }
    ).withResolvers<number[]>();
    const load = vi.fn(() => pending.promise);

    const first = cache.get('team', load);
    now += 1_001;
    const second = cache.get('team', load);
    now += 10_000;
    const third = cache.get('team', load);
    pending.resolve([9]);

    expect(await Promise.all([first, second, third])).toEqual([[9], [9], [9]]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load', async () => {
    const cache = new TeamBoardSnapshotCache<number[]>(1_000, () => 1_000);
    const load = vi
      .fn<() => Promise<number[]>>()
      .mockRejectedValueOnce(new Error('registry unreachable'))
      .mockResolvedValueOnce([3]);

    await expect(cache.get('team', load)).rejects.toThrow('registry unreachable');
    expect(await cache.get('team', load)).toEqual([3]);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('keeps teams separate', async () => {
    const cache = new TeamBoardSnapshotCache<number[]>(1_000, () => 1_000);
    const loadA = vi.fn(async () => [1]);
    const loadB = vi.fn(async () => [2]);

    expect(await cache.get('a', loadA)).toEqual([1]);
    expect(await cache.get('b', loadB)).toEqual([2]);
    expect(loadA).toHaveBeenCalledTimes(1);
    expect(loadB).toHaveBeenCalledTimes(1);
  });
});
