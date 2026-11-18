// Links in the bot's text. A message is output of a model, so a link in it is untrusted input:
// only http(s) and mailto become links; a link that hides its real host behind `user@host` is not a
// link at all; the destination is always shown as the browser will see it (punycode and all).

export interface SafeLink {
  /** The normalised address (what is opened), always ASCII. */
  href: string;
  /** The host as the browser sees it: a lookalike domain shows its `xn--` form. */
  host: string;
  scheme: "http" | "https" | "mailto";
}

function hasControlOrSpace(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Returns the link, or `null` when it must stay as plain text. */
export function parseLink(url: string): SafeLink | null {
  const text = url.trim();
  // Control characters and spaces never belong in an address (and `java\tscript:` tricks start there).
  if (text === "" || hasControlOrSpace(text)) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  switch (parsed.protocol) {
    case "mailto:":
      return { href: parsed.href, host: "", scheme: "mailto" };
    case "http:":
    case "https:":
      // `https://good.example@evil.example/` shows "good.example" and goes to evil.example.
      if (parsed.username !== "" || parsed.password !== "") return null;
      if (parsed.hostname === "") return null;
      return {
        href: parsed.href,
        host: parsed.hostname,
        scheme: parsed.protocol === "https:" ? "https" : "http",
      };
    default:
      return null;
  }
}

/** Alias kept for callers that only need the address. */
export function safeHref(url: string): string | null {
  return parseLink(url)?.href ?? null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * Where the icon of a site would come from: `https://<host>/favicon.ico`, the host ONLY (never a path
 * or a query of the message). Nothing for http, mailto, IP addresses, localhost, `.local` and hosts
 * with no dot (a private name). The caller fetches it only if the person turned the setting on.
 */
export function faviconUrl(link: SafeLink): string | null {
  if (link.scheme !== "https") return null;
  const host = link.host.toLowerCase();
  if (host === "" || host.length > 253) return null;
  if (IPV4.test(host) || host.includes(":") || host.startsWith("[")) return null;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return null;
  if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host)) return null;
  return `https://${host}/favicon.ico`;
}
