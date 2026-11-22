import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseAllowlistHost } from "@suup/core";
import { DEFAULT_ENGINES, unknownEngines } from "@suup/web/engines";
import { z } from "zod";
import { ConfigError } from "./errors.js";

export const DEFAULT_CONFIG_FILE = "suup.config.json";

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A schema message that says "missing" when the field is absent and `text` otherwise. */
const orMissing = (text: string) => (issue: { input?: unknown }) =>
  issue.input === undefined ? "campo obrigatório ausente" : text;

const id = (what: string) =>
  z
    .string({ error: orMissing(`${what}: esperado um texto`) })
    .regex(ID, `${what}: use só letras, números, ponto, hífen e sublinhado (sem espaços)`);
const envName = z
  .string({ error: orMissing("esperado o NOME de uma variável de ambiente (texto)") })
  .regex(ENV_NAME, "nome de variável de ambiente inválido (letras, números e sublinhado)");
const positiveInt = z.number().int().positive();

const providerCommon = {
  id: id("id do provedor"),
  baseUrl: z.exactOptional(z.string().min(1)),
  headers: z.exactOptional(z.record(z.string(), z.string())),
  maxRetries: z.exactOptional(z.number().int().min(0)),
  requestTimeoutMs: z.exactOptional(z.number().positive()),
  retryBaseDelayMs: z.exactOptional(z.number().min(0)),
  retryMaxDelayMs: z.exactOptional(z.number().min(0)),
  extraBody: z.exactOptional(z.record(z.string(), z.unknown())),
};

const anthropicProvider = z.strictObject({
  kind: z.literal("anthropic"),
  ...providerCommon,
  apiKeyEnv: envName,
  anthropicVersion: z.exactOptional(z.string().min(1)),
  betas: z.exactOptional(z.array(z.string())),
  promptCache: z.exactOptional(z.boolean()),
});

const openaiProvider = z.strictObject({
  kind: z.literal("openai-compatible"),
  ...providerCommon,
  apiKeyEnv: z.exactOptional(envName),
  includeUsage: z.exactOptional(z.boolean()),
  maxTokensParam: z.exactOptional(z.enum(["max_tokens", "max_completion_tokens"])),
  supportsToolChoice: z.exactOptional(z.boolean()),
  capabilities: z.exactOptional(
    z.strictObject({
      promptCache: z.exactOptional(z.boolean()),
      parallelTools: z.exactOptional(z.boolean()),
      vision: z.exactOptional(z.boolean()),
    }),
  ),
});

const scriptedProvider = z.strictObject({
  kind: z.literal("scripted"),
  id: providerCommon.id,
  scriptPath: z.string().min(1),
  textChunkSize: z.exactOptional(positiveInt),
});

const providerSchema = z.discriminatedUnion(
  "kind",
  [anthropicProvider, openaiProvider, scriptedProvider],
  {
    error: orMissing(
      'tipo de provedor inválido: use "anthropic", "openai-compatible" ou "scripted"',
    ),
  },
);

const pricingSchema = z.strictObject({
  inputPerMTok: z.number().min(0),
  outputPerMTok: z.number().min(0),
  cachedInputPerMTok: z.exactOptional(z.number().min(0)),
  cacheWriteInputPerMTok: z.exactOptional(z.number().min(0)),
});

const modelSchema = z.strictObject({
  id: z.string({ error: "esperado o identificador do modelo (texto)" }).min(1),
  provider: z.string({ error: 'esperado o id de um provedor de "providers"' }).min(1),
  contextWindow: positiveInt,
  maxOutputTokens: positiveInt,
  pricing: z.exactOptional(pricingSchema),
  supportsForcedToolChoice: z.exactOptional(z.boolean()),
  /**
   * The native tool search this model supports, declared here and never guessed from the id:
   * `true` or `"bm25"` (the provider ranks by words), `"regex"` (the provider matches a pattern
   * the MODEL writes at run time), `"client"` (the harness searches and names the tools to load).
   * Absent or `false`: the harness uses its own index and the `search_tools`/`use_tool` pair.
   * Only a provider whose adapter implements the variant honours it.
   */
  nativeToolSearch: z.exactOptional(z.union([z.boolean(), z.enum(["bm25", "regex", "client"])])),
});

