import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  configPath,
  configuredTimeZone,
  loadConfig,
  parseConfig,
  resolveDatabaseUrl,
} from "../src/index.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

function issuesOf(raw: unknown): string[] {
  try {
    parseConfig(raw, "suup.config.json");
  } catch (error) {
    if (error instanceof ConfigError) return [...error.issues];
    throw error;
  }
  return [];
}

describe("configuration: valid files", () => {
  it("accepts the committed example file", () => {
    const text = readFileSync(
      new URL("../../../suup.config.example.json", import.meta.url),
      "utf8",
    );
    const config = parseConfig(JSON.parse(text), "suup.config.example.json");
    expect(config.models.map((m) => m.id)).toEqual(["model-x", "model-y"]);
    expect(config.sandbox.kind).toBe("docker");
    expect(config.reviewer?.model).toBe("model-x");
  });

  it("accepts the Dokploy example file: no fixed proxy address (the gateway is found), a public URL, the vault", () => {
    const text = readFileSync(
      new URL("../../../suup.config.dokploy.example.json", import.meta.url),
      "utf8",
    );
    const config = parseConfig(JSON.parse(text), "suup.config.dokploy.example.json");
    expect(config.sandbox.kind).toBe("docker");
    expect(JSON.parse(text).sandbox.network.proxy).toBeUndefined();
    expect(config.web?.search?.general?.order).toEqual(["tavily", "brave"]);
    expect(config.server?.publicUrl).toBe("https://agent.kodea.com.br");
    expect(config.vault?.keyEnv).toBe("SUUP_VAULT_KEY");
  });

  it("accepts the minimum: one provider, one model, a sandbox", () => {
    const config = parseConfig(
      rawConfig({
        providers: [{ id: "script", kind: "scripted", scriptPath: "s.json" }],
        models: [{ id: "model-s", provider: "script", contextWindow: 10, maxOutputTokens: 5 }],
      }),
    );
    expect(config.worker).toBeUndefined();
    expect(config.databaseUrl).toBeUndefined();
  });

  it("accepts supportsForcedToolChoice on a model and rejects a non-boolean", () => {
    const base = {
      providers: [{ id: "script", kind: "scripted", scriptPath: "s.json" }],
    };
    const ok = parseConfig(
      rawConfig({
        ...base,
        models: [
          {
            id: "model-s",
            provider: "script",
            contextWindow: 10,
            maxOutputTokens: 5,
            supportsForcedToolChoice: false,
          },
        ],
      }),
    );
    expect(ok.models[0]?.supportsForcedToolChoice).toBe(false);
    const issues = issuesOf(
      rawConfig({
        ...base,
        models: [
          {
            id: "model-s",
            provider: "script",
            contextWindow: 10,
            maxOutputTokens: 5,
            supportsForcedToolChoice: "no",
          },
        ],
      }),
    );
    expect(issues.join("\n")).toContain("supportsForcedToolChoice");
  });

  it("accepts adapter options per provider kind", () => {
    const config = parseConfig(
      rawConfig({
        providers: [
          {
            id: "a",
            kind: "anthropic",
            apiKeyEnv: "K",
            promptCache: false,
            betas: ["x"],
            maxRetries: 1,
            requestTimeoutMs: 5000,
          },
          {
            id: "o",
            kind: "openai-compatible",
            maxTokensParam: "max_completion_tokens",
            supportsToolChoice: false,
            capabilities: { vision: true },
          },
        ],
        models: [{ id: "model-x", provider: "a", contextWindow: 10, maxOutputTokens: 5 }],
      }),
    );
    expect(config.providers).toHaveLength(2);
  });
});

