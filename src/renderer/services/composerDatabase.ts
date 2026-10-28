export type ComposerStorageStage = 'open' | 'operation' | 'commit';

export class ComposerStorageError extends Error {
  readonly causeName: string;
  readonly correlationId = crypto.randomUUID();

  constructor(
    readonly stage: ComposerStorageStage,
    cause: unknown
  ) {
    const causeName =
      cause instanceof Error || cause instanceof DOMException ? cause.name : 'UnknownError';
    super(`Composer storage ${stage} failed (${causeName}).`, { cause });
    this.name = 'ComposerStorageError';
    this.causeName = causeName;
    // Never include draft text, keys, paths, or the underlying exception message.
    console.warn('[composer-storage]', { stage, causeName, correlationId: this.correlationId });
  }
}

/** One connection owner for composer drafts, recovery records, and the manual queue. */
export class ComposerDatabase {
  private opening: Promise<IDBDatabase> | null = null;
  private connection: IDBDatabase | null = null;
  private reopening: Promise<void> | null = null;
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly name = 'keyval-store') {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private open(): Promise<IDBDatabase> {
    const generation = this.generation;
    this.opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(this.name);
      } catch (cause) {
        reject(new ComposerStorageError('open', cause));
        return;
      }
      request.onupgradeneeded = () => request.result.createObjectStore('keyval');
      request.onerror = () => reject(new ComposerStorageError('open', request.error));
      request.onsuccess = () => {
        const connection = request.result;
        if (generation !== this.generation) {
          connection.close();
          reject(
            new ComposerStorageError('open', new DOMException('Connection closed.', 'AbortError'))
          );
          return;
        }
        this.connection = connection;
        connection.onversionchange = connection.onclose = () => {
          if (this.connection === connection) this.close();
        };
        resolve(connection);
      };
    });
    return this.opening;
  }

  close(): void {
    this.generation += 1;
    const connection = this.connection;
    this.connection = null;
    this.opening = null;
    connection?.close();
  }

  reopen(): Promise<void> {
    // Reopening never replays a transaction or dispatches a message.
    this.reopening ??= (async () => {
      await this.opening?.catch(() => undefined);
      this.close();
      await this.open();
      for (const listener of this.listeners) listener();
    })().finally(() => {
      this.reopening = null;
    });
    return this.reopening;
  }

  async transaction<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => Promise<T>
  ): Promise<T> {
    const db = await this.open();
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction('keyval', mode);
    } catch (cause) {
      throw new ComposerStorageError('operation', cause);
    }
    const completion = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(transaction.error ?? new DOMException('Transaction aborted.', 'AbortError'));
    });
    void completion.catch(() => undefined);
    let result: T;
    try {
      result = await operation(transaction.objectStore('keyval'));
    } catch (cause) {
      try {
        transaction.abort();
      } catch {
        /* Already terminal. */
      }
      await completion.catch(() => undefined);
      throw cause instanceof DOMException ? new ComposerStorageError('operation', cause) : cause;
    }
    try {
      await completion;
    } catch (cause) {
      throw new ComposerStorageError('commit', cause);
    }
    return result;
  }
}

export const composerDatabase = new ComposerDatabase();