/** The hosts the bots' machines may reach out of the box: the package registries, by exact name. */
export const DEFAULT_ALLOWED_HOSTS: readonly string[] = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
];
export const DEFAULT_NETWORK_NAME = "suup-sandbox-net";
export const DEFAULT_CONNECTOR_IMAGE = "suup-connector-runner:dev";

const memorySize = z.string().regex(/^[1-9][0-9]*[bkmg]?$/i, 'ex.: "2g" ou "512m"');

/** A host name of the allowlist, stored in its normal form (lower case, no trailing dot). */
const hostEntry = z
  .string({ error: "esperado um nome de host (texto)" })
  .transform((value, ctx) => {
    const parsed = parseAllowlistHost(value);
    if (!parsed.ok) {
      ctx.addIssue({ code: "custom", message: parsed.message });
      return z.NEVER;
    }
    return parsed.host;
  });

/**
 * The network of the bots' machines (docker sandbox). The container has no route of its own: it
 * reaches the internet only through a proxy of the harness, to the exact host names listed here
 * (global defaults) plus the ones added per bot. See docs/REDE.md.
 */
const networkSchema = z.strictObject({
  /** Name of the internal Docker network the machine and the connector containers join. */
  name: z.exactOptional(z.string().min(1)),
  /** Exact host names every bot may reach. Default: the package registries (`DEFAULT_ALLOWED_HOSTS`). `[]`: none. */
  defaultHosts: z.exactOptional(z.array(hostEntry).max(100)),
  /** Ports the proxy lets through. Default 80 and 443. */
  ports: z.exactOptional(z.array(z.number().int().min(1).max(65535)).min(1).max(10)),
  proxy: z.exactOptional(
    z.strictObject({
      /** Where the proxy listens. Default: the host's address on the internal network. */
      listenHost: z.exactOptional(z.string().min(1)),
      /** The address written into the machines' proxy settings. Default: `listenHost`. */
      advertiseHost: z.exactOptional(z.string().min(1)),
      /** Default: any free port. */
      port: z.exactOptional(z.number().int().min(0).max(65535)),
    }),
  ),
});

const sandboxSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("docker"),
      image: z.string().min(1),
      name: z.string().min(1),
      volume: z.string().min(1),
      memory: z.exactOptional(memorySize),
      cpus: z.exactOptional(z.number().positive()),
      network: z.exactOptional(networkSchema),
      /**
       * OPTIONAL, off by default: absolute path of a CA bundle (PEM) of the host, mounted read-only
       * into the bots' machine and the connector containers, with the variables the common clients
       * read. For networks whose proxy re-signs TLS. No CA is ever baked into an image. See
       * docs/REDE.md.
       */
      extraCaBundle: z.exactOptional(
        z
          .string()
          .min(1)
          .refine(
            (path) => isAbsolute(path),
            "esperado um caminho absoluto (ex.: /etc/ssl/corp-ca.pem)",
          ),
      ),
      /** Where stdio connectors run: a container of this image, on the same internal network. */
      connectors: z.exactOptional(
        z.strictObject({
          image: z.exactOptional(z.string().min(1)),
          memory: z.exactOptional(memorySize),
          cpus: z.exactOptional(z.number().positive()),
        }),
      ),
    }),
    z.strictObject({ kind: z.literal("local"), root: z.string().min(1) }),
  ],
  { error: orMissing('tipo de sandbox inválido: use "docker" ou "local"') },
);

const workerSchema = z.strictObject({
  concurrency: z.exactOptional(positiveInt),
  leaseRenewMs: z.exactOptional(z.number().positive()),
  staleAfterMs: z.exactOptional(z.number().positive()),
  /** How often a running run is checked for a pause or interrupt asked for by the server. */
  controlPollMs: z.exactOptional(z.number().positive()),
});

