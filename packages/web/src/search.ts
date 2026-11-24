// Owns the web search: which engines a search asks, in what way and in what order, and how their
// answers become one `WebSearchOutcome` (docs/BUSCA.md). Two kinds of engine:
//  - the specialised ones (Wikipedia, arXiv, Stack Overflow) are asked together, at once;
//  - the general web engines (Tavily, Brave) are a QUEUE: asked one at a time, in the configured
//    order, and the next only when the one before had no quota, was unavailable, did not accept its
//    key or failed. One that answers ends the queue. An engine without a key is skipped.
// The cache, the governor (Suup's own limits and the memory of who asked to be left alone) and the
// usage count are applied here. Nothing here writes or logs the query.
import type { WebSearchHit, WebSearchOutcome, WebSearchRequest } from "@suup/core";
import type { DirectEngine, DirectSearchResult, FailureKind } from "./direct-engines.js";
import { engineById, generalQueue } from "./engines.js";
import { clip, interleave } from "./hit-text.js";
import { DEFAULT_CACHE_TTL_MS, type SearchCache, searchCacheKey } from "./search-cache.js";
import type { SearchGovernor } from "./search-governor.js";
import type { SearchUsage } from "./search-usage.js";

export { clip };

export const SEARCH_MAX_RESULTS = 10;

export interface SearchOptions {
  /** The engines Suup asks, by official API (direct-engines.ts, general-engines.ts). An engine that is on but has no entry here is reported as not available. */
  direct: readonly DirectEngine[];
  /** The engines that are turned on (what a search asks, unless the limits or a suspension leave some out). */
  engines: readonly string[];
  /** The order the general engines are tried in. Default: the order they are declared in. */
  generalOrder?: readonly string[];
  /** The person's locale (`pt-BR`): the general engines rank for its country and language. */
  locale?: string | undefined;
  maxResults?: number;
  /** Suup's own rate limits and the memory of suspended engines. Without it every search goes out at once. */
  governor?: SearchGovernor;
  /** Answers an identical search made recently. Without it nothing is cached. */
  cache?: SearchCache;
  /** How long a cached answer lives. Default 3 hours. */
  cacheTtlMs?: number;
  /** Counts the searches each general engine answered, per month (never the query). */
  usage?: SearchUsage;
  /** Where a failover is told: the engines and the reason, never the query. */
  log?: (line: string) => void;
  now?: () => number;
}

type SearchOk = Extract<WebSearchOutcome, { ok: true }>;
type Refusal = { retryInSeconds: number; scope: "overall" | "engines" };

/** An engine that did not answer, with why and, when known, for how long it is left alone. */
interface Unresponsive {
  engine: string;
  reason: string;
  windowSeconds?: number;
  kind?: FailureKind;
}

/** The log line of a general engine that was passed over. Only engine names and a kind: never the query. */
export function failoverLogLine(from: string, kind: FailureKind, next: string | undefined): string {
  return `web_search: failover ${from} (${kind})${next === undefined ? ": no general engine left" : ` -> ${next}`}`;
}

