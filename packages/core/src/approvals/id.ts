// Owns the identity of an approval: derived from the run and the call, so it is the same on every
// attempt (a resumed run, a replay) and the database row can be created idempotently.

const MASK = (1n << 64n) - 1n;

function fnv64(text: string, offset: bigint): bigint {
  let hash = offset;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & MASK;
  }
  return hash;
}

/** A stable UUID (version 8 layout) for the approval of one call of one run. Not a secret. */
export function approvalIdFor(runId: string, callId: string): string {
  const text = `${runId}\u0000${callId}`;
  const high = fnv64(text, 0xcbf29ce484222325n);
  const low = fnv64(text, 0x84222325cbf29ce4n);
  const hex = `${high.toString(16).padStart(16, "0")}${low.toString(16).padStart(16, "0")}`;
  const variant = ((parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}
