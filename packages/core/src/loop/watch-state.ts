// Owns the structural side of the progress watchdog (docs/VIGIA.md): what the run remembers about
// its recent calls and the pure functions that count the signals from it. Everything here is
// exact comparison of declared fields (tool name, canonical arguments, the error flag and outcome,
// the result text, the level of the call); nothing reads text for meaning (docs/REGRAS.md, section 1).
import type { RiskLevel } from "../risk.js";
import { fingerprint } from "./fingerprint.js";

/** The calls kept to count the signals (the longest signal looks at 12). */
export const WATCH_RECENT = 12;
/** Progress is looked for in this many of the last calls. */
export const PROGRESS_WINDOW = 10;
/** The near-repeat signal: this many of the last `NEAR_REPEAT_OF` calls are the same call. */
export const NEAR_REPEAT_OF = 8;
export const NEAR_REPEAT_TIMES = 4;
/** An A-B-A-B run of at least this many calls is an alternation. */
export const ALTERNATION_MIN = 6;
/** What the sets of what was already seen hold at most (the oldest goes first). */
const SEEN_MAX = 2000;

/** One call of the run, as the watchdog remembers it. */
export interface WatchCall {
  name: string;
  /** The arguments as canonical JSON. */
  args: string;
  isError: boolean;
  outcome: string;
  /** The whole result text, for exact comparison. */
  content: string;
  /** A successful call that changed something (its level was not a read) and was new. */
  changed: boolean;
  /** A successful call with a name and arguments the run had not made before. */
  newCall: boolean;
  /** A successful call whose result the run had not seen before. */
  newEvidence: boolean;
}

export interface WatchState {
  /** Steps granted past `maxTurns`, in order: the automatic extensions and the owner's. */
  grants: number[];
  autoExtensions: number;
  ownerExtensions: number;
  /** The limit at which the soft check (80 %) already ran. */
  softAt: number;
  /** The last calls since the detection window opened, oldest first. */
  recent: WatchCall[];
  /** What the window counted so far. */
  totals: { changes: number; newCalls: number; newEvidence: number };
  /** Patterns already nudged in this window (once each). */
  nudged: Set<string>;
  /** The owner chose to stop: the run ends cleanly at the next safe point. */
  stopRequested: boolean;
  /** Seen for the whole run (never reset by a window): what makes a call or a result "new". */
  seenCalls: Set<string>;
  seenResults: Set<string>;
}

export function createWatchState(): WatchState {
  return {
    grants: [],
    autoExtensions: 0,
    ownerExtensions: 0,
    softAt: 0,
    recent: [],
    totals: { changes: 0, newCalls: 0, newEvidence: 0 },
    nudged: new Set(),
    stopRequested: false,
    seenCalls: new Set(),
    seenResults: new Set(),
  };
}

/** The detection window opens again (the owner wrote or let the run continue). Seen sets stay. */
export function reopenWindow(watch: WatchState): void {
  watch.recent = [];
  watch.totals = { changes: 0, newCalls: 0, newEvidence: 0 };
  watch.nudged = new Set();
}

function remember(set: Set<string>, key: string): boolean {
  if (set.has(key)) return false;
  set.add(key);
  if (set.size > SEEN_MAX) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  return true;
}

export function trackCall(
  watch: WatchState,
  call: { name: string; args: string; isError: boolean; outcome: string; content: string },
  risk: RiskLevel | undefined,
): void {
  const ok = !call.isError;
  const newCall = ok && remember(watch.seenCalls, `${call.name}\u0000${call.args}`);
  const newEvidence =
    ok && remember(watch.seenResults, fingerprint(`${call.name}\u0000${call.content}`));
  const changed = newCall && risk !== undefined && risk !== "read";
  watch.recent.push({ ...call, changed, newCall, newEvidence });
  if (watch.recent.length > WATCH_RECENT) watch.recent.shift();
  if (changed) watch.totals.changes += 1;
  if (newCall) watch.totals.newCalls += 1;
  if (newEvidence) watch.totals.newEvidence += 1;
}

const sameCall = (a: WatchCall, b: WatchCall): boolean => a.name === b.name && a.args === b.args;
const sameStep = (a: WatchCall, b: WatchCall): boolean =>
  sameCall(a, b) && a.isError === b.isError && a.content === b.content;

/** The most times one call (same tool, same arguments, any result) appears in the last 8. */
export function nearRepeat(watch: WatchState): number {
  const last = watch.recent.slice(-NEAR_REPEAT_OF);
  let most = 0;
  for (const call of last) {
    const n = last.filter((other) => sameCall(call, other)).length;
    if (n > most) most = n;
  }
  return most;
}

/** How many calls at the end are the same tool failing the same way (the declared outcome). */
export function errorRun(watch: WatchState): number {
  const { recent } = watch;
  const tail = recent[recent.length - 1];
  if (tail === undefined || !tail.isError) return 0;
  let n = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const call = recent[i] as WatchCall;
    if (!call.isError || call.name !== tail.name || call.outcome !== tail.outcome) break;
    n += 1;
  }
  return n;
}

/** The length of the A-B-A-B run at the end (same step by position), 0 when under the minimum. */
export function alternation(watch: WatchState): number {
  const { recent } = watch;
  const n = recent.length;
  if (n < ALTERNATION_MIN) return 0;
  const a = recent[n - 2] as WatchCall;
  const b = recent[n - 1] as WatchCall;
  if (sameStep(a, b)) return 0;
  let length = 2;
  for (let i = n - 3; i >= 0; i--) {
    const expected = (n - 1 - i) % 2 === 0 ? b : a;
    if (!sameStep(recent[i] as WatchCall, expected)) break;
    length += 1;
  }
  return length >= ALTERNATION_MIN ? length : 0;
}

/** Something was changed, or something new was learned, in the last calls. */
export function progressShown(watch: WatchState): boolean {
  return watch.recent
    .slice(-PROGRESS_WINDOW)
    .some((call) => call.changed || call.newCall || call.newEvidence);
}
