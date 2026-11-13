/**
 * Machine-local registry bootstrap: a registry running on this very machine can
 * mint an agent token for the caller, so the connect dialog offers "Get token"
 * instead of sending the user hunting for one in YouTrack.
 *
 * The visibility rule and the request rule must agree, so one predicate serves
 * both: the renderer only shows the action for a loopback endpoint, and the main
 * process refuses anything else before a request is made.
 */
const LOOPBACK_HOSTS: Record<string, true> = {
  '127.0.0.1': true,
  localhost: true,
  // WHATWG URL keeps the IPv6 brackets in `hostname`.
  '[::1]': true,
};

/** True when the endpoint's host is this machine (invalid URLs are not). */
export function isLoopbackSpecRegistryEndpoint(rawUrl: string | null | undefined): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') return false;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS[parsed.hostname.toLowerCase()] === true;
}

/**
 * The bootstrap route sits beside `/mcp` on the same origin: the endpoint the
 * user configured is the MCP URL, so the trailing `/mcp` is dropped first.
 */
export function specRegistryLocalTokenUrl(rawUrl: string): string | null {
  if (!isLoopbackSpecRegistryEndpoint(rawUrl)) return null;
  const parsed = new URL(rawUrl.trim());
  let path = parsed.pathname;
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  if (path === '/') path = '';
  if (path.endsWith('/mcp')) path = path.slice(0, -'/mcp'.length);
  parsed.pathname = `${path}/local/token`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}
