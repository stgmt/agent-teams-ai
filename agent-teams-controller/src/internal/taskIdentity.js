/**
 * Task identity helpers shared by the file and registry backends.
 *
 * Canonical identity is always `id`; `displayId` is only a short label for
 * humans and logs, so both backends derive it the same way when the store does
 * not provide one.
 */

const UUID_TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function looksLikeCanonicalTaskId(taskId) {
  return UUID_TASK_ID_PATTERN.test(String(taskId || '').trim());
}

function deriveDisplayId(taskId) {
  const normalized = String(taskId || '').trim();
  if (!normalized) return normalized;
  return looksLikeCanonicalTaskId(normalized) ? normalized.slice(0, 8).toLowerCase() : normalized;
}

module.exports = {
  UUID_TASK_ID_PATTERN,
  deriveDisplayId,
  looksLikeCanonicalTaskId,
};
