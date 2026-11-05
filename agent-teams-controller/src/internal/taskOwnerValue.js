/**
 * Owner value normalization shared by the file store, the registry backend and
 * its HTTP client.
 *
 * `null`, `'clear'` and `'none'` are the callers' way of saying "unassign";
 * an empty or whitespace-only string means the same. Anything else is a member
 * name with surrounding whitespace removed.
 */
function normalizeOwnerValue(owner) {
  if (owner == null || owner === 'clear' || owner === 'none') {
    return undefined;
  }
  const normalized = String(owner).trim();
  return normalized ? normalized : undefined;
}

module.exports = { normalizeOwnerValue };