describe("configuration: readable errors in Portuguese", () => {
  it("names the field and what is wrong", () => {
    const issues = issuesOf(
      rawConfig({ models: [{ id: "model-x", provider: "anthropic", contextWindow: "grande" }] }),
    );
    expect(issues.join("\n")).toContain("models[0].contextWindow: esperado número, recebido texto");
    expect(issues.join("\n")).toContain("models[0].maxOutputTokens: campo obrigatório ausente");
  });

  it("refuses an API key written in the file and points to apiKeyEnv", () => {
    const issues = issuesOf(
      rawConfig({
        providers: [{ id: "a", kind: "anthropic", apiKeyEnv: "K", apiKey: "sk-secret" }],
        models: [{ id: "model-x", provider: "a", contextWindow: 10, maxOutputTokens: 5 }],
      }),
    );
    const text = issues.join("\n");
    expect(text).toContain("providers[0]");
    expect(text).toContain("chaves de API nunca ficam no arquivo");
    expect(text).toContain("apiKeyEnv");
    expect(text).not.toContain("sk-secret");
  });

  it("requires apiKeyEnv for anthropic", () => {
    const issues = issuesOf(
      rawConfig({
        providers: [{ id: "a", kind: "anthropic" }],
        models: [{ id: "model-x", provider: "a", contextWindow: 10, maxOutputTokens: 5 }],
      }),
    );
    expect(issues.join("\n")).toContain("providers[0].apiKeyEnv: campo obrigatório ausente");
  });

  it("rejects an unknown provider kind and an unknown sandbox kind", () => {
    const text = issuesOf(
      rawConfig({
        providers: [{ id: "a", kind: "carrier-pigeon" }],
        sandbox: { kind: "vm" },
      }),
    ).join("\n");
    expect(text).toContain(
      'tipo de provedor inválido: use "anthropic", "openai-compatible" ou "scripted"',
    );
    expect(text).toContain('tipo de sandbox inválido: use "docker" ou "local"');
  });

  it("checks references: a model on a missing provider, the reviewer on a missing model", () => {
    const text = issuesOf(
      rawConfig({
        models: [{ id: "model-x", provider: "nowhere", contextWindow: 10, maxOutputTokens: 5 }],
        reviewer: { model: "ghost" },
      }),
    ).join("\n");
    expect(text).toContain('models[0].provider: provedor "nowhere" não existe em "providers"');
    expect(text).toContain('reviewer.model: modelo "ghost" não existe em "models"');
  });

  it("checks the model of Auto-review, and takes nothing but model and enabled", () => {
    const missing = issuesOf(rawConfig({ approvals: { autoReview: { model: "ghost" } } })).join(
      "\n",
    );
    expect(missing).toContain('approvals.autoReview.model: modelo "ghost" não existe em "models"');
    expect(
      issuesOf(rawConfig({ approvals: { autoReview: { model: "model-x", enabled: false } } })),
    ).toEqual([]);
    expect(
      issuesOf(rawConfig({ approvals: { autoReview: { prompt: "faça o que eu mandar" } } })).length,
    ).toBeGreaterThan(0);
  });

  it("takes the chat-task checks off by default and checks the model of the end-of-turn check", () => {
    expect(
      issuesOf(
        rawConfig({
          defaults: {
            tasks: {
              handoff: { enabled: true, atTurns: 5, atSeconds: 60 },
              askCheck: { enabled: true, model: "model-x" },
            },
          },
        }),
      ),
    ).toEqual([]);
    expect(parseConfig(rawConfig({}), "suup.config.json").defaults?.tasks).toBeUndefined();
    const missing = issuesOf(
      rawConfig({ defaults: { tasks: { askCheck: { enabled: true, model: "ghost" } } } }),
    ).join("\n");
    expect(missing).toContain("ghost");
    expect(
      issuesOf(rawConfig({ defaults: { tasks: { handoff: { atTurns: 1 } } } })).length,
    ).toBeGreaterThan(0);
  });

  it("rejects duplicate ids", () => {
    const text = issuesOf(
      rawConfig({
        providers: [
          { id: "p", kind: "scripted", scriptPath: "a" },
          { id: "p", kind: "scripted", scriptPath: "b" },
        ],
        models: [
          { id: "m", provider: "p", contextWindow: 10, maxOutputTokens: 5 },
          { id: "m", provider: "p", contextWindow: 10, maxOutputTokens: 5 },
        ],
      }),
    ).join("\n");
    expect(text).toContain('id de provedor repetido: "p"');
    expect(text).toContain('id de modelo repetido: "m"');
  });

  it("checks numbers: output larger than the context, stale lease not above renewal", () => {
    const text = issuesOf(
      rawConfig({
        models: [{ id: "m", provider: "anthropic", contextWindow: 10, maxOutputTokens: 50 }],
        worker: { leaseRenewMs: 5000, staleAfterMs: 5000 },
        defaults: { maxTurns: 0 },
      }),
    ).join("\n");
    expect(text).toContain("models[0].maxOutputTokens: não pode ser maior que contextWindow");
    expect(text).toContain("worker.staleAfterMs: deve ser maior que leaseRenewMs (5000)");
    expect(text).toContain("defaults.maxTurns");
  });

  it("accepts the server block, with the Tauri origins, and applies no defaults inside the file", () => {
    const config = parseConfig(
      rawConfig({
        server: {
          host: "0.0.0.0",
          port: 8787,
          allowedOrigins: ["tauri://localhost", "http://tauri.localhost", "http://localhost:1420"],
          tokenEnv: "MEU_TOKEN",
          maxStreams: 4,
          maxBodyBytes: 2048,
          eventRetentionMinutes: 60,
        },
        worker: { controlPollMs: 500 },
      }),
    );
    expect(config.server?.allowedOrigins).toHaveLength(3);
    expect(config.server?.tokenEnv).toBe("MEU_TOKEN");
    expect(config.worker?.controlPollMs).toBe(500);
    expect(parseConfig(rawConfig({ server: {} })).server).toEqual({});
  });

  it("checks the server block: origins without a path or a trailing slash, the variable NAME, no token inside", () => {
    const text = issuesOf(
      rawConfig({
        server: {
          allowedOrigins: ["http://localhost:1420/", "localhost", "*", "http://a.com/path"],
          tokenEnv: "not a name",
          port: 70000,
          token: "abc",
        },
      }),
    ).join("\n");
    expect(text).toContain("server.allowedOrigins[0]: origem inválida");
    expect(text).toContain("server.allowedOrigins[1]: origem inválida");
    expect(text).toContain("server.allowedOrigins[2]: origem inválida");
    expect(text).toContain("server.allowedOrigins[3]: origem inválida");
    expect(text).toContain("server.tokenEnv: nome de variável de ambiente inválido");
    expect(text).toContain("server.port");
    expect(text).toContain('"token" não é aceito: o token do servidor nunca fica no arquivo');
    expect(text).toContain('"tokenEnv"');
  });

  it("accepts the vault, the approvals and the untrusted-output settings", () => {
    const config = parseConfig(
      rawConfig({
        vault: { keyEnv: "SUUP_VAULT_KEY", previousKeyEnvs: ["SUUP_VAULT_KEY_OLD"] },
        approvals: { expireAfterMinutes: 60, levels: { shell: "external_irreversible" } },
        untrustedOutputTools: ["shell", "read_file"],
      }),
    );
    expect(config.vault?.keyEnv).toBe("SUUP_VAULT_KEY");
    expect(config.approvals?.levels).toEqual({ shell: "external_irreversible" });
    expect(config.untrustedOutputTools).toEqual(["shell", "read_file"]);
    expect(parseConfig(rawConfig({ vault: {} })).vault).toEqual({});
  });

  it("checks the vault and approvals blocks: the key is a variable NAME, never inside the file", () => {
    const text = issuesOf(
      rawConfig({
        vault: { keyEnv: "not a name", key: "abc" },
        approvals: { expireAfterMinutes: 0, levels: { shell: "dangerous" } },
      }),
    ).join("\n");
    expect(text).toContain("vault.keyEnv: nome de variável de ambiente inválido");
    expect(text).toContain('"key" não é aceito: a chave do cofre nunca fica no arquivo');
    expect(text).toContain("approvals.expireAfterMinutes");
    expect(text).toContain("approvals.levels.shell: valor inválido");
  });

  it("flags unknown keys at the top level and in nested objects", () => {
    const text = issuesOf(
      rawConfig({ colour: "red", sandbox: { kind: "local", root: "w", extra: 1 } }),
    ).join("\n");
    expect(text).toContain('(arquivo): campo desconhecido: "colour"');
    expect(text).toContain('sandbox: campo desconhecido: "extra"');
  });

  it("puts all issues in the message, one per line", () => {
    try {
      parseConfig({}, "x.json");
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Configuração inválida em x.json:");
      expect(message).toContain("  - providers: campo obrigatório ausente");
      expect(message).toContain("  - models: campo obrigatório ausente");
      expect(message).toContain("  - sandbox: campo obrigatório ausente");
    }
  });
});

