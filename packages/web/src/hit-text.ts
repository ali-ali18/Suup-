// Owns the small text helpers every search result goes through: a URL that is safe to show, one
// line of plain text, and the merge of several engines' lists. No pattern is used.
const URL_MAX = 1000;

export function cleanUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length > URL_MAX) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** One line of plain text: control characters and line breaks become spaces, and the text is cut. */
export function clip(text: string, max: number): string {
  let out = "";
  let space = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const blank = code < 0x20 || code === 0x7f || ch === " " || ch === " ";
    if (blank) {
      space = out !== "";
      continue;
    }
    if (space) out += " ";
    space = false;
    out += ch;
    if (out.length >= max) return `${out.slice(0, max - 1)}…`;
  }
  return out;
}

/** First of each list, then the second of each, and so on. */
export function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) {
      const item = list[i];
      if (item !== undefined) out.push(item);
    }
  }
  return out;
}
