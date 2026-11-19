import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseAllowlistHost } from "@suup/core";
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

const defaultsSchema = z.strictObject({
  maxTurns: z.exactOptional(positiveInt),
  maxCostUsd: z.exactOptional(z.number().positive()),
  maxDurationMs: z.exactOptional(positiveInt),
  /**
   * How many characters of the earlier messages of a conversation a run gets as history (whole
   * messages, newest first). Older ones are found with `search_conversations`.
   */
  historyChars: z.exactOptional(positiveInt),
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
