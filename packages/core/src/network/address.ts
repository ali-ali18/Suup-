// Owns the question "is this IP address one the bot machine may ever reach?". The answer is
// numeric: the address is parsed by the platform and compared with CIDR ranges (`net.BlockList`),
// never matched as text. A name is never judged here (a name is judged by the allowlist, and the
// address it resolves to is judged here, after resolving).
import { BlockList, isIP } from "node:net";

/** The ranges that are never reachable from a bot: not private networks, not loopback, not the cloud metadata. */
const FORBIDDEN: readonly (readonly [string, number, "ipv4" | "ipv6"])[] = [
  ["0.0.0.0", 8, "ipv4"], // "this" network, the unspecified address
  ["10.0.0.0", 8, "ipv4"], // private
  ["100.64.0.0", 10, "ipv4"], // shared address space (carrier NAT; some clouds put metadata here)
  ["127.0.0.0", 8, "ipv4"], // loopback
  ["169.254.0.0", 16, "ipv4"], // link-local, includes the metadata address 169.254.169.254
  ["172.16.0.0", 12, "ipv4"], // private (Docker bridges live here)
  ["192.0.0.0", 24, "ipv4"], // IETF protocol assignments
  ["192.0.2.0", 24, "ipv4"], // documentation
  ["192.88.99.0", 24, "ipv4"], // 6to4 relay (deprecated)
  ["192.168.0.0", 16, "ipv4"], // private
  ["198.18.0.0", 15, "ipv4"], // benchmarking
  ["198.51.100.0", 24, "ipv4"], // documentation
  ["203.0.113.0", 24, "ipv4"], // documentation
  ["224.0.0.0", 4, "ipv4"], // multicast
  ["240.0.0.0", 4, "ipv4"], // reserved, includes the broadcast address
  ["::", 128, "ipv6"], // unspecified
  ["::1", 128, "ipv6"], // loopback
  ["::ffff:0:0", 96, "ipv6"], // IPv4-mapped: refused whole, the IPv4 form is the one to use
  ["64:ff9b::", 96, "ipv6"], // NAT64: embeds an IPv4 address
  ["100::", 64, "ipv6"], // discard-only
  ["2001::", 32, "ipv6"], // Teredo: embeds an IPv4 address
  ["2001:db8::", 32, "ipv6"], // documentation
  ["2002::", 16, "ipv6"], // 6to4: embeds an IPv4 address
  ["fc00::", 7, "ipv6"], // unique local (includes fd00:ec2::254, the metadata address)
  ["fe80::", 10, "ipv6"], // link-local
  ["fec0::", 10, "ipv6"], // site-local (deprecated)
  ["ff00::", 8, "ipv6"], // multicast
];

// One list per family: a list that holds IPv6 ranges also answers for IPv4 as if mapped.
const forbidden4 = new BlockList();
const forbidden6 = new BlockList();
for (const [network, prefix, family] of FORBIDDEN) {
  (family === "ipv4" ? forbidden4 : forbidden6).addSubnet(network, prefix, family);
}

export type AddressFamily = "ipv4" | "ipv6";

/** `4`, `6`, or `0` when the text is not an IP address in the platform's strict syntax. */
export function ipVersion(text: string): 0 | 4 | 6 {
  const version = isIP(text);
  return version === 4 || version === 6 ? version : 0;
}

/**
 * Whether the numeric address is in a range a bot may never reach. An address that is not a
 * valid IP (the platform could not parse it) counts as forbidden: the safe side.
 */
export function isForbiddenAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 0) return true;
  return version === 4 ? forbidden4.check(address, "ipv4") : forbidden6.check(address, "ipv6");
}