export function createSearch(
  options: SearchOptions,
): (request: WebSearchRequest) => Promise<WebSearchOutcome> {
  const clock = options.now ?? Date.now;
  const cap = options.maxResults ?? SEARCH_MAX_RESULTS;
  const ttl = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const directById = new Map(options.direct.map((engine) => [engine.id, engine]));
  const queue = generalQueue(options.engines, options.generalOrder);
  const specialised = options.engines.filter((id) => engineById(id)?.general !== true);

  return async (request) => {
    const query = request.query.trim();
    if (query === "") return { ok: false, reason: "failed", message: "The search query is empty." };
    const wanted = Math.min(Math.max(request.limit ?? 5, 1), cap);
    const startedAt = clock();

    // 1. An identical search made recently is answered from the cache.
    const key =
      options.cache === undefined
        ? undefined
        : searchCacheKey({
            query,
            engines: options.engines,
            language: request.language,
            timeRange: request.timeRange,
          });
    if (options.cache !== undefined && key !== undefined) {
      const entry = await options.cache.get(key, startedAt).catch(() => undefined);
      if (entry !== undefined) {
        return {
          ok: true,
          query,
          hits: entry.hits.slice(0, wanted),
          suspended: entry.suspended,
          engines: entry.engines,
          cached: {
            at: new Date(entry.storedAt).toISOString(),
            ageSeconds: Math.max(0, Math.round((startedAt - entry.storedAt) / 1000)),
          },
        };
      }
    }

    // 2. Engines Suup already knows to be suspended are not asked.
    const known = options.governor?.suspended() ?? new Map();
    const skippedAnswer = options.engines
      .filter((engine) => known.has(engine))
      .map((engine) => ({
        engine,
        reason: known.get(engine)?.reason ?? "",
        retryInSeconds: known.get(engine)?.retryInSeconds ?? 0,
      }));
    const specialisedNow = specialised.filter((engine) => !known.has(engine));
    const queueNow = queue.filter((engine) => !known.has(engine));
    if (specialisedNow.length === 0 && queueNow.length === 0 && options.engines.length > 0) {
      return {
        ok: true,
        query,
        hits: [],
        suspended: skippedAnswer,
        engines: [],
        ...generalState(queue, [], skippedAnswer, [], known, []),
      };
    }

    // 3. Suup's own limits for the specialised engines: wait a little, leave out an engine that is
    //    over its limit, or say when to come back. (The queue is limited engine by engine, below.)
    let ask = specialisedNow;
    const throttled: { engine: string; retryInSeconds: number }[] = [];
    let waitedMs = 0;
    if (options.governor !== undefined && specialisedNow.length > 0) {
      const grant = await options.governor.acquire(specialisedNow, request.signal);
      if (!grant.ok) {
        if (queueNow.length === 0) return rateLimited(grant);
        ask = [];
        for (const engine of specialisedNow) {
          throttled.push({ engine, retryInSeconds: grant.retryInSeconds });
        }
      } else {
        ask = grant.engines;
        throttled.push(...grant.throttled);
        waitedMs = grant.waitedMs;
      }
    }

    // 4. The search itself: the specialised engines at once, the general queue one by one.
    const [parts, general] = await Promise.all([
      Promise.all(
        ask.map(async (id) => ({
          id,
          result: await askEngine(directById, id, query, cap, request, options.locale),
        })),
      ),
      runQueue({ queue: queueNow, directById, query, cap, request, options, throttled }),
    ]);
    if (
      general.refused !== undefined &&
      ask.length === 0 &&
      general.asked.length === 0 &&
      general.noKey.length === 0
    ) {
      // Nothing could be asked at all: every engine was over Suup's own limit.
      return rateLimited(general.refused);
    }
    const unresponsive: Unresponsive[] = [...general.passed];
    const lists: WebSearchHit[][] = [general.hits];
    for (const { id, result } of parts) {
      if (result.ok) {
        lists.push(result.hits);
        if (result.suspend !== undefined) {
          unresponsive.push({
            engine: id,
            reason: result.suspend.reason,
            windowSeconds: result.suspend.seconds,
          });
        }
      } else {
        unresponsive.push({
          engine: id,
          reason: result.reason,
          ...(result.suspendSeconds === undefined ? {} : { windowSeconds: result.suspendSeconds }),
        });
      }
    }
    if (general.suspendAfterAnswer !== undefined) unresponsive.push(general.suspendAfterAnswer);
    const merged: WebSearchHit[] = [];
    const seen = new Set<string>();
    for (const hit of interleave(lists)) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      merged.push(hit);
      if (merged.length >= cap) break;
    }
    const asked = [...ask, ...general.asked];

    // 5. What the answers say about the engines, kept for the next search.
    const retry = options.governor?.learn(asked, unresponsive) ?? new Map<string, number>();
    const suspended = [
      ...unresponsive.map(({ engine, reason }) => {
        const seconds = retry.get(engine);
        return seconds === undefined
          ? { engine, reason }
          : { engine, reason, retryInSeconds: seconds };
      }),
      ...skippedAnswer,
    ];
    const outcome: SearchOk = {
      ok: true,
      query,
      hits: merged,
      suspended,
      engines: asked,
      ...(general.answeredBy === undefined ? {} : { generalEngine: general.answeredBy }),
      ...(throttled.length === 0 ? {} : { throttled }),
      ...(waitedMs >= 1000 ? { waitedSeconds: Math.round(waitedMs / 1000) } : {}),
      ...(general.answeredBy === undefined
        ? generalState(queue, general.noKey, suspended, throttled, known, unresponsive)
        : {}),
    };
    // Brave's terms forbid keeping its results beyond transient storage: an answer with one of its
    // hits is never cached. Any other answer is.
    const cacheable = outcome.hits.every((hit) => engineById(hit.engine)?.cacheable !== false);
    if (options.cache !== undefined && key !== undefined && outcome.hits.length > 0 && cacheable) {
      await options.cache
        .set(
          key,
          {
            query,
            engines: outcome.engines,
            hits: outcome.hits,
            suspended: outcome.suspended.map(({ engine, reason }) => ({ engine, reason })),
            storedAt: clock(),
          },
          ttl,
        )
        .catch(() => undefined);
    }
    return { ...outcome, hits: outcome.hits.slice(0, wanted) };
  };
}

function rateLimited(grant: Refusal): WebSearchOutcome {
  return {
    ok: false,
    reason: "rate_limited",
    retryInSeconds: grant.retryInSeconds,
    message:
      grant.scope === "overall"
        ? `Too many searches in the last minute. Suup limits how often it asks the search engines; try again in about ${grant.retryInSeconds} s.`
        : `Every engine for this search is at its limit for the minute. Try again in about ${grant.retryInSeconds} s.`,
  };
}

