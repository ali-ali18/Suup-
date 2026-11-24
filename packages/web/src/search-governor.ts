// Owns Suup's own politeness toward the engines (docs/BUSCA.md, "Busca educada"): how many searches
// go out in a minute, overall and to each engine, and what is known about an engine that said no.
//
//  - Limits are a sliding window of 60 seconds. A search that would go over waits in a queue for the
//    first moment it may go, as long as that is no more than `maxWaitMs`; past that it is refused
//    with "try again in X s", never retried in a loop. A search that finds one engine over its own
//    limit but others free goes on without that engine and says so.
//  - When an engine answers with a captcha, "too many requests" or "access denied", the search
//    service suspends it for a fixed time. The reason text is the one SearXNG itself writes
//    (`searx/webutils.py`), compared by EXACT equality with the known ones; any other text has no
//    known window and is only passed on. Until the window ends Suup does not ask that engine again.
import { engineById } from "./engines.js";

const WINDOW_MS = 60_000;

/** How long the search service suspends an engine after each kind of refusal (`search.suspended_times`, SearXNG 2026.3.25). */
export const SUSPENSION_SECONDS: Readonly<Record<string, number>> = {
  CAPTCHA: 3600,
  "too many requests": 180,
  "access denied": 180,
};

/** The prefix SearXNG puts before the reason of an engine it skipped because it is suspended. */
const SUSPENDED_MARK = "Suspended";

export interface ParsedReason {
  /** SearXNG already had the engine suspended (it did not even ask it). */
  suspendedBefore: boolean;
  /** The reason without the prefix, as SearXNG wrote it. */
  kind: string;
  /** The known suspension window, in seconds. */
  windowSeconds?: number;
}

/** Reads the reason SearXNG gave for an engine that did not answer. Exact comparison with the known texts. */
export function parseReason(text: string): ParsedReason {
  const colon = text.indexOf(": ");
  const suspendedBefore = colon !== -1 && text.slice(0, colon) === SUSPENDED_MARK;
  const kind = suspendedBefore ? text.slice(colon + 2) : text;
  const windowSeconds = Object.hasOwn(SUSPENSION_SECONDS, kind)
    ? SUSPENSION_SECONDS[kind]
    : undefined;
  return { suspendedBefore, kind, ...(windowSeconds === undefined ? {} : { windowSeconds }) };
}

export interface SearchLimits {
  /** Searches in any 60 seconds, overall. Default 20. */
  perMinute: number;
  /** Per engine, over the engine's own default (`EngineSpec.perMinute`). */
  perEngine: Readonly<Record<string, number>>;
  /** The most a search waits in the queue. Default 20 000. Past it the search is refused with the time to try again. */
  maxWaitMs: number;
}

export const DEFAULT_SEARCH_LIMITS: SearchLimits = {
  perMinute: 20,
  perEngine: {},
  maxWaitMs: 20_000,
};

/** What `acquire` decided. */
export type Grant =
  | {
      ok: true;
      /** The engines this search may ask. */
      engines: string[];
      /** The engines left out because their own limit is used up, and when each is free. */
      throttled: { engine: string; retryInSeconds: number }[];
      waitedMs: number;
    }
  | { ok: false; retryInSeconds: number; scope: "overall" | "engines" };

export interface GovernorOptions {
  limits?: Partial<SearchLimits>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class SearchGovernor {
  readonly #limits: SearchLimits;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #overall: number[] = [];
  readonly #perEngine = new Map<string, number[]>();
  readonly #until = new Map<string, { at: number; reason: string }>();
  /** Searches go through here one at a time, in order. */
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: GovernorOptions = {}) {
    this.#limits = { ...DEFAULT_SEARCH_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? ((ms) => new Promise<void>((done) => setTimeout(done, ms)));
  }

  limitFor(engine: string): number {
    return this.#limits.perEngine[engine] ?? engineById(engine)?.perMinute ?? 10;
  }

  /** The engines Suup knows to be suspended right now, with when each may answer again. */
  suspended(): Map<string, { retryInSeconds: number; reason: string }> {
    const now = this.#now();
    const out = new Map<string, { retryInSeconds: number; reason: string }>();
    for (const [engine, entry] of this.#until) {
      if (entry.at <= now) {
        this.#until.delete(engine);
      } else {
        out.set(engine, {
          retryInSeconds: Math.ceil((entry.at - now) / 1000),
          reason: entry.reason,
        });
      }
    }
    return out;
  }

