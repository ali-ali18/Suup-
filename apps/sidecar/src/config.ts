import type { Isolation } from "./protocol.js";

/** The models the app starts with (docs/TESTES-REAIS.md has where the ids, windows and prices come from). */
const MODELS = [
  {
    id: "claude-sonnet-5-5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    // The reviewer asks for a forced tool; this model answers that with a 400, so it is told by instruction.
    supportsForcedToolChoice: false,
    pricing: {
      inputPerMTok: 2,
      outputPerMTok: 10,
      cachedInputPerMTok: 0.1,
      cacheWriteInputPerMTok: 2.5,
    },
  },
  {
    id: "claude-haiku-5-5",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: {
      inputPerMTok: 0.1,
      outputPerMTok: 0.5,
      cachedInputPerMTok: 0.01,
      cacheWriteInputPerMTok: 0.125,
    },
  },
] as const;

export interface ConfigInput {
  isolation: Isolation;
  /** The folder the bots work in when they are not isolated. */
  workspace: string;
  images: { sandbox: string; connectors: string; egress: string };
  /** Where the bots' proxy runs (`chooseIsolation` decided it). */
  egress: "container" | "process" | null;
  networkName: string;
  /** The origins of the app's webview (the Rust side sends none; kept for the browser build). */
  allowedOrigins: readonly string[];
}

/**
 * The configuration file of the embedded server (docs/CONFIGURACAO.md). It holds the NAMES of the
 * variables with the secrets (`apiKeyEnv`, `tokenEnv`, `keyEnv`), never the secrets.
 */
export function buildConfig(input: ConfigInput): Record<string, unknown> {
  const sandbox =
    input.isolation.mode === "docker"
      ? {
          kind: "docker",
          image: input.images.sandbox,
          name: "suup-machine",
          volume: "suup-workspace",
          memory: "2g",
          cpus: 2,
          network: {
            name: input.networkName,
            defaultHosts: ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org"],
            ...(input.egress === "container"
              ? { proxy: { mode: "container", image: input.images.egress } }
              : {}),
          },
          connectors: { image: input.images.connectors },
        }
      : { kind: "local", root: input.workspace };
  return {
    providers: [{ id: "anthropic", kind: "anthropic", apiKeyEnv: "ANTHROPIC_API_KEY" }],
    models: MODELS,
    reviewer: { model: "claude-haiku-5-5" },
    memory: { consolidation: { model: "claude-haiku-5-5" } },
    sandbox,
    worker: { concurrency: 4 },
    defaults: { maxTurns: 50, maxCostUsd: 2, maxDurationMs: 1_800_000 },
    vault: { keyEnv: "SUUP_VAULT_KEY" },
    server: {
      host: "127.0.0.1",
      allowedOrigins: [...input.allowedOrigins],
      tokenEnv: "SUUP_SERVER_TOKEN",
    },
  };
}
