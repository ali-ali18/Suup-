/**
 * Whether a connect or authorization link may be drawn as the button of a card: https, no login in
 * it, and its host EXACTLY one of `hosts` (the connector's declared hosts). The server checks the
 * same before the card exists; the app checks again, so a card never opens a page the connector does
 * not declare. The address is parsed with `URL`, never read from a text (docs/REGRAS.md §1).
 */
export function linkAllowed(
  url: string,
  hosts: readonly string[],
  /** The first path segment the service's links all start with (Composio: `link`), if it has one. */
  firstSegment?: string | null,
): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      hosts.includes(parsed.hostname) &&
      (firstSegment === undefined ||
        firstSegment === null ||
        parsed.pathname.split("/")[1] === firstSegment)
    );
  } catch {
    return false;
  }
}

/** Whether a link given with an end time has passed it (no end time: it has not). */
export function linkExpired(expiresAt: string | undefined, now: number): boolean {
  if (expiresAt === undefined) return false;
  const end = Date.parse(expiresAt);
  return !Number.isNaN(end) && end <= now;
}
