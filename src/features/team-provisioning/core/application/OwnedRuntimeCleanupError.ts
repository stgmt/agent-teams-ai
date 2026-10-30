/** Preserves exact pre-spawn resource ownership when setup cannot finish releasing it. */
export class OwnedRuntimeCleanupError extends Error {
  constructor(
    cause: unknown,
    readonly release: () => Promise<void>
  ) {
    super('Owned runtime setup resources were not released', { cause });
    this.name = 'OwnedRuntimeCleanupError';
  }
}
