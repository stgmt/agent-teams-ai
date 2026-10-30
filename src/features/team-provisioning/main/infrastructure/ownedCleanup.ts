/** Shares an owned cleanup attempt; only success is permanent, failure retains the same owner. */
export function ownedCleanup(cleanup: () => Promise<void>): () => Promise<void> {
  let released = false;
  let pending: Promise<void> | null = null;
  return () => {
    if (released) return Promise.resolve();
    pending ??= Promise.resolve()
      .then(cleanup)
      .then(() => {
        released = true;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
}
