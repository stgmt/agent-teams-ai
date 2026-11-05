import { OwnedRuntimeCleanupError } from '../../core/application/OwnedRuntimeCleanupError';

import { ownedCleanup } from './ownedCleanup';

/** Rejects setup without dropping either an inner cleanup owner or this layer's resources. */
export async function rejectAfterOwnedCleanup(
  cause: unknown,
  cleanup: () => Promise<void>
): Promise<never> {
  const release = ownedCleanup(async () => {
    const results = await Promise.allSettled([
      Promise.resolve().then(cleanup),
      cause instanceof OwnedRuntimeCleanupError
        ? Promise.resolve().then(() => cause.release())
        : Promise.resolve(),
    ]);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason as unknown] : []
    );
    if (errors.length) throw new AggregateError(errors, 'Owned launch setup cleanup failed');
  });
  try {
    await release();
  } catch (error) {
    throw new OwnedRuntimeCleanupError(
      new AggregateError([cause, error], 'Launch setup failed'),
      release
    );
  }
  throw cause instanceof OwnedRuntimeCleanupError ? cause.cause : cause;
}
