/**
 * Narrowing helpers for the registry wire boundary. They live in one module so
 * the transport and the client check external data the same way instead of
 * growing per-file variants.
 */

/** An object from parsed JSON; arrays and `null` are not records. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Scalar reads used by many call sites; non-strings become `null`, never `''`. */
export function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
