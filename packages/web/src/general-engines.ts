// Owns the general web search engines of the queue (docs/BUSCA.md, "A fila da busca geral"):
// Tavily and Brave Search, each through its official API, with its key, with the honest user agent
// and through the same egress proxy as the other direct engines. Research with the pages read on
// 24/11/2026: docs/pesquisas/fase-4-busca-alternativas-ao-ddg.md ("Fatos das APIs da fila").
//
// An engine answers with its hits or with a refusal that says WHAT KIND of failure it was (no
// quota, too many requests, key not accepted, no key, service down), which is what the queue needs
// to decide to go on to the next engine, and for how long this one is left alone. Answers are read
// structurally (JSON); one that is not what was expected fails closed. No pattern is used to read
// or to classify anything: statuses and error codes are compared exactly.
import type { WebSearchHit } from "@suup/core";
import { z } from "zod";
import {
  type DirectEngine,
  type DirectSearchInput,
  type DirectSearchResult,
  type FailureKind,
  htmlText,
  parseJson,
  refusal,
} from "./direct-engines.js";
import type { DirectGet, DirectGetOptions, DirectResponse } from "./direct-http.js";
import { cleanUrl, clip } from "./hit-text.js";

const TITLE_MAX = 300;
const SNIPPET_MAX = 500;

/** How long Suup leaves a general engine alone after each kind of failure. Suup's own choices (the services give no figure), kept short enough that an account topped up is used again within the hour. */
export const GENERAL_SUSPENSION_SECONDS = {
  quota: 3600,
  keyRejected: 3600,
  unavailable: 60,
  rateLimited: 60,
  /** The longest Suup waits because a service said so (`Retry-After`). */
  maxRetryAfter: 3600,
} as const;

/** Where an engine finds its key. Looked up at each search, so a key added later is used right away. */
export interface SearchKeys {
  /** The key of the engine, or `undefined` when none is configured (nothing in the environment, nothing in the vault). */
  get(engineId: string): Promise<string | undefined>;
  /** The vault secret and the environment variable the key of this engine is looked for under (for Settings). */
  names?(engineId: string): { secret: string; env: string } | undefined;
}

/** The locale as its parts: language lower case, region upper case (`pt-BR` or `pt_BR`). Split at `-` or `_`. */
export function localeParts(locale: string | undefined): { language?: string; region?: string } {
  if (locale === undefined) return {};
  const parts: string[] = [];
  let word = "";
  for (const ch of locale.trim()) {
    if (ch === "-" || ch === "_") {
      if (word !== "") parts.push(word);
      word = "";
    } else {
      word += ch;
    }
  }
  if (word !== "") parts.push(word);
  const language = parts[0]?.toLowerCase();
  const region = parts.find((p, i) => i > 0 && p.length === 2)?.toUpperCase();
  return {
    ...(language === undefined || language === "" ? {} : { language }),
    ...(region === undefined ? {} : { region }),
  };
}

/** The language the search is in: the one asked for (the first part of `pt-br`), else the locale's. */
function wantedLanguage(input: DirectSearchInput): string | undefined {
  const asked = localeParts(input.language).language;
  return asked ?? localeParts(input.locale).language;
}

/** Tavily's `country`: an English name in lower case (the documented list; only these countries are mapped, any other is left out and the engine ranks without one). */
const TAVILY_COUNTRY: Readonly<Record<string, string>> = {
  BR: "brazil",
  PT: "portugal",
  US: "united states",
  GB: "united kingdom",
  ES: "spain",
  MX: "mexico",
  AR: "argentina",
  FR: "france",
  DE: "germany",
  IT: "italy",
};

/** Brave's `search_lang` values that the API reference lists (exact comparison). */
const BRAVE_LANGUAGES: ReadonlySet<string> = new Set([
  "ar",
  "eu",
  "bn",
  "bg",
  "ca",
  "zh-hans",
  "zh-hant",
  "hr",
  "cs",
  "da",
  "nl",
  "en",
  "en-gb",
  "et",
  "fi",
  "fr",
  "gl",
  "de",
  "el",
  "gu",
  "he",
  "hi",
  "hu",
  "is",
  "it",
  "ja",
  "jp",
  "kn",
  "ko",
  "lv",
  "lt",
  "ms",
  "ml",
  "mr",
  "nb",
  "pl",
  "pt-br",
  "pt-pt",
  "pa",
  "ro",
  "ru",
  "sr",
  "sk",
  "sl",
  "es",
  "sv",
  "ta",
  "te",
  "th",
  "tr",
  "uk",
  "vi",
]);

