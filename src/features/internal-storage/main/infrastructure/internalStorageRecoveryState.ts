import * as fs from 'node:fs';
import * as path from 'node:path';

export const INTERNAL_STORAGE_RECOVERY_REQUIRED = 'INTERNAL_STORAGE_RECOVERY_REQUIRED';

export class InternalStorageRecoveryRequiredError extends Error {
  readonly code = INTERNAL_STORAGE_RECOVERY_REQUIRED;
}

export function isInternalStorageRecoveryRequiredError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === INTERNAL_STORAGE_RECOVERY_REQUIRED
  );
}

export interface InternalStorageRecoveryDetails {
  kind: 'damaged' | 'interrupted';
  storageDirectory: string;
  markerPath: string;
  interruptedMarkerPath: string;
}

function markerExists(markerPath: string): boolean {
  try {
    fs.lstatSync(markerPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Read only: also works before the worker or database can be opened. */
export function getInternalStorageRecoveryDetails(
  databasePath: string
): InternalStorageRecoveryDetails | null {
  const resolvedPath = path.resolve(databasePath);
  const markerPath = `${resolvedPath}.templates-recovery-required`;
  const interruptedMarkerPath = `${resolvedPath}.recovery-in-progress`;
  const interrupted = markerExists(interruptedMarkerPath);
  if (!interrupted && !markerExists(markerPath)) return null;
  return {
    kind: interrupted ? 'interrupted' : 'damaged',
    storageDirectory: path.dirname(resolvedPath),
    markerPath,
    interruptedMarkerPath,
  };
}
