/**
 * Task identity helpers shared by the file and registry backends.
 *
 * Canonical identity is always `id`; `displayId` is only a short label for
 * humans and logs, so both backends derive it the same way when the store does
 * not provide one.
 */

const UUID_TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REGISTRY_TASK_ID_PATTERN = /^registry-[0-9a-f]{64}$/i;

function looksLikeCanonicalTaskId(taskId) {
  const normalized = String(taskId || '').trim();
  return UUID_TASK_ID_PATTERN.test(normalized) || REGISTRY_TASK_ID_PATTERN.test(normalized);
}

function deriveDisplayId(taskId) {
  const normalized = String(taskId || '').trim();
  if (!normalized) return normalized;
  if (REGISTRY_TASK_ID_PATTERN.test(normalized)) {
    return normalized.slice('registry-'.length, 'registry-'.length + 12).toLowerCase();
  }
  return UUID_TASK_ID_PATTERN.test(normalized) ? normalized.slice(0, 8).toLowerCase() : normalized;
}

module.exports = {
  REGISTRY_TASK_ID_PATTERN,
  UUID_TASK_ID_PATTERN,
  deriveDisplayId,
  looksLikeCanonicalTaskId,
};