/** A browser origin: scheme, host and optional port, nothing else (no path, no trailing slash). */
const ORIGIN = /^[a-z][a-z0-9+.-]*:\/\/[^/\s?#@]+$/i;
const originSchema = z
  .string({ error: orMissing("esperado uma origem (texto), por exemplo http://localhost:1420") })
  .regex(
    ORIGIN,
    "origem inválida: use só esquema, host e porta, sem barra no fim nem caminho (ex.: http://localhost:1420 ou tauri://localhost)",
  );

const serverSchema = z.strictObject({
  /** Interface to listen on. Default `127.0.0.1`; anything else must be asked for here. */
  host: z.exactOptional(z.string().min(1)),
  port: z.exactOptional(z.number().int().min(0).max(65535)),
  /** Browser origins allowed to call the API (CORS). Empty: no browser origin is allowed. */
  allowedOrigins: z.exactOptional(z.array(originSchema)),
  /** NAME of the environment variable that holds the bearer token (never the token itself). */
  tokenEnv: z.exactOptional(envName),
  /** Most concurrent realtime streams (SSE). */
  maxStreams: z.exactOptional(positiveInt),
  /** Largest request body accepted, in bytes. */
  maxBodyBytes: z.exactOptional(positiveInt),
  /** How long the realtime change log is kept (minutes): the window `Last-Event-ID` can resume from. */
  eventRetentionMinutes: z.exactOptional(positiveInt),
});

/** True for a name the runtime's time zone database knows (`Intl` is the judge, no pattern). */
export function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * The user's time zone written in the configuration (`defaults.timeZone`), or `undefined`. There is
 * NO fallback to the zone of the computer the server runs on: the server may be a VPS in UTC or in
 * another country, and the user's times would silently be wrong (the owner's rule). The runtime
 * reads the zone the user chose or the app sent (`user_settings`) first; see `Runtime.userTimeZone`.
 */
export function configuredTimeZone(config: {
  defaults?: { timeZone?: string };
}): string | undefined {
  const configured = config.defaults?.timeZone;
  return configured !== undefined && isTimeZone(configured) ? configured : undefined;
}

const defaultsSchema = z.strictObject({
  maxTurns: z.exactOptional(positiveInt),
  maxCostUsd: z.exactOptional(z.number().positive()),
  maxDurationMs: z.exactOptional(positiveInt),
  /**
   * How many returns in a row one run may schedule for itself (`schedule_return`) before the tool
   * refuses and the bot must finish or ask the user. Default 6. 0 turns the returns off.
   */
  maxReturns: z.exactOptional(z.number().int().nonnegative()),
  /**
   * How many characters of the earlier messages of a conversation a run gets as history (whole
   * messages, newest first). Older ones are found with `search_conversations`.
   */
  historyChars: z.exactOptional(positiveInt),
  /**
   * The user's time zone, an IANA name (`America/Sao_Paulo`). It is what "now" means to the bots:
   * the date and time in their prompt and in the reminder of each turn. The zone the user chose in
   * the app (or the app sent from the user's computer) comes first; this is the fallback when
   * neither said one. Never the server's own zone (see `configuredTimeZone`).
   */
  timeZone: z.exactOptional(
    z.string().refine(isTimeZone, "não é um fuso horário IANA (por exemplo America/Sao_Paulo)"),
  ),
});

const riskLevelEnum = z.enum(["read", "write_reversible", "external_irreversible"]);

const vaultSchema = z.strictObject({
  /**
   * NAME of the environment variable that holds the master key (32 bytes, base64 or hex). The key
   * itself never goes in the file or the database; generate one with `suup vault key generate`.
   */
  keyEnv: z.exactOptional(envName),
  /**
   * NAMES of variables holding older master keys, so values written with them can still be read
   * and re-encrypted (`suup vault rotate`).
   */
  previousKeyEnvs: z.exactOptional(z.array(envName).max(8)),
});

const approvalsSchema = z.strictObject({
  /**
   * Pending approval cards expire after this many minutes (the run is told, and goes on). Absent:
   * a card waits for ever; nothing times out silently.
   */
  expireAfterMinutes: z.exactOptional(positiveInt),
  /**
   * A risk level fixed for a tool, over what the tool declares: e.g. `{ "shell":
   * "external_irreversible" }` makes every shell command ask, even in the isolated machine.
   */
  levels: z.exactOptional(z.record(z.string().min(1), riskLevelEnum)),
  /**
   * The model that reviews each call in "Auto-review" mode, reading the rules the user wrote
   * (docs/APROVACOES.md). `model` absent: the model of `reviewer`. Without either, the mode falls
   * back to the table of risk levels and the app is told so.
   */
  autoReview: z.exactOptional(
    z.strictObject({
      model: z.exactOptional(z.string().min(1)),
      /**
       * `false` turns the model reviewer off in this configuration: "Auto-review" then applies the
       * table of risk levels, and the app is told why. Default `true`.
       */
      enabled: z.exactOptional(z.boolean()),
    }),
  ),
});

