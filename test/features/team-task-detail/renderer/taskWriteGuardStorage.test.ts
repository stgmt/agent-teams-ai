import 'fake-indexeddb/auto';

import {
  createTaskWriteGuardStorage,
  taskWriteGuardKey,
} from '@features/team-task-detail/renderer/adapters/taskWriteGuardStorage';
import { del } from 'idb-keyval';
import { afterEach, describe, expect, it, vi } from 'vitest';

const identity = {
  contextId: 'local',
  teamName: 'TEST-team',
  taskId: '1',
  dataRootFingerprint: 'a'.repeat(64),
};
const otherRoot = { ...identity, dataRootFingerprint: 'b'.repeat(64) };
const artifact = {
  version: 1 as const,
  attemptId: 'artifact-attempt',
  operation: 'artifact' as const,
};
const manifest = {
  version: 1 as const,
  attemptId: 'manifest-attempt',
  operation: 'manifest' as const,
};

describe('durable task write guard', () => {
  afterEach(async () => {
    await del(taskWriteGuardKey(identity));
    await del(taskWriteGuardKey(otherRoot));
  });

  it('atomically admits one competing operation and survives a new store instance', async () => {
    const first = createTaskWriteGuardStorage();
    const results = await Promise.allSettled([
      first.acquire(identity, artifact),
      first.acquire(identity, manifest),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const stored = await createTaskWriteGuardStorage().read(identity);
    expect([artifact, manifest]).toContainEqual(stored);
    const wrong = stored?.operation === 'artifact' ? manifest : artifact;
    await expect(first.release(identity, wrong)).rejects.toThrow(/changed/);
    expect(await first.read(identity)).toEqual(stored);
    await first.release(identity, stored!);
    expect(await first.read(identity)).toBeNull();
  });

  it('separates roots and refuses a missing fingerprint', async () => {
    const store = createTaskWriteGuardStorage();
    await store.acquire(identity, artifact);
    expect(await store.read(otherRoot)).toBeNull();
    await store.acquire(otherRoot, manifest);
    await expect(store.release(otherRoot, artifact)).rejects.toThrow(/changed/);
    expect(await store.read(identity)).toEqual(artifact);
    expect(() => taskWriteGuardKey({ ...identity, dataRootFingerprint: '' })).toThrow(
      /fingerprint/
    );
  });

  it('allows an already-cleared marker only after a decision and never removes a newer marker', async () => {
    const store = createTaskWriteGuardStorage();
    await store.acquire(identity, artifact);
    await store.release(identity, artifact);
    await expect(store.release(identity, artifact)).rejects.toThrow(/changed/);
    await expect(
      store.release(identity, artifact, { allowMissingAfterDecision: true })
    ).resolves.toBeUndefined();
    await store.acquire(identity, manifest);
    await expect(
      store.release(identity, artifact, { allowMissingAfterDecision: true })
    ).rejects.toThrow(/changed/);
    expect(await store.read(identity)).toEqual(manifest);
  });

  it('propagates unavailable storage and never grants admission', async () => {
    const backend = {
      get: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
      update: vi.fn(async () => {
        throw new Error('storage unavailable');
      }),
    };
    const store = createTaskWriteGuardStorage(backend);
    await expect(store.read(identity)).rejects.toThrow(/unavailable/);
    await expect(store.acquire(identity, artifact)).rejects.toThrow(/unavailable/);
  });
});
