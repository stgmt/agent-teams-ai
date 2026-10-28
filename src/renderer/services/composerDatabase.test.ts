import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComposerDatabase } from './composerDatabase';

const databases: ComposerDatabase[] = [];
afterEach(() => {
  for (const instance of databases.splice(0)) instance.close();
  vi.restoreAllMocks();
});

function database(): ComposerDatabase {
  const db = new ComposerDatabase(`TEST-composer-${crypto.randomUUID()}`);
  databases.push(db);
  return db;
}

describe('owned composer database connection', () => {
  it('shares one open, reports the failing stage, and only reopens on explicit retry', async () => {
    const db = database();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const open = vi.spyOn(indexedDB, 'open');
    const failure = new DOMException('Internal error.', 'UnknownError');
    open.mockImplementationOnce(() => {
      throw failure;
    });
    const read = (): Promise<string> => db.transaction('readonly', async () => 'TEST');
    const results = await Promise.allSettled([read(), read()]);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected')
        expect(result.reason).toMatchObject({ stage: 'open', causeName: 'UnknownError' });
    }
    await expect(read()).rejects.toMatchObject({ stage: 'open' });
    expect(open).toHaveBeenCalledTimes(1);
    await Promise.all([db.reopen(), db.reopen()]);
    await expect(read()).resolves.toBe('TEST');
    expect(open).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledExactlyOnceWith('[composer-storage]', {
      stage: 'open',
      causeName: 'UnknownError',
      correlationId: expect.any(String) as string,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Internal error.');
    warn.mockClear();
  });

  it('reports an asynchronous commit abort without accepting or replaying the write', async () => {
    const db = database();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const write = vi.fn(async (store: IDBObjectStore) => {
      const request = store.put('TEST-value', 'TEST-key');
      request.onsuccess = () => {
        store.transaction.abort();
      };
    });
    await expect(db.transaction('readwrite', write)).rejects.toMatchObject({
      stage: 'commit',
      causeName: 'AbortError',
    });
    await db.reopen();
    expect(write).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockClear();
  });

  it('does not replay writes on reopen or treat an aborted transaction as committed', async () => {
    const db = database();
    const write = vi.fn(async (store: IDBObjectStore) => {
      store.put('TEST-value', 'TEST-key');
      throw new Error('TEST-refusal');
    });
    await expect(db.transaction('readwrite', write)).rejects.toThrow('TEST-refusal');
    await db.reopen();
    const value = await db.transaction(
      'readonly',
      (store) =>
        new Promise((resolve, reject) => {
          const request = store.get('TEST-key');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error('TEST-read-failed'));
        })
    );
    expect(value).toBeUndefined();
    expect(write).toHaveBeenCalledOnce();
  });
});