/**
 * The memory settings that are NOT the user's to change in the app: which model consolidates the
 * conversations in the background (docs/MEMORIA.md). Everything the user chooses (when it runs, how
 * much goes into the prompt, expiry, the compaction point) lives in the database
 * (`GET`/`PATCH /v1/memory-settings`).
 */
const memoryConfigSchema = z.strictObject({
  consolidation: z.exactOptional(
    z.strictObject({
      /** A model of `models`. Absent: the model of `approvals.autoReview`, else the one of `reviewer`. */
      model: z.exactOptional(z.string().min(1)),
      /** `false` turns the background consolidation off in this configuration. Default `true`. */
      enabled: z.exactOptional(z.boolean()),
    }),
  ),
});

/** A language code of a search engine host (`en`, `pt`, `pt-br`): letters, digits and hyphens, no dots. */
function isLanguageCode(code: string): boolean {
  if (code.length < 2 || code.length > 10 || code.startsWith("-") || code.endsWith("-"))
    return false;
  for (const ch of code) {
    const ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-";
    if (!ok) return false;
  }
  return true;
}

/** An absolute http(s) URL (the scheme is compared, not matched). */
const httpUrl = z.string().refine((text) => {
  try {
    const { protocol } = new URL(text);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}, "esperado uma URL http(s) completa");

/**
 * Search and page reading for the bots, built from open-source parts that Suup runs itself
 * (docs/BUSCA.md): no provider account, no key. Everything is optional; the defaults are the safe
 * list of engines and a reader that respects robots.txt.
 */
const webSchema = z.strictObject({
  search: z.exactOptional(
    z.strictObject({
      /** `false` turns `web_search` off (the tool then says it is not available). Default `true`. */
      enabled: z.exactOptional(z.boolean()),
      /**
       * The engines, by id (docs/BUSCA.md lists them). Default: the ones with a documented public API
       * that Suup asks itself, with its honest user agent (`wikipedia`, `arxiv`, `stackoverflow`), plus
       * `duckduckgo`, the one general web engine turned on by decision of the project owner (asked by
       * the SearXNG container; low rate, honest user agent; it reads a result page and may answer with
       * a captcha). `brave` and `startpage` also read result pages (through SearXNG) and are OFF until
       * you turn them on; Google and Bing do not exist here. GitHub is not a web search engine: its
       * search is the GitHub MCP connector's.
       */
      engines: z.exactOptional(z.array(z.string().min(1)).min(1).max(20)),
      /** Languages whose Wikipedia host the search container may reach. Default `["en", "pt"]`. */
      languages: z.exactOptional(
        z
          .array(
            z.string().refine(isLanguageCode, "código de idioma inválido (ex.: en, pt, pt-br)"),
          )
          .min(1)
          .max(10),
      ),
      /** Use a SearXNG instance you run yourself, at this URL, instead of the container Suup starts. */
      url: z.exactOptional(httpUrl),
      /** Most results one search returns (1 to 20). Default 10. */
      maxResults: z.exactOptional(z.number().int().min(1).max(20)),
      /**
       * Suup's own politeness toward the engines (docs/BUSCA.md, "Busca educada"). Searches over the
       * limit wait a little in a queue, or the tool answers when to try again.
       */
      limits: z.exactOptional(
        z.strictObject({
          /** Searches in any minute, overall. Default 20. */
          perMinute: z.exactOptional(z.number().int().min(1).max(600)),
          /** Searches in any minute to one engine, by id. The default of each engine is in the engine list (DuckDuckGo: 6). */
          perEngine: z.exactOptional(z.record(z.string().min(1), z.number().int().min(1).max(600))),
          /** The most a search waits in the queue, in seconds, before it is refused with the time to try again. Default 20. */
          maxWaitSeconds: z.exactOptional(z.number().int().min(0).max(120)),
        }),
      ),
      /** The cache of searches: an identical search is answered from it, and the answer says so. */
      cache: z.exactOptional(
        z.strictObject({
          /** `false` turns the cache off. Default `true`. */
          enabled: z.exactOptional(z.boolean()),
          /** How long a cached search lives, in minutes (1 to 10080). Default 180 (3 hours). */
          ttlMinutes: z.exactOptional(z.number().int().min(1).max(10_080)),
        }),
      ),
      /** The SearXNG image. Default: the version pinned in the code. */
      image: z.exactOptional(z.string().min(1)),
      /** The internal network of the search container. Default `suup-search-net`. */
      network: z.exactOptional(z.string().min(1)),
      /** Where the engine proxy listens on that network (needed when the worker runs in a container). */
      proxy: z.exactOptional(
        z.strictObject({
          listenHost: z.exactOptional(z.string().min(1)),
          advertiseHost: z.exactOptional(z.string().min(1)),
          port: z.exactOptional(z.number().int().min(1).max(65535)),
        }),
      ),
    }),
  ),
  reader: z.exactOptional(
    z.strictObject({
      /**
       * `false`: `web_read` does not use the reader service; it reads with the bot's own machine,
       * through its allowlist, with the approval cards that means. Default `true`.
       */
      enabled: z.exactOptional(z.boolean()),
      /** Allow `render: true` (a headless browser in the reader container). Default `true`. */
      render: z.exactOptional(z.boolean()),
      /** The reader image. Default `suup-reader:dev`. */
      image: z.exactOptional(z.string().min(1)),
      /** Where the user agent points (`SuupBot/<version> (+<this>)`). */
      repositoryUrl: z.exactOptional(httpUrl),
    }),
  ),
});

const toolSearchSchema = z.strictObject({
  /** Defer the connector tools of a bot when it has at least this many (default 10)... */
  minTools: z.exactOptional(positiveInt),
  /** ...or when their definitions are estimated at this many tokens or more (default 10000). */
  minDefinitionTokens: z.exactOptional(positiveInt),
  /** An index longer than this many characters is shown as one line per connector (default 6000). */
  maxIndexChars: z.exactOptional(positiveInt),
});

export const configSchema = z
  .strictObject({
    databaseUrl: z.exactOptional(z.string().min(1)),
    providers: z.array(providerSchema).min(1, "configure pelo menos um provedor"),
    models: z.array(modelSchema).min(1, "configure pelo menos um modelo"),
    reviewer: z.exactOptional(z.strictObject({ model: z.string().min(1) })),
    sandbox: sandboxSchema,
    worker: z.exactOptional(workerSchema),
    server: z.exactOptional(serverSchema),
    defaults: z.exactOptional(defaultsSchema),
    /**
     * Tools whose output is labelled as untrusted data for the model, besides the ones that
     * declare it themselves (`web_fetch`). Typical choice: `["shell", "read_file", "search_files"]`
     * when the bot handles content from outside. Off by default: it changes what the model reads
     * after every call of those tools.
     */
    untrustedOutputTools: z.exactOptional(z.array(z.string().min(1)).max(50)),
    vault: z.exactOptional(vaultSchema),
    approvals: z.exactOptional(approvalsSchema),
    memory: z.exactOptional(memoryConfigSchema),
    /** When the connector tools of a bot are searched instead of all loaded (docs/CONFIGURACAO.md). */
    toolSearch: z.exactOptional(toolSearchSchema),
    /** Web search and page reading (docs/BUSCA.md). */
    web: z.exactOptional(webSchema),
  })
  .superRefine((config, ctx) => {
    const providerIds = new Set<string>();
    config.providers.forEach((provider, i) => {
      if (providerIds.has(provider.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["providers", i, "id"],
          message: `id de provedor repetido: "${provider.id}"`,
        });
      }
      providerIds.add(provider.id);
    });
    const modelIds = new Set<string>();
    config.models.forEach((model, i) => {
      if (modelIds.has(model.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["models", i, "id"],
          message: `id de modelo repetido: "${model.id}"`,
        });
      }
      modelIds.add(model.id);
      if (!providerIds.has(model.provider)) {
        ctx.addIssue({
          code: "custom",
          path: ["models", i, "provider"],
          message: `provedor "${model.provider}" não existe em "providers" (existentes: ${[...providerIds].join(", ")})`,
        });
      }
      if (model.maxOutputTokens > model.contextWindow) {
        ctx.addIssue({
          code: "custom",
          path: ["models", i, "maxOutputTokens"],
          message: "não pode ser maior que contextWindow",
        });
      }
    });
    if (config.reviewer !== undefined && !modelIds.has(config.reviewer.model)) {
      ctx.addIssue({
        code: "custom",
        path: ["reviewer", "model"],
        message: `modelo "${config.reviewer.model}" não existe em "models" (existentes: ${[...modelIds].join(", ")})`,
      });
    }
    const autoReviewModel = config.approvals?.autoReview?.model;
    if (autoReviewModel !== undefined && !modelIds.has(autoReviewModel)) {
      ctx.addIssue({
        code: "custom",
        path: ["approvals", "autoReview", "model"],
        message: `modelo "${autoReviewModel}" não existe em "models" (existentes: ${[...modelIds].join(", ")})`,
      });
    }
    const consolidationModel = config.memory?.consolidation?.model;
    if (consolidationModel !== undefined && !modelIds.has(consolidationModel)) {
      ctx.addIssue({
        code: "custom",
        path: ["memory", "consolidation", "model"],
        message: `modelo "${consolidationModel}" não existe em "models" (existentes: ${[...modelIds].join(", ")})`,
      });
    }
    const wrongEngines = unknownEngines(config.web?.search?.engines ?? DEFAULT_ENGINES);
    if (wrongEngines.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["web", "search", "engines"],
        message: `motor desconhecido: ${wrongEngines.join(", ")} (use os ids de docs/BUSCA.md)`,
      });
    }
    const wrongLimits = unknownEngines(Object.keys(config.web?.search?.limits?.perEngine ?? {}));
    if (wrongLimits.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["web", "search", "limits", "perEngine"],
        message: `motor desconhecido: ${wrongLimits.join(", ")} (use os ids de docs/BUSCA.md)`,
      });
    }
    const renew = config.worker?.leaseRenewMs ?? DEFAULT_WORKER.leaseRenewMs;
    const stale = config.worker?.staleAfterMs ?? DEFAULT_WORKER.staleAfterMs;
    if (stale <= renew) {
      ctx.addIssue({
        code: "custom",
        path: ["worker", "staleAfterMs"],
        message: `deve ser maior que leaseRenewMs (${renew})`,
      });
    }
  });

