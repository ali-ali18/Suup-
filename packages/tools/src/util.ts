import { WorkspaceEscapeError } from "@suup/core";

/** Number of bytes of `text` in UTF-8, without needing `Buffer` or `TextEncoder`. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/** Text for the model when an executor call threw. */
export function describeError(error: unknown, path?: string): string {
  if (error instanceof WorkspaceEscapeError) {
    return `The path ${JSON.stringify(path ?? error.path)} is outside the bot workspace (or reaches outside through a symlink). Use a path inside the workspace.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return path === undefined ? message : `${message} (path: ${JSON.stringify(path)})`;
}

export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  if (slash === -1) return ".";
  return slash === 0 ? "/" : trimmed.slice(0, slash);
}

export function baseOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

/** Levenshtein distance, capped: returns `limit + 1` as soon as it is certain to exceed it. */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(
        (prev[j] as number) + 1,
        (row[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      row.push(value);
      best = Math.min(best, value);
    }
    if (best > limit) return limit + 1;
    prev = row;
  }
  return prev[b.length] as number;
}

/** Names from `candidates` that look like a mistyped `wanted` (case, typos, prefix/substring). */
export function similarNames(wanted: string, candidates: readonly string[], max = 5): string[] {
  const w = wanted.toLowerCase();
  if (w === "") return [];
  const scored: { name: string; score: number }[] = [];
  for (const name of candidates) {
    const n = name.toLowerCase();
    let score: number;
    if (n === w) score = 0;
    else if (n.includes(w) || (n.length >= 3 && w.includes(n))) score = 1;
    else {
      const d = distance(w, n, Math.max(2, Math.floor(w.length / 4)));
      if (d > Math.max(2, Math.floor(w.length / 4))) continue;
      score = 1 + d;
    }
    scored.push({ name, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, max)
    .map((s) => s.name);
}
