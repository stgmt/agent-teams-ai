import 'fake-indexeddb/auto';

import {
  createTaskWriteGuardStorage,
  taskWriteGuardKey,
} from '@features/team-task-detail/renderer/adapters/taskWriteGuardStorage';
import { del, set } from 'idb-keyval';
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
      store.release(identity, artifact, { explicitDecision: true })
    ).resolves.toBeUndefined();
    await store.acquire(identity, manifest);
    await expect(store.release(identity, artifact, { explicitDecision: true })).rejects.toThrow(
      /changed/
    );
    expect(await store.read(identity)).toEqual(manifest);
    expect(await createTaskWriteGuardStorage().readDecision(identity, artifact)).toEqual({
      explicitlyResolved: true,
      marker: manifest,
    });
    expect(await store.readDecision(identity, { ...artifact, operation: 'manifest' })).toEqual({
      explicitlyResolved: false,
      marker: manifest,
    });
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

  it('does not reuse an explicitly resolved attempt token for an ABA marker', async () => {
    const store = createTaskWriteGuardStorage();
    await store.acquire(identity, manifest);
    await store.release(identity, manifest, { explicitDecision: true });
    await expect(store.acquire(identity, manifest)).rejects.toThrow(/already been resolved/);
    const decisionMarker = {
      ...manifest,
      decision: {
        actionId: 'c'.repeat(64),
        decisionId: '11111111-1111-4111-8111-111111111111',
        decision: 'retry_once' as const,
        stage: 'decision' as const,
      },
    };
    await expect(store.beginDecision(identity, null, decisionMarker)).rejects.toThrow(
      /already been resolved/
    );
    const fresh = { ...manifest, attemptId: 'fresh-attempt' };
    await store.acquire(identity, fresh);
    expect(await store.read(identity)).toEqual(fresh);
  });

  it('retains and upgrades a marker written by the earlier schema', async () => {
    await set(taskWriteGuardKey(identity), artifact);
    const store = createTaskWriteGuardStorage();
    expect(await store.read(identity)).toEqual(artifact);
    await store.release(identity, artifact, { explicitDecision: true });
    expect(await createTaskWriteGuardStorage().readDecision(identity, artifact)).toEqual({
      explicitlyResolved: true,
      marker: null,
    });
  });

  it('releases only the exact unadmitted claim and cannot undo a newer window claim', async () => {
    const first = createTaskWriteGuardStorage();
    const second = createTaskWriteGuardStorage();
    const marker = {
      ...manifest,
      attemptId: 'chosen-attempt',
      decision: {
        actionId: 'c'.repeat(64),
        decisionId: '11111111-1111-4111-8111-111111111111',
        decision: 'retry_once' as const,
        stage: 'decision' as const,
      },
    };
    const firstClaim = '11111111-1111-4111-8111-111111111111';
    const secondClaim = '22222222-2222-4222-8222-222222222222';
    await first.beginDecision(identity, null, marker);
    expect(await first.markFenceSent(identity, marker, firstClaim)).toBe(true);
    expect(await second.releaseUnadmittedFence(otherRoot, marker, firstClaim)).toBe(false);
    expect(
      await second.releaseUnadmittedFence(identity, { ...marker, attemptId: 'other' }, firstClaim)
    ).toBe(false);
    expect(
      await second.releaseUnadmittedFence(
        identity,
        { ...marker, decision: { ...marker.decision, decision: 'completed' } },
        firstClaim
      )
    ).toBe(false);
    expect(await second.releaseUnadmittedFence(identity, marker, secondClaim)).toBe(false);
    expect(await first.releaseUnadmittedFence(identity, marker, firstClaim)).toBe(true);
    expect(await second.read(identity)).toEqual(marker);
    expect(await second.markFenceSent(identity, marker, secondClaim)).toBe(true);
    expect(await first.releaseUnadmittedFence(identity, marker, firstClaim)).toBe(false);
    expect(await second.read(identity)).toMatchObject({
      fenceClaimId: secondClaim,
      decision: { stage: 'fenceSent' },
    });
    const releases = await Promise.all([
      first.releaseUnadmittedFence(identity, marker, secondClaim),
      second.releaseUnadmittedFence(identity, marker, secondClaim),
    ]);
    expect(releases.filter(Boolean)).toHaveLength(1);
    expect(await first.read(identity)).toEqual(marker);
    expect(await first.readChosenActionIds(identity)).toEqual([marker.decision.actionId]);
    await first.release(identity, marker);
    await expect(second.beginDecision(identity, null, marker)).rejects.toThrow(
      /already has a recorded decision/
    );
  });

  it('atomically replaces an uncertain marker with only one chosen answer across windows', async () => {
    const first = createTaskWriteGuardStorage();
    const second = createTaskWriteGuardStorage();
    await first.acquire(identity, manifest);
    const decisionMarker = {
      ...manifest,
      attemptId: 'chosen-attempt',
      decision: {
        actionId: 'c'.repeat(64),
        decisionId: '11111111-1111-4111-8111-111111111111',
        decision: 'retry_once' as const,
        stage: 'decision' as const,
      },
    };
    const competitor = {
      ...decisionMarker,
      attemptId: 'other-attempt',
      decision: { ...decisionMarker.decision, decisionId: '22222222-2222-4222-8222-222222222222' },
    };
    const results = await Promise.allSettled([
      first.beginDecision(identity, manifest, decisionMarker),
      second.beginDecision(identity, manifest, competitor),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const stored = await createTaskWriteGuardStorage().read(identity);
    expect([decisionMarker, competitor]).toContainEqual(stored);
    expect(await first.readDecision(identity, manifest)).toEqual({
      explicitlyResolved: true,
      marker: stored,
    });
    const claims = await Promise.all([
      first.markFenceSent(identity, stored!, '11111111-1111-4111-8111-111111111111'),
      second.markFenceSent(identity, stored!, '22222222-2222-4222-8222-222222222222'),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const recovered = await createTaskWriteGuardStorage().read(identity);
    expect(recovered?.decision).toEqual({ ...stored!.decision, stage: 'fenceSent' });
    expect(
      await first.markFenceSent(identity, stored!, '33333333-3333-4333-8333-333333333333')
    ).toBe(false);
    await first.release(identity, recovered!);
    expect(await second.readChosenActionIds(identity)).toEqual(['c'.repeat(64)]);
    await expect(second.beginDecision(identity, null, competitor)).rejects.toThrow(
      /already has a recorded decision/
    );
    expect(await second.read(identity)).toBeNull();
  });
});
