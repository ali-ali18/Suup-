import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** How many daily log files are kept. */
export const KEEP_LOG_DAYS = 14;
const LOG_PREFIX = "suup-";
const LOG_SUFFIX = ".log";

/**
 * Takes the secrets this process knows out of a text, by EXACT value (the vault does the same;
 * nothing here guesses what "looks like" a secret). Values shorter than 8 characters are left alone:
 * they would blank out ordinary words.
 */
export function scrubber(secrets: readonly (string | undefined)[]): (text: string) => string {
  const known = secrets.filter((s): s is string => s !== undefined && s.length >= 8);
  return (text) => known.reduce((acc, secret) => acc.split(secret).join("[segredo]"), text);
}

/** The file of a day: `suup-2026-11-19.log`. */
export function logFileName(now: Date): string {
  return `${LOG_PREFIX}${now.toISOString().slice(0, 10)}${LOG_SUFFIX}`;
}

/** Deletes the oldest daily logs, keeping the newest `keep` (names sort by date). */
export function pruneLogs(dir: string, keep: number = KEEP_LOG_DAYS): void {
  const names = readdirSync(dir)
    .filter((n) => n.startsWith(LOG_PREFIX) && n.endsWith(LOG_SUFFIX))
    .sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    rmSync(join(dir, name), { force: true });
  }
}

/** A file that grew past `maxBytes` becomes `<name>.old` (one generation), so it never fills the disk. */
export function rotateIfBig(file: string, maxBytes: number): void {
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.old`);
  } catch {
    // no file yet
  }
}

export interface Logger {
  line(text: string): void;
  /** The directory the files are in. */
  dir: string;
}

/** The sidecar's log: one file per day in `dir`, every line stamped and scrubbed. */
export function createLogger(dir: string, scrub: (text: string) => string): Logger {
  mkdirSync(dir, { recursive: true });
  pruneLogs(dir);
  return {
    dir,
    line(text) {
      const now = new Date();
      const body = scrub(text).trimEnd();
      try {
        appendFileSync(join(dir, logFileName(now)), `${now.toISOString()} ${body}\n`);
      } catch {
        // a full or locked disk must not take the server down
      }
    },
  };
}
