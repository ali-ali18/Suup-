// Owns resolving a host name ONCE and validating what it resolved to. The proxy connects to the
// address returned here, never to the name again, so a DNS answer that changes between the check
// and the connection (DNS rebinding) cannot send the connection somewhere else.
import { lookup } from "node:dns/promises";
import { isForbiddenAddress } from "@suup/core";

export interface Resolver {
  /** Every address of the name (numeric text). */
  resolve(host: string): Promise<string[]>;
}

export const systemResolver: Resolver = {
  async resolve(host) {
    const found = await lookup(host, { all: true, verbatim: true });
    return found.map((entry) => entry.address);
  },
};

export type Resolution =
  | {
      ok: true;
      address: string;
      /** Every address of the answer, in order (all checked; `address` is the first). */
      addresses: string[];
    }
  | {
      ok: false;
      reason: "dns_failed" | "forbidden_address";
      message: string;
      /** The resolver's error code when it threw (`ENOTFOUND`, `EAI_AGAIN`...), for diagnostics. */
      code?: string;
    };

/**
 * One answer to connect to. If ANY address of the answer is in a forbidden range the whole name is
 * refused (a mixed answer is how rebinding tricks are built), and so is a name that resolves to
 * nothing.
 */
export async function resolveForConnect(host: string, resolver: Resolver): Promise<Resolution> {
  let addresses: string[];
  try {
    addresses = await resolver.resolve(host);
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    return {
      ok: false,
      reason: "dns_failed",
      message: `host ${host} could not be resolved`,
      ...(typeof code === "string" ? { code } : {}),
    };
  }
  const first = addresses[0];
  if (first === undefined) {
    return { ok: false, reason: "dns_failed", message: `host ${host} could not be resolved` };
  }
  for (const address of addresses) {
    if (isForbiddenAddress(address)) {
      return {
        ok: false,
        reason: "forbidden_address",
        message: `host ${host} resolves to an address that is never reachable (private, loopback, link-local or metadata)`,
      };
    }
  }
  return { ok: true, address: first, addresses };
}