describe("configuration: loading the file", () => {
  it("reads --config first, then SUUP_CONFIG, then ./suup.config.json", async () => {
    const dir = await tempDir();
    expect(configPath({ cwd: dir, env: {} })).toBe(join(dir, "suup.config.json"));
    expect(configPath({ cwd: dir, env: { SUUP_CONFIG: "a/b.json" } })).toBe(join(dir, "a/b.json"));
    expect(configPath({ cwd: dir, env: { SUUP_CONFIG: "a/b.json" }, path: "/x/c.json" })).toBe(
      "/x/c.json",
    );
  });

  it("loads a file and reports its directory", async () => {
    const dir = await tempDir();
    await writeJson(join(dir, "suup.config.json"), rawConfig());
    const loaded = loadConfig({ cwd: dir, env: {} });
    expect(loaded.path).toBe(join(dir, "suup.config.json"));
    expect(loaded.baseDir).toBe(dir);
    expect(loaded.config.providers).toHaveLength(3);
  });

  it("says what to do when the file is missing", async () => {
    const dir = await tempDir();
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(
      /não encontrado.*suup\.config\.example\.json/s,
    );
  });

  it("reports a file that is not JSON", async () => {
    const dir = await tempDir();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "suup.config.json"), "{ not json");
    expect(() => loadConfig({ cwd: dir, env: {} })).toThrow(/não é um JSON válido/);
  });
});