export type RuntimeConfig = z.infer<typeof configSchema>;
export type ProviderEntry = RuntimeConfig["providers"][number];
export type ModelEntry = RuntimeConfig["models"][number];
export type SandboxEntry = RuntimeConfig["sandbox"];
export type ServerConfig = NonNullable<RuntimeConfig["server"]>;

export const DEFAULT_WORKER = {
  concurrency: 4,
  leaseRenewMs: 10_000,
  staleAfterMs: 30_000,
  controlPollMs: 2_000,
};
/** Where the server listens when the configuration does not say: this computer only. */
export const DEFAULT_SERVER = {
  host: "127.0.0.1",
  port: 8787,
  tokenEnv: "SUUP_SERVER_TOKEN",
  maxStreams: 16,
  maxBodyBytes: 1_048_576,
  eventRetentionMinutes: 360,
};
/** The turn limit of a bot that sets none, when the configuration does not set one either. */
export const DEFAULT_MAX_TURNS = 50;

type Env = Record<string, string | undefined>;

/** Turns a zod error into one readable Portuguese line per problem. */
export function describeIssues(error: z.ZodError): string[] {
  const lines: string[] = [];
  const walk = (issues: readonly z.core.$ZodIssue[], prefix: (string | number)[]) => {
    for (const issue of issues) {
      const path = [...prefix, ...issue.path.map((p) => (typeof p === "symbol" ? String(p) : p))];
      lines.push(`${renderPath(path)}: ${describeIssue(issue, path)}`);
    }
  };
  walk(error.issues, []);
  return lines;
}