/** What the answer to one request is, with the headers. A failure to connect is a refusal. */
async function call(
  get: DirectGet,
  url: string,
  options: DirectGetOptions,
): Promise<{ ok: true; response: DirectResponse } | { ok: false; result: DirectSearchResult }> {
  try {
    return { ok: true, response: await get(url, options) };
  } catch (error) {
    return {
      ok: false,
      result: refusal(
        error instanceof Error ? error.message : String(error),
        GENERAL_SUSPENSION_SECONDS.unavailable,
        "unavailable",
      ),
    };
  }
}

/** The first whole number of a header such as `Retry-After: 60` or `X-RateLimit-Reset: 1, 1419704`. */
function firstNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const first = value.split(",")[0]?.trim() ?? "";
  if (first === "") return undefined;
  const n = Number(first);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : undefined;
}

/** The second number of a header with a list (`X-RateLimit-Remaining: 1, 1000` is: this second, this month). */
function secondNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const second = value.split(",")[1]?.trim() ?? "";
  if (second === "") return undefined;
  const n = Number(second);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

const failure = (kind: FailureKind, reason: string, seconds?: number): DirectSearchResult =>
  refusal(reason, seconds, kind);

const noKey: DirectSearchResult = failure("no_key", "no key configured");

// ---------------------------------------------------------------------------------------------
// Tavily: POST https://api.tavily.com/search, `Authorization: Bearer <key>`, JSON.
//   Errors (https://docs.tavily.com/api-reference/endpoint/search, read 24/11/2026): 401 key wrong
//   or missing; 429 too many requests (`Retry-After`); 432 key limit or plan limit exceeded; 433
//   pay-as-you-go limit exceeded; 500 server error.

const tavilyAnswer = z.object({
  results: z.array(
    z.object({
      title: z.string().optional(),
      url: z.string(),
      content: z.string().optional(),
    }),
  ),
});

