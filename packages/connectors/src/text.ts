// Owns cleaning text that comes from a connector's server before anything reads it: tool
// descriptions, property names, results. The server is not trusted (a hostile or compromised
// server can hide instructions in a description: "tool poisoning", see docs/CONECTORES.md), so
// this only removes what makes text hard to audit (control, invisible and direction-changing
// characters) and bounds its size. It does not, and cannot, make the words themselves safe.

/**
 * Characters that change what a reader sees without being visible: zero-width characters, bidi
 * controls and isolates, the invisible "tag" block, the BOM and variation selectors.
 */
const INVISIBLE =
  // biome-ignore lint/suspicious/noMisleadingCharacterClass: the point is to match each of them
  /[­؜᠎​-‏‪-‮⁠-⁤⁦-⁯︀-️﻿￹-￻]|[\u{e0000}-\u{e007f}]/gu;
/** C0 and C1 control characters, except tab, newline and carriage return. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the purpose
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Removes control and invisible characters. Keeps tabs and line breaks. */
export function stripControl(text: string): string {
  return text.replace(CONTROLS, "").replace(INVISIBLE, "");
}

/** Cuts `text` to at most `max` characters (without splitting a surrogate pair), marking the cut. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/**
 * A description from a server, as the model may see it: cleaned, with long runs of blank lines
 * collapsed, trimmed and bounded.
 */
export function cleanDescription(text: string | undefined, max: number): string {
  if (text === undefined) return "";
  const cleaned = stripControl(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clip(cleaned, max);
}

/** One line for a message or a table: cleaned, whitespace collapsed, bounded. */
export function oneLineClean(text: string, max: number): string {
  return clip(stripControl(text).replace(/\s+/g, " ").trim(), max);
}
