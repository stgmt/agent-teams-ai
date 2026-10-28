import 'fake-indexeddb/auto';

import { describe, expect, it } from 'vitest';

import { composerDraftGet, composerDraftReadwrite } from './composerDraftIndexedDb';

describe('composer IndexedDB transaction boundary', () => {
  it('aborts writes when the operation fails and preserves the original application error', async () => {
    const key = `TEST-${crypto.randomUUID()}`;
    const failure = new Error('TEST-refusal');
    await expect(
      composerDraftReadwrite(async (store) => {
        store.put('TEST-uncommitted', key);
        throw failure;
      })
    ).rejects.toBe(failure);
    expect(await composerDraftGet(key)).toBeUndefined();
  });

  it('returns only after the atomic write is committed', async () => {
    const key = `TEST-${crypto.randomUUID()}`;
    await composerDraftReadwrite(async (store) => {
      store.put('TEST-committed', key);
    });
    expect(await composerDraftGet(key)).toBe('TEST-committed');
  });
});