  /**
   * What an answer told us: `unresponsive` are the engines that did not answer, with SearXNG's
   * reason (or, for an engine Suup asks itself, its own reason and `windowSeconds`); the others of `asked` did, and are forgotten as suspended. Returns each unresponsive
   * engine's seconds to retry, when a window is known.
   */
  learn(
    asked: readonly string[],
    unresponsive: readonly { engine: string; reason: string; windowSeconds?: number }[],
  ): Map<string, number> {
    const now = this.#now();
    const retry = new Map<string, number>();
    const failed = new Set(unresponsive.map((u) => u.engine));
    for (const engine of asked) if (!failed.has(engine)) this.#until.delete(engine);
    for (const { engine, reason, windowSeconds } of unresponsive) {
      // An engine Suup asks itself says how long (`windowSeconds`); for SearXNG only the text is known.
      const parsed =
        windowSeconds === undefined
          ? parseReason(reason)
          : { suspendedBefore: false, kind: reason, windowSeconds };
      if (parsed.windowSeconds === undefined) continue;
      const known = this.#until.get(engine);
      // A report that SearXNG had it suspended already is not a new refusal: the window runs from
      // the first time we saw it (or, when we never did, from now, which is the later bound).
      const at =
        parsed.suspendedBefore && known !== undefined && known.at > now
          ? known.at
          : now + parsed.windowSeconds * 1000;
      this.#until.set(engine, { at, reason: parsed.kind });
      retry.set(engine, Math.ceil((at - now) / 1000));
    }
    return retry;
  }

  /**
   * Takes a place in the queue for a search that asks `engines`. Resolves with the engines it may
   * ask (after waiting, if it has to), or with the time to try again.
   */
  acquire(engines: readonly string[], signal?: AbortSignal): Promise<Grant> {
    const run = this.#tail.then(() => this.#acquire(engines, signal));
    this.#tail = run.catch(() => undefined);
    return run;
  }

  async #acquire(engines: readonly string[], signal?: AbortSignal): Promise<Grant> {
    const startedAt = this.#now();
    const overallWait = this.#wait(this.#overall, this.#limits.perMinute, startedAt);
    const waits = engines.map((engine) => ({
      engine,
      wait: this.#wait(this.#list(engine), this.limitFor(engine), startedAt),
    }));
    // The first moment when the overall limit is free and at least one engine is free.
    const soonestEngine = waits.length === 0 ? 0 : Math.min(...waits.map((w) => w.wait));
    const first = Math.max(overallWait, soonestEngine);
    if (first > this.#limits.maxWaitMs) {
      return {
        ok: false,
        retryInSeconds: Math.ceil(first / 1000),
        scope: overallWait >= soonestEngine ? "overall" : "engines",
      };
    }
    if (first > 0) await this.#sleep(first);
    if (signal?.aborted === true) return { ok: false, retryInSeconds: 0, scope: "overall" };
    const now = this.#now();
    const usable: string[] = [];
    const throttled: { engine: string; retryInSeconds: number }[] = [];
    for (const engine of engines) {
      const wait = this.#wait(this.#list(engine), this.limitFor(engine), now);
      if (wait === 0) usable.push(engine);
      else throttled.push({ engine, retryInSeconds: Math.ceil(wait / 1000) });
    }
    if (usable.length === 0 || this.#wait(this.#overall, this.#limits.perMinute, now) > 0) {
      const retry = Math.max(1, ...throttled.map((t) => t.retryInSeconds));
      return {
        ok: false,
        retryInSeconds: retry,
        scope: usable.length === 0 ? "engines" : "overall",
      };
    }
    this.#overall.push(now);
    for (const engine of usable) this.#list(engine).push(now);
    return { ok: true, engines: usable, throttled, waitedMs: Math.max(0, now - startedAt) };
  }

  #list(engine: string): number[] {
    let list = this.#perEngine.get(engine);
    if (list === undefined) {
      list = [];
      this.#perEngine.set(engine, list);
    }
    return list;
  }

  /** Milliseconds until one more call fits in the window (0: it fits now). Drops the entries that left the window. */
  #wait(calls: number[], limit: number, now: number): number {
    while (calls.length > 0 && (calls[0] as number) <= now - WINDOW_MS) calls.shift();
    if (calls.length < limit) return 0;
    return (calls[calls.length - limit] as number) + WINDOW_MS - now;
  }
}
