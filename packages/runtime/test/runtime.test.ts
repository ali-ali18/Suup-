import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateAndCollect, ProviderError } from "@suup/core";
import type { Bot } from "@suup/db";
import { describe, expect, it } from "vitest";
import { installFakeDocker } from "../../sandbox/test/fake-docker.js";
import {
  createRuntime,
  dockerWorkspace,
  parseConfig,
  type RuntimeConfig,
  RuntimeError,
} from "../src/index.js";
import { rawConfig, tempDir } from "./helpers.js";

function bot(overrides: Partial<Bot> = {}): Bot {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "Helper",
    description: "",
    personality: "Be brief.",
    modelProvider: "anthropic",
    modelId: "model-x",
    allowedTools: ["shell"],
    limits: {},
    createdAt: new Date(0),
    updatedAt: new Date(0),
    archivedAt: null,
    ...overrides,
  };
}

const configOf = (overrides: Record<string, unknown> = {}): RuntimeConfig =>
  parseConfig(rawConfig(overrides));

describe("runtime: models and providers", () => {
  it("resolves a model with its provider entry", () => {
    const runtime = createRuntime(configOf(), { env: {} });
    const { model, provider } = runtime.resolveModel("model-y");
    expect(model.contextWindow).toBe(32000);
    expect(provider.id).toBe("local");
  });

  it("names what is missing for an unknown model, listing the configured ones", () => {
    const runtime = createRuntime(configOf(), { env: {} });
    expect(() => runtime.resolveModel("ghost")).toThrow(RuntimeError);
    expect(() => runtime.resolveModel("ghost")).toThrow(/"ghost".*model-x, model-y, model-s/);
  });

  it("rejects an unknown provider id", () => {
    const runtime = createRuntime(configOf(), { env: {} });
    expect(() => runtime.getProvider("nowhere")).toThrow(/provedor "nowhere"/);
  });

  it("does not require the API key at creation: the provider fails when first used, as an auth error", async () => {
    const runtime = createRuntime(configOf(), { env: {} });
    const provider = runtime.getProvider("anthropic");
    expect(provider.id).toBe("anthropic");
    const err = await generateAndCollect(provider, {
      model: "model-x",
      system: "s",
      messages: [{ role: "user", blocks: [{ type: "text", text: "x" }] }],
      tools: [],
      maxOutputTokens: 10,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.kind).toBe("auth");
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("KEY_A");
    expect(runtime.keyStatus("anthropic")).toMatchObject({ ok: false, envName: "KEY_A" });
  });

  it("builds the real provider once the variable is present (and never puts the key in a message)", async () => {
    const seen: { url: string; key: string | null }[] = [];
    const runtime = createRuntime(configOf(), {
      env: { KEY_A: "sk-test-123" },
      fetch: (async (url: string | URL | Request, init?: RequestInit) => {
        seen.push({ url: String(url), key: new Headers(init?.headers).get("x-api-key") });
        return new Response("nope", { status: 401 });
      }) as typeof fetch,
    });
    expect(runtime.keyStatus("anthropic").ok).toBe(true);
    const err = await generateAndCollect(runtime.getProvider("anthropic"), {
      model: "model-x",
      system: "s",
      messages: [{ role: "user", blocks: [{ type: "text", text: "x" }] }],
      tools: [],
      maxOutputTokens: 10,
    }).catch((e) => e);
    expect(err.kind).toBe("auth");
    expect(err.message).not.toContain("sk-test-123");
    expect(seen[0]?.url).toContain("api.anthropic.com");
    expect(seen[0]?.key).toBe("sk-test-123");
    expect(runtime.getProvider("anthropic")).toBe(runtime.getProvider("anthropic")); // cached
  });

  it("a compatible provider without apiKeyEnv needs no key; a scripted one neither", () => {
    const runtime = createRuntime(configOf(), { env: {} });
    expect(runtime.keyStatus("local")).toMatchObject({ ok: true, envName: null });
    expect(runtime.keyStatus("script")).toMatchObject({ ok: true, envName: null });
    expect(runtime.getProvider("local").id).toBe("local");
  });

  it("registers the built-in tools", () => {
    const runtime = createRuntime(configOf(), { env: {} });
    expect(runtime.tools.list().map((t) => t.name)).toEqual([
      "shell",
      "read_file",
      "write_file",
      "edit_file",
      "list_files",
      "search_files",
      "web_fetch",
    ]);
  });

  it("throws a configuration error, only when used, if no database is configured", () => {
    const runtime = createRuntime(configOf(), { env: {} });
    expect(() => runtime.db).toThrow(/Nenhum banco de dados configurado/);
  });
});

describe("runtime: the bot configuration", () => {
  it("maps a bot row, the model catalog and the defaults to the loop's BotConfig", () => {
    const runtime = createRuntime(
      configOf({ defaults: { maxTurns: 30, maxCostUsd: 1.5, maxDurationMs: 60000 } }),
      { env: {} },
    );
    expect(runtime.botConfig(bot())).toEqual({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Helper",
      personality: "Be brief.",
      model: {
        id: "model-x",
        contextWindow: 100000,
        maxOutputTokens: 4096,
        pricing: { inputPerMTok: 3, outputPerMTok: 15 },
      },
      allowedTools: ["shell"],
      limits: { maxTurns: 30, maxCostUsd: 1.5, maxDurationMs: 60000 },
    });
  });

  it("the bot's own limits win over the defaults; without either, a turn limit still applies", () => {
    const withDefaults = createRuntime(configOf({ defaults: { maxTurns: 30 } }), { env: {} });
    expect(withDefaults.botConfig(bot({ limits: { maxTurns: 7 } })).limits).toEqual({
      maxTurns: 7,
    });
    const bare = createRuntime(configOf(), { env: {} });
    expect(bare.botConfig(bot()).limits).toEqual({ maxTurns: 50 });
    // a model without pricing has no `pricing` key at all
    expect(bare.botConfig(bot({ modelProvider: "local", modelId: "model-y" })).model).toEqual({
      id: "model-y",
      contextWindow: 32000,
      maxOutputTokens: 2048,
    });
  });

  it("names the bot and what is missing when its model is not in the configuration", () => {
    const runtime = createRuntime(configOf(), { env: {} });
    const call = () => runtime.botConfig(bot({ modelId: "model-gone" }));
    expect(call).toThrow(RuntimeError);
    expect(call).toThrow(/bot "Helper" \(11111111.*modelo "model-gone".*"models"/);
  });

  it("refuses a bot whose model moved to another provider", () => {
    const runtime = createRuntime(configOf(), { env: {} });
    expect(() => runtime.botConfig(bot({ modelProvider: "local" }))).toThrow(
      /criado com o modelo "model-x" no provedor "local".*provedor "anthropic"/,
    );
  });

  it("builds the reviewer from the configured model", () => {
    expect(createRuntime(configOf(), { env: {} }).reviewerConfig()).toBeUndefined();
    const runtime = createRuntime(configOf({ reviewer: { model: "model-y" } }), { env: {} });
    const reviewer = runtime.reviewerConfig();
    expect(reviewer?.model).toEqual({ id: "model-y", maxOutputTokens: 2048 });
    expect(reviewer?.provider.id).toBe("local");
  });
});

describe("runtime: the machine of each bot", () => {
  it("gives each bot its own subdirectory of the shared local root", async () => {
    const dir = await tempDir();
    const runtime = createRuntime(configOf(), { env: {}, baseDir: dir });
    const a = await runtime.executorFor("bot-a");
    const b = await runtime.executorFor("bot-b");
    expect(await runtime.executorFor("bot-a")).toBe(a); // cached
    await a.writeFile("note.txt", "from a");
    expect(await a.stat("note.txt")).not.toBeNull();
    expect(await b.stat("note.txt")).toBeNull();
    expect(await readFile(join(dir, "workspace", "bots", "bot-a", "note.txt"), "utf8")).toBe(
      "from a",
    );
    expect((await runtime.sandboxRoot()).listDir).toBeDefined();
  });

  it("refuses a bot id that could leave the root", async () => {
    const dir = await tempDir();
    const runtime = createRuntime(configOf(), { env: {}, baseDir: dir });
    await expect(runtime.executorFor("../escape")).rejects.toThrow(/Identificador de bot inválido/);
  });

  it("docker: the workspace of a bot is bots/<id> inside the machine", () => {
    expect(dockerWorkspace("abc")).toBe("/workspace/bots/abc");
  });

  it("docker: starts the machine lazily and once, with the configured image, volume and limits", async () => {
    const dir = await tempDir();
    const dockerPath = installFakeDocker(dir);
    const log = join(dir, "calls.log");
    const saved = { log: process.env.FAKE_DOCKER_LOG, state: process.env.FAKE_DOCKER_STATE };
    process.env.FAKE_DOCKER_LOG = log;
    process.env.FAKE_DOCKER_STATE = join(dir, "state.json");
    try {
      const runtime = createRuntime(
        configOf({
          sandbox: {
            kind: "docker",
            image: "suup-sandbox:dev",
            name: "test-machine",
            volume: "test-volume",
            memory: "512m",
            cpus: 1,
          },
        }),
        { env: {}, dockerPath },
      );
      const calls = async () =>
        (await readFile(log, "utf8").catch(() => ""))
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[]);
      expect(await calls()).toEqual([]); // nothing at creation

      // The fake docker is not a container: /workspace does not exist, so preparing the bot's
      // directory fails. What this checks is the argv sent to docker up to that point.
      const failure = await runtime.executorFor("bot-1").catch((e) => e);
      expect(failure).toBeInstanceOf(RuntimeError);
      expect(failure.code).toBe("sandbox_failed");
      expect(failure.message).toContain("bot-1");

      const sent = await calls();
      const run = sent.find((c) => c[0] === "run");
      expect(run).toEqual(
        expect.arrayContaining(["--name", "test-machine", "--memory", "512m", "--cpus", "1"]),
      );
      expect(run).toEqual(
        expect.arrayContaining(["--volume", "test-volume:/workspace", "suup-sandbox:dev"]),
      );
      const exec = sent.find((c) => c[0] === "exec");
      expect(exec).toContain("test-machine");
      expect(exec?.at(-2)).toBe("mkdir -p bots/bot-1");

      // The machine is started once even for a second bot.
      await runtime.executorFor("bot-2").catch(() => undefined);
      expect((await calls()).filter((c) => c[0] === "run")).toHaveLength(1);
    } finally {
      for (const [key, value] of [
        ["FAKE_DOCKER_LOG", saved.log],
        ["FAKE_DOCKER_STATE", saved.state],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
