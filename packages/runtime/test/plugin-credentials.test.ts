import { join } from "node:path";
import { createBot, getSecretMeta } from "@suup/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  answerSecretRequest,
  createRuntime,
  generateKeyText,
  parseConfig,
  type Runtime,
  searchKeyOwner,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

// Made-up values, only for these tests.
const GITHUB = "ghp_made_up_token_for_tests_0001";
const TAVILY = "tvly-made-up-key-for-tests-0002";
const CUSTOM = "brv-made-up-key-for-tests-0003";

describe.skipIf(!DATABASE_URL)(dbSuiteName("plugin credentials"), { timeout: 60_000 }, () => {
  const ctx = useIsolatedDb();
  let runtime: Runtime | undefined;
  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  async function open(
    script: unknown = { agent: [{ text: "ok" }] },
    web?: Record<string, unknown>,
  ): Promise<Runtime> {
    await ctx.db.sql`delete from connectors`;
    await ctx.db.sql`delete from secrets`;
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), script);
    const env = { DATABASE_URL: ctx.url, TEST_VAULT_KEY: generateKeyText() };
    runtime = createRuntime(
      parseConfig(
        rawConfig({
          vault: { keyEnv: "TEST_VAULT_KEY" },
          toolSearch: { minTools: 1000, minDefinitionTokens: 1_000_000 },
          ...(web === undefined ? {} : { web }),
        }),
      ),
      { env, baseDir: dir },
    );
    return runtime;
  }

  const metaOf = (rt: Runtime, name: string) => getSecretMeta(rt.db, name);

  it("start-up adoption: the owner's key of each search engine and the token of each installed token connector move to their plugin, grants gone, values kept", async () => {
    const rt = await open(undefined, {
      search: { general: { tavily: { secret: "MINHA_TAVILY" } } },
    });
    const bot = await createBot(rt.db, {
      name: "adopt-bot",
      modelProvider: "script",
      modelId: "m",
    });
    await rt.connectors.gallery.install("github");
    await rt.vault.set("GITHUB_TOKEN", GITHUB);
    await rt.vault.set("MINHA_TAVILY", TAVILY);
    await rt.vault.set("BRAVE_SEARCH_API_KEY", CUSTOM);
    await rt.vault.set("UNRELATED_SECRET", "something-else-entirely");
    for (const name of ["GITHUB_TOKEN", "MINHA_TAVILY", "UNRELATED_SECRET"]) {
      await rt.vault.grant(name, bot.id);
    }

    const adopted = await rt.pluginCredentials.adoptAll();
    expect(adopted.sort()).toEqual(["github", "search:brave", "search:tavily"]);
    expect((await metaOf(rt, "GITHUB_TOKEN"))?.managedBy).toBe("github");
    expect((await metaOf(rt, "MINHA_TAVILY"))?.managedBy).toBe(searchKeyOwner("tavily"));
    expect((await metaOf(rt, "BRAVE_SEARCH_API_KEY"))?.managedBy).toBe("search:brave");
    // What belongs to nobody's plugin stays the owner's, with its grant.
    expect((await metaOf(rt, "UNRELATED_SECRET"))?.managedBy).toBeNull();
    expect((await rt.vault.infoFor(bot.id)).map((s) => s.name)).toEqual(["UNRELATED_SECRET"]);
    expect((await rt.vault.list()).map((s) => s.name)).toEqual(["UNRELATED_SECRET"]);
    // Idempotent: nothing to adopt the second time.
    expect(await rt.pluginCredentials.adoptAll()).toEqual([]);

    // Suup still reads the values, and the plugin's state sees the marked secret.
    // A plugin's secret has no list of hosts: the gallery fixes where it goes (KOD-36).
    const github = await rt.vault.resolveForConnector(["GITHUB_TOKEN"], {
      kind: "host",
      host: "api.githubcopilot.com",
    });
    expect(github.GITHUB_TOKEN).toBe(GITHUB);
    const item = (await rt.connectors.gallery.list()).find((i) => i.entry.id === "github");
    expect(item?.status).not.toBe("needs_secret");
    const providers = await rt.webSearchProviders();
    expect(providers.find((p) => p.id === "tavily")?.state).toBe("ready");
  });

  it("a connector's token is written and removed with its owner mark; a bot can never be granted it", async () => {
    const rt = await open();
    const bot = await createBot(rt.db, {
      name: "token-bot",
      modelProvider: "script",
      modelId: "m",
    });
    await rt.connectors.gallery.install("github");
    await rt.connectors.gallery.setToken("github", GITHUB);
    expect(await metaOf(rt, "GITHUB_TOKEN")).toMatchObject({
      managedBy: "github",
      grantedBotIds: [],
    });
    await expect(rt.vault.grant("GITHUB_TOKEN", bot.id)).rejects.toThrow();
    // Installing again turns it on: the token is visible to the state even though it is marked.
    const again = await rt.connectors.gallery.install("github");
    // (connected or error: turning it on lists the tools over the real network, which a test must not need)
    expect(again.next).toBe("none");
    expect(again.item.status).not.toBe("needs_secret");
    expect((await rt.connectors.get("github"))?.enabled).toBe(true);
    // An entry that is not a token entry has nothing to keep.
    await expect(rt.connectors.gallery.setToken("notion", GITHUB)).rejects.toThrow();
    // Removing the connector takes its token along.
    expect(await rt.connectors.remove("github")).toBe(true);
    expect(await metaOf(rt, "GITHUB_TOKEN")).toBeNull();
  });

  it("removeToken takes away only what the connector keeps, not an owner's secret of the same name", async () => {
    const rt = await open();
    await rt.vault.set("GITHUB_TOKEN", GITHUB);
    expect(await rt.connectors.gallery.removeToken("github")).toBe(false);
    expect(await metaOf(rt, "GITHUB_TOKEN")).not.toBeNull();
  });

  it("a search key is written under search:<engine> and read by the search; DELETE takes only that one", async () => {
    const rt = await open();
    await rt.pluginCredentials.setSearchKey("tavily", TAVILY);
    expect(await metaOf(rt, "TAVILY_API_KEY")).toMatchObject({
      managedBy: "search:tavily",
      grantedBotIds: [],
    });
    expect((await rt.vault.list()).map((s) => s.name)).toEqual([]);
    expect((await rt.webSearchProviders()).find((p) => p.id === "tavily")?.state).toBe("ready");
    await expect(rt.pluginCredentials.setSearchKey("wikipedia", TAVILY)).rejects.toThrow();
    expect(await rt.pluginCredentials.removeSearchKey("brave")).toBe(false);
    expect(await rt.pluginCredentials.removeSearchKey("tavily")).toBe(true);
    expect(await metaOf(rt, "TAVILY_API_KEY")).toBeNull();
    expect((await rt.webSearchProviders()).find((p) => p.id === "tavily")?.state).toBe("no_key");
  });

  it("request_secret with a plugin's credential name: kept by the plugin, not granted, the model is told so", async () => {
    const rt = await open({
      agent: [
        {
          calls: [
            {
              id: "c1",
              name: "request_secret",
              args: { name: "TAVILY_API_KEY", reason: "search", hosts: ["api.tavily.com"] },
            },
          ],
        },
        { text: "ok" },
      ],
    });
    const bot = await createBot(rt.db, {
      name: "request-bot",
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: [],
    });
    const run = await rt.createRun({ botId: bot.id, objective: "Search the web" });
    await new Promise<void>((resolve) => {
      const worker = rt.createWorker({
        onlyRunId: run.id,
        idleBackoff: { minMs: 10, maxMs: 50 },
        onRunEnd: () => {
          resolve();
          void worker.stop();
        },
      });
      worker.start();
    });
    await answerSecretRequest(rt, run.id, { value: TAVILY });
    expect(await metaOf(rt, "TAVILY_API_KEY")).toMatchObject({
      managedBy: "search:tavily",
      grantedBotIds: [],
    });
    expect(await rt.vault.infoFor(bot.id)).toEqual([]);
    const [message] = await rt.db.sql<{ text: string }[]>`
      select text from run_inbox where run_id = ${run.id} order by created_at desc limit 1`;
    expect(message?.text).toContain("stored by the plugin");
    expect(message?.text).not.toContain(TAVILY);
  });
});