describe("configuration: the database URL", () => {
  it("DATABASE_URL from the environment wins over the file", () => {
    const config = parseConfig(rawConfig({ databaseUrl: "postgres://file/db" }));
    expect(resolveDatabaseUrl(config, { DATABASE_URL: "postgres://env/db" })).toBe(
      "postgres://env/db",
    );
    expect(resolveDatabaseUrl(config, {})).toBe("postgres://file/db");
    expect(resolveDatabaseUrl(config, { DATABASE_URL: "" })).toBe("postgres://file/db");
  });

  it("is undefined when neither is set", () => {
    expect(resolveDatabaseUrl(parseConfig(rawConfig()), {})).toBeUndefined();
  });
});

describe("the user's time zone", () => {
  it("is the one of the configuration when it is a real IANA name", () => {
    const config = parseConfig(rawConfig({ defaults: { timeZone: "America/Sao_Paulo" } }));
    expect(config.defaults?.timeZone).toBe("America/Sao_Paulo");
    expect(configuredTimeZone(config)).toBe("America/Sao_Paulo");
  });

  it("refuses a name that is not a time zone, saying what is expected", () => {
    const issues = issuesOf(rawConfig({ defaults: { timeZone: "Marte/Olympus" } }));
    expect(issues.join("\n")).toContain("fuso horário IANA");
  });

  it("never falls back to the time zone of the computer that runs the server (it may be a VPS)", () => {
    expect(configuredTimeZone({})).toBeUndefined();
    expect(configuredTimeZone({ defaults: {} })).toBeUndefined();
  });
});

