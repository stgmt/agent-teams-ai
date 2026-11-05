import { composerDatabase } from './composerDatabase';

export function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

export function composerDraftEntriesByPrefix(
  store: IDBObjectStore,
  prefix: string
): Promise<(readonly [string, unknown])[]> {
  return new Promise((resolve, reject) => {
    const entries: (readonly [string, unknown])[] = [];
    const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}￿`));
    request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(entries);
        return;
      }
      if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix))
        entries.push([cursor.key, cursor.value]);
      cursor.continue();
    };
  });
}

export function composerDraftGet<T>(key: IDBValidKey): Promise<T | undefined> {
  return composerDatabase.transaction(
    'readonly',
    (store) => requestValue<unknown>(store.get(key)) as Promise<T | undefined>
  );
}

export function composerDraftReadwrite<T>(
  operation: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  return composerDatabase.transaction('readwrite', operation);
}
