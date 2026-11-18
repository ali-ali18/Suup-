import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  configPath,
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