export function tavilyEngine(options: { get: DirectGet; keys: SearchKeys }): DirectEngine {
  return {
    id: "tavily",
    configured: async () => (await options.keys.get("tavily")) !== undefined,
    async search(input) {
      const key = await options.keys.get("tavily");
      if (key === undefined) return noKey;
      const { region } = localeParts(input.locale);
      const country = region === undefined ? undefined : TAVILY_COUNTRY[region];
      const language = wantedLanguage(input);
      const body = {
        query: input.query,
        // `basic` costs one credit (`advanced` costs two); `auto_parameters` could raise it to
        // `advanced` on its own, so it is off.
        search_depth: "basic",
        topic: "general",
        max_results: Math.min(Math.max(input.limit, 1), 20),
        auto_parameters: false,
        include_answer: false,
        include_raw_content: false,
        include_images: false,
        ...(country === undefined ? {} : { country }),
        ...(language === undefined ? {} : { language }),
        ...(input.timeRange === undefined ? {} : { time_range: input.timeRange }),
      };
      const got = await call(options.get, "https://api.tavily.com/search", {
        method: "POST",
        accept: "application/json",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      if (!got.ok) return got.result;
      const { status, headers } = got.response;
      if (status === 200) {
        const parsed = tavilyAnswer.safeParse(parseJson(got.response.body));
        if (!parsed.success) {
          return failure("other", "Tavily answered in a format that was not expected");
        }
        const hits: WebSearchHit[] = [];
        for (const item of parsed.data.results) {
          const url = cleanUrl(item.url);
          if (url === undefined) continue;
          hits.push({
            title: clip(item.title ?? "", TITLE_MAX) || url,
            url,
            snippet: clip(item.content ?? "", SNIPPET_MAX),
            engine: "tavily",
          });
        }
        return { ok: true, hits };
      }
      if (status === 401) {
        return failure(
          "key_rejected",
          "Tavily did not accept the key",
          GENERAL_SUSPENSION_SECONDS.keyRejected,
        );
      }
      if (status === 432 || status === 433) {
        return failure(
          "quota",
          "Tavily has no credits left (plan or pay-as-you-go limit)",
          GENERAL_SUSPENSION_SECONDS.quota,
        );
      }
      if (status === 429) {
        const wait = firstNumber(headers["retry-after"]);
        return failure(
          "rate_limited",
          "Tavily: too many requests",
          wait === undefined
            ? GENERAL_SUSPENSION_SECONDS.rateLimited
            : Math.min(Math.max(wait, 1), GENERAL_SUSPENSION_SECONDS.maxRetryAfter),
        );
      }
      if (status >= 500) {
        return failure(
          "unavailable",
          `Tavily is unavailable (HTTP ${status})`,
          GENERAL_SUSPENSION_SECONDS.unavailable,
        );
      }
      return failure("other", `Tavily refused the search (HTTP ${status})`);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Brave Search: GET https://api.search.brave.com/res/v1/web/search, `X-Subscription-Token: <key>`.
//   Errors (API reference, read 24/11/2026): the body is `{type: "ErrorResponse", error: {id,
//   status, code, detail, meta}}` with `code` one of INTERNAL, QUOTA_LIMITED, RATE_LIMITED,
//   SUBSCRIPTION_TOKEN_INVALID, SUBSCRIPTION_NOT_FOUND, RESOURCE_NOT_ALLOWED, OPTION_NOT_IN_PLAN,
//   USAGE_LIMIT_EXCEEDED, INVALID_URL, CREDIT_EXHAUSTED. The reference documents 422 and 429 (the
//   status of each code is not documented, so the CODE is what is compared). Headers
//   `X-RateLimit-Remaining` and `X-RateLimit-Reset` list "this second, this month".

const braveAnswer = z.object({
  web: z
    .object({
      results: z
        .array(
          z.object({
            title: z.string().optional(),
            url: z.string(),
            description: z.string().nullish(),
            extra_snippets: z.array(z.string()).optional(),
          }),
        )
        .default([]),
    })
    .optional(),
});

const braveError = z.object({
  error: z.object({ code: z.string().optional(), status: z.number().optional() }),
});

const BRAVE_QUOTA_CODES: readonly string[] = [
  "QUOTA_LIMITED",
  "CREDIT_EXHAUSTED",
  "USAGE_LIMIT_EXCEEDED",
];
const BRAVE_KEY_CODES: readonly string[] = [
  "SUBSCRIPTION_TOKEN_INVALID",
  "SUBSCRIPTION_NOT_FOUND",
  "RESOURCE_NOT_ALLOWED",
  "OPTION_NOT_IN_PLAN",
];
const BRAVE_QUERY_WORDS = 50;
const BRAVE_QUERY_CHARS = 400;

/** The query as Brave takes it (at most 400 characters and 50 words, the limits of its skill file; the API reference says 600 and 75): cut at blanks, not in the middle of a word. */
export function braveQuery(query: string): string {
  const words: string[] = [];
  let word = "";
  for (const ch of query) {
    if (ch.trim() === "") {
      if (word !== "") words.push(word);
      word = "";
    } else {
      word += ch;
    }
  }
  if (word !== "") words.push(word);
  const kept: string[] = [];
  let length = 0;
  for (const w of words.slice(0, BRAVE_QUERY_WORDS)) {
    const next = length + (kept.length === 0 ? 0 : 1) + w.length;
    if (next > BRAVE_QUERY_CHARS) break;
    kept.push(w);
    length = next;
  }
  return kept.join(" ");
}

const FRESHNESS = { day: "pd", month: "pm", year: "py" } as const;

/** Brave's `search_lang`: the documented value for the language (and, for Portuguese, the region). */
function braveLanguage(input: DirectSearchInput): string | undefined {
  const asked = localeParts(input.language);
  const fromLocale = localeParts(input.locale);
  const language = asked.language ?? fromLocale.language;
  if (language === undefined) return undefined;
  if (language === "pt") {
    const region = asked.region ?? fromLocale.region;
    return region === "PT" ? "pt-pt" : "pt-br";
  }
  return BRAVE_LANGUAGES.has(language) ? language : undefined;
}

export function braveEngine(options: { get: DirectGet; keys: SearchKeys }): DirectEngine {
  return {
    id: "brave",
    configured: async () => (await options.keys.get("brave")) !== undefined,
    async search(input) {
      const key = await options.keys.get("brave");
      if (key === undefined) return noKey;
      const query = braveQuery(input.query);
      if (query === "") return failure("other", "the query has no word Brave can search for");
      const { region } = localeParts(input.locale);
      const searchLang = braveLanguage(input);
      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(Math.max(input.limit, 1), 20)),
        text_decorations: "false",
        safesearch: "moderate",
        ...(region === undefined ? {} : { country: region }),
        ...(searchLang === undefined ? {} : { search_lang: searchLang }),
        ...(input.timeRange === undefined ? {} : { freshness: FRESHNESS[input.timeRange] }),
      });
      const got = await call(
        options.get,
        `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
        {
          accept: "application/json",
          headers: { "x-subscription-token": key },
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        },
      );
      if (!got.ok) return got.result;
      const { status, headers } = got.response;
      if (status === 200) {
        const parsed = braveAnswer.safeParse(parseJson(got.response.body));
        if (!parsed.success) {
          return failure("other", "Brave answered in a format that was not expected");
        }
        const hits: WebSearchHit[] = [];
        for (const item of parsed.data.web?.results ?? []) {
          const url = cleanUrl(item.url);
          if (url === undefined) continue;
          hits.push({
            title: clip(htmlText(item.title ?? ""), TITLE_MAX) || url,
            url,
            snippet: clip(htmlText(item.description ?? ""), SNIPPET_MAX),
            engine: "brave",
          });
        }
        // The headers list "this second, this month": nothing left for the month means the next
        // search would fail, so the hits are kept and the engine is left alone from now on.
        const monthLeft = secondNumber(headers["x-ratelimit-remaining"]);
        const monthLimit = secondNumber(headers["x-ratelimit-limit"]);
        if (monthLeft === 0 && monthLimit !== undefined && monthLimit > 0) {
          return {
            ok: true,
            hits,
            suspend: {
              seconds: GENERAL_SUSPENSION_SECONDS.quota,
              reason: "Brave has no requests left this month",
              kind: "quota",
            },
          };
        }
        return { ok: true, hits };
      }
      const error = braveError.safeParse(parseJson(got.response.body));
      const code = error.success ? error.data.error.code : undefined;
      if (code !== undefined && BRAVE_QUOTA_CODES.includes(code)) {
        return failure("quota", "Brave has no credits left", GENERAL_SUSPENSION_SECONDS.quota);
      }
      if (
        (code !== undefined && BRAVE_KEY_CODES.includes(code)) ||
        status === 401 ||
        status === 403
      ) {
        return failure(
          "key_rejected",
          "Brave did not accept the key or the plan does not allow the search",
          GENERAL_SUSPENSION_SECONDS.keyRejected,
        );
      }
      if (code === "RATE_LIMITED" || status === 429) {
        // A 429 without a code: nothing left for the month is a quota, anything else is a pause.
        if (code === undefined && secondNumber(headers["x-ratelimit-remaining"]) === 0) {
          return failure(
            "quota",
            "Brave has no requests left this month",
            GENERAL_SUSPENSION_SECONDS.quota,
          );
        }
        const wait = firstNumber(headers["x-ratelimit-reset"]);
        return failure(
          "rate_limited",
          "Brave: too many requests",
          wait === undefined
            ? GENERAL_SUSPENSION_SECONDS.rateLimited
            : Math.min(Math.max(wait, 1), GENERAL_SUSPENSION_SECONDS.rateLimited),
        );
      }
      if (status >= 500 || code === "INTERNAL") {
        return failure(
          "unavailable",
          `Brave is unavailable (HTTP ${status})`,
          GENERAL_SUSPENSION_SECONDS.unavailable,
        );
      }
      return failure("other", `Brave refused the search (HTTP ${status})`);
    },
  };
}
