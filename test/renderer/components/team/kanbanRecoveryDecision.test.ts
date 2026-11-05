import 'fake-indexeddb/auto';

import {
  createKanbanRecoveryDecisionStorage,
  kanbanRecoveryDecisionKey,
} from '@renderer/components/team/kanbanRecoveryDecision';
import { del, set } from 'idb-keyval';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PendingKanbanTransitionSnapshot } from '@shared/types/kanbanRecovery';

const snapshot: PendingKanbanTransitionSnapshot = {
  taskId: 'task-1',
  contextHash: 'a'.repeat(64),
  transitionId: '12345678-1234-4234-9234-123456789abc',
  column: 'none',
  targetStatus: 'pending',
  operation: 'status',
  phase: 'applied',
  mode: 'publish',
  snapshotHash: 'b'.repeat(64),
};
const anotherRoot = { ...snapshot, contextHash: 'c'.repeat(64) };
const nextOperation = { ...snapshot, transitionId: '87654321-4321-4321-8321-cba987654321' };

afterEach(async () => {
  await Promise.all(
    [snapshot, anotherRoot, nextOperation].map((item) => del(kanbanRecoveryDecisionKey(item)))
  );
});

describe('durable Kanban recovery decision', () => {
  it('atomically allows one question across independent windows and survives restart', async () => {
    const first = createKanbanRecoveryDecisionStorage();
    const second = createKanbanRecoveryDecisionStorage();
    const claims = await Promise.all([
      first.claim('alpha', snapshot),
      second.claim('alpha', snapshot),
    ]);
    expect(claims.filter((claim) => claim.claimed)).toHaveLength(1);
    expect(claims.filter((claim) => !claim.claimed)).toHaveLength(1);
    const winner = claims.find((claim) => claim.claimed)!;
    await first.transition('alpha', snapshot, winner.record.owner, ['prompting'], 'sending');
    const restarted = createKanbanRecoveryDecisionStorage();
    expect((await restarted.claim('alpha', snapshot)).claimed).toBe(false);
    expect((await restarted.read(snapshot))?.phase).toBe('sending');
    await first.transition('alpha', snapshot, winner.record.owner, ['sending'], 'confirmed');
    expect((await restarted.read(snapshot))?.phase).toBe('confirmed');
  });

  it('records a declined decision and prevents another question', async () => {
    const store = createKanbanRecoveryDecisionStorage();
    const claim = await store.claim('alpha', snapshot);
    await store.transition('alpha', snapshot, claim.record.owner, ['prompting'], 'declined');
    const reopened = await createKanbanRecoveryDecisionStorage().claim('alpha', snapshot);
    expect(reopened.claimed).toBe(false);
    expect(reopened.record.phase).toBe('declined');
  });

  it('keeps different roots and later operations separate from late results', async () => {
    const store = createKanbanRecoveryDecisionStorage();
    const old = await store.claim('alpha', snapshot);
    await store.transition('alpha', snapshot, old.record.owner, ['prompting'], 'sending');
    const otherRoot = await store.claim('alpha', anotherRoot);
    const next = await store.claim('alpha', nextOperation);
    expect(otherRoot.claimed).toBe(true);
    expect(next.claimed).toBe(true);
    await store.transition('alpha', snapshot, old.record.owner, ['sending'], 'confirmed');
    expect((await store.read(anotherRoot))?.phase).toBe('prompting');
    expect((await store.read(nextOperation))?.owner).toBe(next.record.owner);
  });

  it('never treats an absent marker, different snapshot or unowned claim as confirmed', async () => {
    const store = createKanbanRecoveryDecisionStorage();
    const claim = await store.claim('alpha', snapshot);
    const changed = { ...snapshot, snapshotHash: 'd'.repeat(64) };
    expect(store.matches(claim.record, 'alpha', changed)).toBe(false);
    await expect(
      store.transition('alpha', changed, claim.record.owner, ['prompting'], 'confirmed')
    ).rejects.toThrow(/changed/);
    await expect(
      store.transition('alpha', snapshot, 'bad-owner', ['prompting'], 'confirmed')
    ).rejects.toThrow(/changed/);
    expect((await store.read(snapshot))?.phase).toBe('prompting');
  });

  it('fails closed on unreadable or unavailable storage without retrying', async () => {
    await set(kanbanRecoveryDecisionKey(snapshot), { version: 42 });
    await expect(createKanbanRecoveryDecisionStorage().claim('alpha', snapshot)).rejects.toThrow(
      /unreadable/
    );
    const update = vi.fn(async () => {
      throw new Error('storage unavailable');
    });
    const unavailable = createKanbanRecoveryDecisionStorage({ get: vi.fn(), update });
    await expect(unavailable.claim('alpha', anotherRoot)).rejects.toThrow('storage unavailable');
    expect(update).toHaveBeenCalledOnce();
  });
});