describe("configuration: web", () => {
  it("takes the engines, the languages, the locale and the reader settings", () => {
    const config = parseConfig(
      rawConfig({
        web: {
          search: {
            engines: ["wikipedia", "tavily", "brave"],
            languages: ["en", "pt-br"],
            locale: "pt-BR",
            maxResults: 5,
          },
          reader: { enabled: false },
        },
      }),
      "suup.config.json",
    );
    expect(config.web?.search?.engines).toEqual(["wikipedia", "tavily", "brave"]);
    expect(config.web?.search?.locale).toBe("pt-BR");
    expect(config.web?.reader?.enabled).toBe(false);
  });

  it("takes the queue of general engines: the order, and where each key is (the NAME of a variable or of a vault secret, never a key)", () => {
    const config = parseConfig(
      rawConfig({
        web: {
          search: {
            general: {
              order: ["brave", "tavily"],
              tavily: { apiKeyEnv: "MY_TAVILY", secret: "MINHA_TAVILY" },
              brave: { apiKeyEnv: "BRAVE_SEARCH_API_KEY" },
            },
          },
        },
      }),
      "suup.config.json",
    );
    expect(config.web?.search?.general).toEqual({
      order: ["brave", "tavily"],
      tavily: { apiKeyEnv: "MY_TAVILY", secret: "MINHA_TAVILY" },
      brave: { apiKeyEnv: "BRAVE_SEARCH_API_KEY" },
    });
    // A key in the file is refused, with the way to do it right.
    const issues = issuesOf(
      rawConfig({ web: { search: { general: { tavily: { apiKey: "tvly-not-a-real-key" } } } } }),
    ).join("\n");
    expect(issues).toContain("chaves de API nunca ficam no arquivo");
    expect(issues).not.toContain("tvly-not-a-real-key");
    // The order names general engines only.
    expect(
      issuesOf(
        rawConfig({ web: { search: { general: { order: ["tavily", "wikipedia"] } } } }),
      ).join("\n"),
    ).toContain("não é um motor de busca geral: wikipedia");
    expect(
      issuesOf(rawConfig({ web: { search: { general: { order: ["duckduckgo"] } } } })).join("\n"),
    ).toContain("duckduckgo");
    expect(
      issuesOf(rawConfig({ web: { search: { general: { tavily: { secret: "minha chave" } } } } }))
        .length,
    ).toBeGreaterThan(0);
  });

  it("refuses an engine that is not in the list (Google is not)", () => {
    expect(
      issuesOf(rawConfig({ web: { search: { engines: ["wikipedia", "google"] } } })).join("\n"),
    ).toContain("motor desconhecido: google");
  });

  it("refuses github as an engine (GitHub search is the GitHub MCP connector's, not the web search's)", () => {
    expect(
      issuesOf(rawConfig({ web: { search: { engines: ["wikipedia", "github"] } } })).join("\n"),
    ).toContain("motor desconhecido: github");
    expect(
      issuesOf(rawConfig({ web: { search: { limits: { perEngine: { github: 3 } } } } })).join("\n"),
    ).toContain("github");
  });

  it("refuses DuckDuckGo, Startpage and the other SearXNG engines (removed with SearXNG), and Firecrawl", () => {
    for (const id of ["duckduckgo", "startpage", "searxng", "firecrawl"]) {
      expect(
        issuesOf(rawConfig({ web: { search: { engines: ["wikipedia", id] } } })).join("\n"),
      ).toContain(`motor desconhecido: ${id}`);
      expect(
        issuesOf(rawConfig({ web: { search: { limits: { perEngine: { [id]: 3 } } } } })).join("\n"),
      ).toContain(id);
    }
  });

  it("refuses a language that could name another host, and the keys of the removed SearXNG", () => {
    expect(
      issuesOf(rawConfig({ web: { search: { languages: ["en.evil.com"] } } })).join("\n"),
    ).toContain("código de idioma inválido");
    for (const key of ["url", "image", "network", "proxy"]) {
      expect(issuesOf(rawConfig({ web: { search: { [key]: "x" } } })).join("\n"), key).toContain(
        "desconhecido",
      );
    }
  });

  it("takes the search limits and the cache, and refuses a limit for an engine that does not exist", () => {
    const config = parseConfig(
      rawConfig({
        web: {
          search: {
            limits: { perMinute: 10, perEngine: { tavily: 3 }, maxWaitSeconds: 5 },
            cache: { enabled: true, ttlMinutes: 60 },
          },
        },
      }),
      "suup.config.json",
    );
    expect(config.web?.search?.limits).toEqual({
      perMinute: 10,
      perEngine: { tavily: 3 },
      maxWaitSeconds: 5,
    });
    expect(config.web?.search?.cache).toEqual({ enabled: true, ttlMinutes: 60 });
    expect(
      issuesOf(rawConfig({ web: { search: { limits: { perEngine: { google: 3 } } } } })).join("\n"),
    ).toContain("motor desconhecido: google");
    expect(
      issuesOf(rawConfig({ web: { search: { limits: { perMinute: 0 } } } })).length,
    ).toBeGreaterThan(0);
    expect(
      issuesOf(rawConfig({ web: { search: { cache: { ttlMinutes: 0 } } } })).length,
    ).toBeGreaterThan(0);
  });

  it("refuses a key it does not know", () => {
    expect(issuesOf(rawConfig({ web: { search: { apiKey: "x" } } })).length).toBeGreaterThan(0);
  });
});
