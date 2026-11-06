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
  /** Marker publication failed or its result could not be confirmed. */
  markerWriteFailed?: true;
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

/** Paths for diagnostics, including when the marker itself could not be written. */
export function internalStorageRecoveryPaths(
  databasePath: string
): Omit<InternalStorageRecoveryDetails, 'kind' | 'markerWriteFailed'> {
  const resolvedPath = path.resolve(databasePath);
  return {
    storageDirectory: path.dirname(resolvedPath),
    markerPath: `${resolvedPath}.templates-recovery-required`,
    interruptedMarkerPath: `${resolvedPath}.recovery-in-progress`,
  };
}

/** Read only: also works before the worker or database can be opened. */
export function getInternalStorageRecoveryDetails(
  databasePath: string
): InternalStorageRecoveryDetails | null {
  const paths = internalStorageRecoveryPaths(databasePath);
  const interrupted = markerExists(paths.interruptedMarkerPath);
  if (!interrupted && !markerExists(paths.markerPath)) return null;
  return { kind: interrupted ? 'interrupted' : 'damaged', ...paths };
}

/** Fail closed when a database or its journal exists, or cannot be inspected. */
export function mightHaveInternalStorageFiles(databasePath: string): boolean {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      fs.lstatSync(`${databasePath}${suffix}`);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true;
    }
  }
  return false;
}