function renderPath(path: readonly (string | number)[]): string {
  if (path.length === 0) return "(arquivo)";
  return path.map((p, i) => (typeof p === "number" ? `[${p}]` : i === 0 ? p : `.${p}`)).join("");
}

const SECRET_KEYS = new Set(["apiKey", "api_key", "apikey", "key", "token", "secret", "password"]);

function describeIssue(issue: z.core.$ZodIssue, path: readonly (string | number)[] = []): string {
  switch (issue.code) {
    case "invalid_type": {
      const match = /^Invalid input: expected (\w+), received (\w+)/.exec(issue.message);
      if (match === null) return issue.message; // a message written in the schema
      const [, expected = "", received = ""] = match;
      return received === "undefined"
        ? `campo obrigatório ausente (esperado ${typeNamePt(expected)})`
        : `esperado ${typeNamePt(expected)}, recebido ${typeNamePt(received)}`;
    }
    case "unrecognized_keys": {
      const keys = issue.keys;
      const secret = keys.find((k) => SECRET_KEYS.has(k));
      if (secret !== undefined && path[0] === "server") {
        return `"${secret}" não é aceito: o token do servidor nunca fica no arquivo. Use "tokenEnv" com o NOME da variável de ambiente que guarda o token (gere um token com: suup server --generate-token)`;
      }
      if (secret !== undefined && path[0] === "vault") {
        return `"${secret}" não é aceito: a chave do cofre nunca fica no arquivo. Use "keyEnv" com o NOME da variável de ambiente que guarda a chave (gere uma com: suup vault key generate)`;
      }
      if (secret !== undefined) {
        return `"${secret}" não é aceito: chaves de API nunca ficam no arquivo. Use "apiKeyEnv" com o NOME da variável de ambiente que guarda a chave`;
      }
      return `campo${keys.length > 1 ? "s" : ""} desconhecido${keys.length > 1 ? "s" : ""}: ${keys.map((k) => `"${k}"`).join(", ")}`;
    }
    case "invalid_value":
      return `valor inválido; opções: ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`;
    case "too_small":
      return issue.origin === "array" || issue.origin === "string"
        ? issue.message
        : `deve ser ${issue.inclusive ? "no mínimo" : "maior que"} ${String(issue.minimum)}`;
    case "too_big":
      return `deve ser ${issue.inclusive ? "no máximo" : "menor que"} ${String(issue.maximum)}`;
    case "invalid_union":
      return issue.message;
    default:
      return issue.message;
  }
}