interface QueueRun {
  /** The hits of the engine that answered. */
  hits: WebSearchHit[];
  answeredBy?: string;
  /** The engines that were really asked (a service was called). */
  asked: string[];
  /** The engines passed over after being asked, with why. */
  passed: Unresponsive[];
  /** The engines with no key, left out without being asked. */
  noKey: string[];
  /** The engine answered and asked to be left alone from now on (Brave: nothing left this month). */
  suspendAfterAnswer?: Unresponsive;
  /** Suup's own limit refused an engine of the queue (the last refusal). */
  refused?: Refusal;
}

/** Asks the general engines one at a time until one answers. */
async function runQueue(input: {
  queue: readonly string[];
  directById: ReadonlyMap<string, DirectEngine>;
  query: string;
  cap: number;
  request: WebSearchRequest;
  options: SearchOptions;
  throttled: { engine: string; retryInSeconds: number }[];
}): Promise<QueueRun> {
  const { queue, directById, query, cap, request, options } = input;
  const run: QueueRun = { hits: [], asked: [], passed: [], noKey: [] };
  for (const [index, id] of queue.entries()) {
    const engine = directById.get(id);
    if (engine === undefined) {
      run.passed.push({ engine: id, reason: "the engine is not available", kind: "unavailable" });
      continue;
    }
    // No key: the engine is not asked (and takes no place in Suup's limits).
    if (engine.configured !== undefined && !(await engine.configured())) {
      run.noKey.push(id);
      continue;
    }
    if (options.governor !== undefined) {
      const grant = await options.governor.acquire([id], request.signal);
      if (!grant.ok) {
        run.refused = { retryInSeconds: grant.retryInSeconds, scope: grant.scope };
        input.throttled.push({ engine: id, retryInSeconds: grant.retryInSeconds });
        continue;
      }
    }
    const result = await askEngine(directById, id, query, cap, request, options.locale);
    if (!result.ok && result.kind === "no_key") {
      run.noKey.push(id);
      continue;
    }
    run.asked.push(id);
    if (result.ok) {
      run.answeredBy = id;
      run.hits = result.hits;
      await options.usage?.record(id, new Date((options.now ?? Date.now)())).catch(() => undefined);
      if (result.suspend !== undefined) {
        run.suspendAfterAnswer = {
          engine: id,
          reason: result.suspend.reason,
          windowSeconds: result.suspend.seconds,
          ...(result.suspend.kind === undefined ? {} : { kind: result.suspend.kind }),
        };
      }
      return run;
    }
    const kind = result.kind ?? "other";
    run.passed.push({
      engine: id,
      reason: result.reason,
      kind,
      ...(result.suspendSeconds === undefined ? {} : { windowSeconds: result.suspendSeconds }),
    });
    const next = queue.slice(index + 1).find((later) => directById.has(later));
    options.log?.(failoverLogLine(id, kind, next));
  }
  return run;
}

async function askEngine(
  engines: ReadonlyMap<string, DirectEngine>,
  id: string,
  query: string,
  limit: number,
  request: WebSearchRequest,
  locale: string | undefined,
): Promise<DirectSearchResult> {
  const engine = engines.get(id);
  if (engine === undefined) return { ok: false, reason: "the engine is not available" };
  try {
    return await engine.search({
      query,
      limit,
      language: request.language,
      locale,
      timeRange: request.timeRange,
      signal: request.signal,
    });
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      kind: "unavailable",
    };
  }
}

/**
 * Whether every general web engine that is turned on is out of reach for now, why, and until when.
 * Empty when no general engine is on, or when one of them is not out of reach.
 */
function generalState(
  queue: readonly string[],
  noKey: readonly string[],
  suspended: readonly { engine: string; retryInSeconds?: number }[],
  throttled: readonly { engine: string; retryInSeconds: number }[],
  known: ReadonlyMap<string, { kind?: string }>,
  unresponsive: readonly Unresponsive[],
): { generalUnavailable?: NonNullable<SearchOk["generalUnavailable"]> } {
  if (queue.length === 0) return {};
  const kinds: string[] = [];
  const seconds: number[] = [];
  for (const id of queue) {
    const s = suspended.find((u) => u.engine === id);
    const t = throttled.find((u) => u.engine === id);
    const failed = unresponsive.find((u) => u.engine === id);
    if (noKey.includes(id)) {
      kinds.push("no_key");
    } else if (t !== undefined && s === undefined) {
      kinds.push("limit");
      seconds.push(t.retryInSeconds);
    } else if (s !== undefined || failed !== undefined) {
      kinds.push(failed?.kind ?? known.get(id)?.kind ?? "other");
      if (s?.retryInSeconds !== undefined) seconds.push(s.retryInSeconds);
    } else {
      // This engine is neither suspended, limited, without a key nor failed: it is not out of reach.
      return {};
    }
  }
  const cause: NonNullable<SearchOk["generalUnavailable"]>["cause"] = kinds.every(
    (k) => k === "no_key",
  )
    ? "no_key"
    : kinds.includes("quota")
      ? "quota"
      : kinds.every((k) => k === "limit")
        ? "limit"
        : "unavailable";
  return {
    generalUnavailable: {
      cause,
      ...(seconds.length === 0 ? {} : { retryInSeconds: Math.min(...seconds) }),
    },
  };
}
