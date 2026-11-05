import 'fake-indexeddb/auto';

import {
  composerDraftAddressKey,
  composerRecoveryIndexKey,
  composerRecoveryKey,
  composerWorkingIndexKey,
} from '@renderer/utils/composerDraftIdentity';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { composerDatabase } from './composerDatabase';
import { composerDraftGet, composerDraftReadwrite } from './composerDraftIndexedDb';
import { IndexedDbComposerDraftRepository } from './composerDraftRepository';

import type {
  ComposerDraftAddress,
  ComposerDraftContent,
  ComposerWorkingRecord,
} from '@renderer/types/composerDraft';

const address: ComposerDraftAddress = {
  contextId: 'TEST-local',
  teamName: 'TEST-team',
  target: { kind: 'direct', participant: 'alice' },
};
const content = (text: string): ComposerDraftContent => ({
  text,
  chips: [],
  attachments: [],
  actionMode: 'delegate',
});
const key = composerDraftAddressKey(address);
const workingIndex = composerWorkingIndexKey(address.contextId, address.teamName);
const recoveryIndex = composerRecoveryIndexKey(address.contextId, address.teamName);

beforeEach(async () => {
  await composerDatabase.reopen();
  await composerDraftReadwrite(async (store) => {
    store.clear();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

async function loseDurability(
  repository: IndexedDbComposerDraftRepository,
  revision = '0',
  next = 'memory'
): Promise<void> {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  // РИСК: имитируется исчерпание квоты, а не исходный физический отказ базы Chromium.
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function () {
    throw new DOMException('TEST-quota', 'QuotaExceededError');
  });
  try {
    expect(
      await repository.saveWorking(address, revision, next, content('TEST-memory'), {
        kind: 'plain',
      })
    ).toMatchObject({ kind: 'saved', status: 'memory-only' });
    expect(warn).toHaveBeenCalled();
  } finally {
    put.mockRestore();
    warn.mockClear();
  }
}

async function durable(
  repository: IndexedDbComposerDraftRepository,
  revision = 'base'
): Promise<ComposerWorkingRecord> {
  await repository.saveWorking(address, '0', revision, content('TEST-durable'), { kind: 'plain' });
  return (await repository.loadWorking(address)).working;
}

describe('explicit composer durability recovery', () => {
  it('persists current memory text and index after reconnect, then permits the next revision', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await loseDurability(repository);
    expect(await composerDraftGet(key)).toBeUndefined();
    await repository.saveWorking(address, 'memory', 'newer', content('TEST-newer'), {
      kind: 'plain',
    });
    const changed = vi.fn();
    repository.subscribe(changed);
    expect(await repository.retryPersistence(address.contextId, address.teamName)).toBe(true);
    expect(await composerDraftGet(key)).toMatchObject({
      workingRevision: 'newer',
      content: content('TEST-newer'),
    });
    expect(await composerDraftGet(workingIndex)).toMatchObject({
      summaries: [{ workingRevision: 'newer' }],
    });
    const loaded = await repository.loadWorking(address);
    expect(loaded.status).toBe('durable');
    expect(loaded.readError).toBeUndefined();
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'working' }));
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'working-index' }));
    expect(
      await repository.saveWorking(address, 'newer', 'next', content('TEST-next'), {
        kind: 'plain',
      })
    ).toMatchObject({ kind: 'saved', status: 'durable' });
  });

  it('leaves both versions and all indexes untouched when durable content changed elsewhere', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    const base = await durable(repository);
    await loseDurability(repository, 'base');
    const external = { ...base, workingRevision: 'external', content: content('TEST-external') };
    await composerDraftReadwrite(async (store) => {
      store.put(external, key);
    });
    const indexes = [await composerDraftGet(workingIndex), await composerDraftGet(recoveryIndex)];
    expect(await repository.retryPersistence(address.contextId, address.teamName)).toBe(false);
    expect(await composerDraftGet(key)).toEqual(external);
    expect([await composerDraftGet(workingIndex), await composerDraftGet(recoveryIndex)]).toEqual(
      indexes
    );
    expect(await repository.loadWorking(address)).toMatchObject({
      status: 'memory-only',
      working: { content: content('TEST-memory') },
    });
  });

  it('does not overwrite an unread draft when the initial database open failed', async () => {
    const seed = new IndexedDbComposerDraftRepository();
    const saved = await durable(seed);
    composerDatabase.close();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new DOMException('Internal error.', 'UnknownError');
    });
    const repository = new IndexedDbComposerDraftRepository();
    expect((await repository.loadWorking(address)).status).toBe('memory-only');
    await repository.saveWorking(address, '0', 'local', content('TEST-local'), { kind: 'plain' });
    expect(await repository.retryPersistence(address.contextId, address.teamName)).toBe(false);
    expect(await composerDraftGet(key)).toEqual(saved);
    expect((await repository.loadWorking(address)).working.content?.text).toBe('TEST-local');
    warn.mockClear();
  });

  it('removes a discarded working record and its summary together, preserving unrelated durable records', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await durable(repository);
    await loseDurability(repository, 'base');
    expect(await repository.discardWorking(address, 'memory')).toBe('discarded');
    const otherAddress = { ...address, target: { kind: 'direct' as const, participant: 'bob' } };
    const other = new IndexedDbComposerDraftRepository();
    await other.saveWorking(otherAddress, '0', 'other', content('TEST-other'), { kind: 'plain' });
    expect(await repository.retryPersistence(address.contextId, address.teamName)).toBe(true);
    expect(await composerDraftGet(key)).toBeUndefined();
    expect(await composerDraftGet(workingIndex)).toMatchObject({
      summaries: [{ workingRevision: 'other' }],
    });
  });

  it('persists unknown delivery evidence without dispatching or allowing recovery during an active send', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await loseDurability(repository);
    const attemptId = 'TEST-unknown';
    const snapshot = { content: content('TEST-memory'), editorContext: { kind: 'plain' as const } };
    await repository.beginAttempt(address, 'memory', {
      attemptId,
      snapshot,
      createdAt: 1,
      preparedRequest: {
        kind: 'local',
        teamName: address.teamName,
        request: { member: 'alice', text: 'TEST-memory' },
      },
    });
    repository.setAttemptActive(attemptId, true, address);
    const reopen = vi.spyOn(composerDatabase, 'reopen');
    expect(await repository.retryPersistence(address.contextId, address.teamName)).toBe(false);
    expect(reopen).not.toHaveBeenCalled();
    await repository.settleAttempt(address, attemptId, {
      kind: 'unconfirmed',
      messageId: 'TEST-message',
    });
    repository.setAttemptActive(attemptId, false, address);
    expect(await repository.retryPersistence(address.contextId, address.teamName)).toBe(true);
    expect(await composerDraftGet(composerRecoveryKey(address, attemptId))).toMatchObject({
      reason: 'unconfirmed-send',
      outcome: { kind: 'unconfirmed', messageId: 'TEST-message' },
      snapshot,
    });
    expect(await composerDraftGet(key)).toMatchObject({ content: null });
  });

  it('serializes recovery with newer edits and does not overwrite unchanged cached drafts', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await durable(repository);
    const otherAddress = { ...address, target: { kind: 'direct' as const, participant: 'bob' } };
    await repository.saveWorking(otherAddress, '0', 'cached', content('TEST-cached'), {
      kind: 'plain',
    });
    await loseDurability(repository, 'base');
    const other = new IndexedDbComposerDraftRepository();
    await other.saveWorking(otherAddress, 'cached', 'external', content('TEST-external'), {
      kind: 'plain',
    });
    const reopen = composerDatabase.reopen.bind(composerDatabase);
    let release!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(composerDatabase, 'reopen').mockImplementationOnce(async () => {
      started();
      await gate;
      await reopen();
    });
    const retry = repository.retryPersistence(address.contextId, address.teamName);
    await entered;
    const newer = repository.saveWorking(address, 'memory', 'newer', content('TEST-newer'), {
      kind: 'plain',
    });
    release();
    expect(await retry).toBe(true);
    expect(await newer).toMatchObject({ kind: 'saved', status: 'durable' });
    expect(await composerDraftGet(key)).toMatchObject({ workingRevision: 'newer' });
    expect((await repository.loadWorking(otherAddress)).working).toMatchObject({
      workingRevision: 'external',
    });
  });

  it('clears the recovery baseline when the namespace is discarded', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await durable(repository);
    await loseDurability(repository, 'base');
    expect(await repository.discardNamespace(address.contextId, address.teamName)).toBe(
      'discarded'
    );
    await loseDurability(repository, '0', 'new-session');
    expect(await repository.retryPersistence(address.contextId, address.teamName)).toBe(true);
    expect(await composerDraftGet(key)).toMatchObject({ workingRevision: 'new-session' });
  });

  it('keeps memory text and retries explicit recovery after a persistent open failure', async () => {
    const repository = new IndexedDbComposerDraftRepository();
    await loseDurability(repository);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => {
      throw new DOMException('TEST-unavailable', 'UnknownError');
    });
    await expect(
      repository.retryPersistence(address.contextId, address.teamName)
    ).rejects.toMatchObject({ stage: 'open' });
    expect((await repository.loadWorking(address)).status).toBe('memory-only');
    expect(await repository.retryPersistence(address.contextId, address.teamName)).toBe(true);
    expect((await repository.loadWorking(address)).working.content?.text).toBe('TEST-memory');
    warn.mockClear();
  });
});