function typeNamePt(name: string): string {
  const names: Record<string, string> = {
    string: "texto",
    number: "número",
    int: "número inteiro",
    boolean: "verdadeiro/falso",
    object: "objeto",
    array: "lista",
    undefined: "nada",
    null: "null",
  };
  return names[name] ?? name;
}

/** Validates an already parsed JSON document. Throws `ConfigError` with Portuguese issues. */
export function parseConfig(raw: unknown, source = DEFAULT_CONFIG_FILE): RuntimeConfig {
  const result = configSchema.safeParse(raw);
  if (result.success) return result.data;
  const issues = describeIssues(result.error);
  throw new ConfigError(
    `Configuração inválida em ${source}:\n${issues.map((i) => `  - ${i}`).join("\n")}`,
    issues,
    source,
  );
}

export interface LoadConfigOptions {
  /** `--config`. Wins over `SUUP_CONFIG`. */
  path?: string | undefined;
  env?: Env;
  cwd?: string;
}

export interface LoadedConfig {
  config: RuntimeConfig;
  /** Absolute path of the file that was read. */
  path: string;
  /** Directory of the file: relative paths inside it (sandbox root, scripts) start here. */
  baseDir: string;
}

/** Where the configuration file is: `--config`, then `SUUP_CONFIG`, then `./suup.config.json`. */
export function configPath(options: LoadConfigOptions = {}): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  return resolve(cwd, options.path ?? env.SUUP_CONFIG ?? DEFAULT_CONFIG_FILE);
}

/** Reads and validates the configuration file. Throws `ConfigError` (message in Portuguese). */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const path = configPath(options);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new ConfigError(
      code === "ENOENT"
        ? `Arquivo de configuração não encontrado: ${path}\nCopie suup.config.example.json para suup.config.json e ajuste (veja docs/CONFIGURACAO.md), ou indique outro arquivo com --config ou SUUP_CONFIG.`
        : `Não foi possível ler o arquivo de configuração ${path}: ${(error as Error).message}`,
      [],
      path,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `O arquivo de configuração ${path} não é um JSON válido: ${(error as Error).message}`,
      [],
      path,
    );
  }
  return { config: parseConfig(raw, path), path, baseDir: dirname(path) };
}

/** The database URL: `DATABASE_URL` from the environment wins over the file. */
export function resolveDatabaseUrl(
  config: RuntimeConfig,
  env: Env = process.env,
): string | undefined {
  const fromEnv = env.DATABASE_URL;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return config.databaseUrl;
}
