import { networkInterfaces } from 'node:os';

/** IPv4-mapped IPv6 peers (`::ffff:a.b.c.d`) are the same host; compare the IPv4 part. */
const IPV4_MAPPED_PREFIX = '::ffff:';

/**
 * The host binds loopback only, so a peer must be one of this machine's own
 * internal interface addresses (IPv4 and IPv6 loopback), never a configured value.
 */
const LOOPBACK_INTERFACE_ADDRESSES: ReadonlySet<string> = new Set(
  Object.values(networkInterfaces())
    .flat()
    .flatMap((entry) => (entry?.internal ? [entry.address] : []))
);

export function isLoopbackPeerAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const address = remoteAddress.startsWith(IPV4_MAPPED_PREFIX)
    ? remoteAddress.slice(IPV4_MAPPED_PREFIX.length)
    : remoteAddress;
  return LOOPBACK_INTERFACE_ADDRESSES.has(address);
}
