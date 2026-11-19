// The exact content of an approval card, as the screen draws it: every argument of the call, in the
// order the server sends them, and a secret only as its placeholder `{{secret:NAME}}` (the card never
// has a value: the server sends the placeholder, and this file only recognises it, to draw a seal).
// Pure functions, table-tested.

export type Segment = { kind: "text"; text: string } | { kind: "secret"; name: string };

export interface ArgField {
  /** The name of the argument (`command`, `path`...); `null` when the arguments are not an object. */
  key: string | null;
  /** The text as sent: a string as it is, anything else as indented JSON. */
  text: string;
  /** Whether the value was a string (drawn as it is) or something else (drawn as JSON). */
  json: boolean;
  lines: number;
  /** More than the collapsed card shows. */
  long: boolean;
  /** The names of the secrets the text uses. */
  secrets: string[];
}

const PLACEHOLDER = /\{\{secret:([A-Z][A-Z0-9_]{0,63})\}\}/g;

/** Splits a text into plain stretches and secret placeholders (kept apart, in order). */
export function splitSecrets(text: string): Segment[] {
  const segments: Segment[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > last) segments.push({ kind: "text", text: text.slice(last, index) });
    segments.push({ kind: "secret", name: match[1] as string });
    last = index + match[0].length;
  }
  if (last < text.length) segments.push({ kind: "text", text: text.slice(last) });
  return segments;
}

/** What a collapsed field still shows. */
export const COLLAPSED_LINES = 8;
export const COLLAPSED_CHARS = 600;

const lineCount = (text: string): number => (text === "" ? 1 : text.split("\n").length);

export function isLong(text: string): boolean {
  return lineCount(text) > COLLAPSED_LINES || text.length > COLLAPSED_CHARS;
}

/**
 * The start of a long text: the first lines, at most `COLLAPSED_CHARS` characters, never cutting a
 * secret placeholder in half (a cut inside one is moved to the end of the placeholder).
 */
export function collapsedText(text: string): { head: string; hiddenLines: number } {
  if (!isLong(text)) return { head: text, hiddenLines: 0 };
  let head = text.split("\n").slice(0, COLLAPSED_LINES).join("\n");
  if (head.length > COLLAPSED_CHARS) {
    let cut = COLLAPSED_CHARS;
    for (const match of text.matchAll(PLACEHOLDER)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (start < cut && cut < end) cut = end;
    }
    head = text.slice(0, cut);
  }
  return { head, hiddenLines: Math.max(0, lineCount(text) - lineCount(head)) };
}

const secretsIn = (text: string): string[] => [
  ...new Set(splitSecrets(text).flatMap((s) => (s.kind === "secret" ? [s.name] : []))),
];

function field(key: string | null, value: unknown): ArgField {
  const json = typeof value !== "string";
  const text = json ? (JSON.stringify(value, null, 2) ?? "null") : value;
  return {
    key,
    text,
    json,
    lines: lineCount(text),
    long: isLong(text),
    secrets: secretsIn(text),
  };
}

/**
 * Every argument of the call as a field. An object is one field per key (in order); anything else
 * (the server only sends objects, but a card never refuses to show what it got) is one field
 * without a name. An empty object has no fields: the call takes no arguments.
 */
export function formatArgs(args: unknown): ArgField[] {
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    return Object.entries(args as Record<string, unknown>).map(([key, value]) => field(key, value));
  }
  return [field(null, args)];
}

/** The names of the secrets used anywhere in the arguments, without repeats. */
export function secretsOf(args: unknown): string[] {
  return [...new Set(formatArgs(args).flatMap((f) => f.secrets))];
}

/** The text arguments an "exactly this" rule pins: every top-level string (as the server does). */
export function exactFields(args: unknown): { field: string; value: string }[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  return Object.entries(args as Record<string, unknown>).flatMap(([key, value]) =>
    typeof value === "string" ? [{ field: key, value }] : [],
  );
}
