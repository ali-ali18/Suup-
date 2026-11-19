// Owns what a host NAME is for the network allowlist: how it is normalised and when it is a
// well-formed name at all. Comparison with the allowlist is EXACT EQUALITY of the normalised
// text: no wildcard, no suffix, no pattern. Everything here reads a fixed grammar (RFC 1035
// labels), character by character; it never guesses what a name "means".
import { domainToASCII } from "node:url";
import { ipVersion } from "./address.js";

export const MAX_HOST_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

function isLabelChar(code: number): boolean {
  return (
    (code >= 0x61 && code <= 0x7a) || // a-z
    (code >= 0x30 && code <= 0x39) || // 0-9
    code === 0x2d // -
  );
}

function isLetter(code: number): boolean {
  return code >= 0x61 && code <= 0x7a;
}

export type HostProblem =
  | "empty"
  | "ip_literal"
  | "too_long"
  | "bad_character"
  | "bad_label"
  | "single_label"
  | "bad_top_level";

export type NormalizedHost =
  | { kind: "name"; name: string }
  | { kind: "ip"; address: string }
  | { kind: "invalid"; problem: HostProblem };

/** Lower case, one trailing dot dropped, brackets of an IPv6 literal dropped. Nothing else. */
function stripForm(raw: string): string {
  let text = raw.trim().toLowerCase();
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  else if (text.endsWith(".")) text = text.slice(0, -1);
  return text;
}

/**
 * Normalises a host as written (a request target, an allowlist entry) and says what it is: a
 * well-formed DNS name, an IP literal, or invalid. Internationalised names are accepted in their
 * punycode form (what the platform's IDNA conversion gives); the name that is compared is always
 * the ASCII form.
 *
 * A name needs at least two labels and a top-level label with a letter in it. That is what keeps
 * `localhost`, `intranet` and every spelling of an IPv4 address that is not four plain decimal
 * numbers (`127.1`, `0x7f.1`, `2130706433`, `017700000001`) from being taken for a name: a
 * resolver would read some of them as an address.
 */
export function normalizeHost(raw: string): NormalizedHost {
  const text = stripForm(raw);
  if (text === "") return { kind: "invalid", problem: "empty" };
  if (ipVersion(text) !== 0) return { kind: "ip", address: text };
  const name = text.includes(":") ? text : domainToASCII(text);
  if (name === "") return { kind: "invalid", problem: "bad_character" };
  if (name.length > MAX_HOST_LENGTH) return { kind: "invalid", problem: "too_long" };
  const labels = name.split(".");
  if (labels.length < 2) return { kind: "invalid", problem: "single_label" };
  for (const label of labels) {
    if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
      return { kind: "invalid", problem: "bad_label" };
    }
    if (label.startsWith("-") || label.endsWith("-")) {
      return { kind: "invalid", problem: "bad_label" };
    }
    for (let i = 0; i < label.length; i++) {
      if (!isLabelChar(label.charCodeAt(i))) return { kind: "invalid", problem: "bad_character" };
    }
  }
  const top = labels[labels.length - 1] as string;
  let hasLetter = false;
  for (let i = 0; i < top.length; i++) if (isLetter(top.charCodeAt(i))) hasLetter = true;
  if (!hasLetter) return { kind: "invalid", problem: "bad_top_level" };
  return { kind: "name", name };
}

const PROBLEM_TEXT: Readonly<Record<HostProblem, string>> = {
  empty: "is empty",
  ip_literal: "is an IP address: use the host name",
  too_long: "is too long for a host name",
  bad_character: "has a character a host name cannot have",
  bad_label: "has an empty, too long or hyphen-edged label",
  single_label: "is a single label (like localhost): use a full host name such as example.com",
  bad_top_level: "does not end in a name (like 127.1 or 2130706433)",
};

export function describeHostProblem(problem: HostProblem): string {
  return PROBLEM_TEXT[problem];
}

/**
 * The name to store in an allowlist, or the reason it cannot be one. An IP literal is a
 * reason of its own: addresses are never allowed by the user, only names.
 */
export function parseAllowlistHost(
  raw: string,
): { ok: true; host: string } | { ok: false; message: string } {
  const normalized = normalizeHost(raw);
  if (normalized.kind === "name") return { ok: true, host: normalized.name };
  const problem: HostProblem = normalized.kind === "ip" ? "ip_literal" : normalized.problem;
  return {
    ok: false,
    message: `"${raw.length > 80 ? `${raw.slice(0, 80)}…` : raw}" ${describeHostProblem(problem)}`,
  };
}
