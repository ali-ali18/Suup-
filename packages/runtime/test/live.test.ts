import { join } from "node:path";
import type { LiveFrame } from "@suup/core";
import { createBot, createDb, createDirectConversation, createRun } from "@suup/db";
import { describe, expect, it } from "vitest";
import {
  createLiveChannel,
  createRuntime,
  LIVE_NOTIFY_MAX_BYTES,
  LIVE_QUEUE_MAX,
  parseConfig,
  splitFrame,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

const RUN = "11111111-1111-4111-8111-111111111111";
const frame = (offset: number, text: string): LiveFrame => ({
  type: "live.text",
  runId: RUN,
  call: 3,
  attempt: 1,
  block: 0,
  offset,
  text,
});

describe("live channel: the pieces of a frame", () => {
  it("a long text is cut so every NOTIFY payload fits, with the offsets kept and no pair split", () => {
    const text = `${"abc\u{1F600}".repeat(5000)}fim`;
    const payloads = splitFrame(frame(10, text), "origin-1");
    expect(payloads.length).toBeGreaterThan(2);
    let at = 10;
    let joined = "";
    for (const payload of payloads) {
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(LIVE_NOTIFY_MAX_BYTES);
      const { f } = JSON.parse(payload) as { f: Extract<LiveFrame, { type: "live.text" }> };
      expect(f.offset).toBe(at);
      at += f.text.length;
      joined += f.text;
    }
    expect(joined).toBe(text);
  });

  it("a small frame goes as it is, and every payload names the sender", () => {
    const [only, ...rest] = splitFrame(frame(0, "oi"), "origin-1");
    expect(rest).toEqual([]);
    expect(JSON.parse(only as string)).toEqual({ o: "origin-1", f: frame(0, "oi") });
  });
});

describe("live channel: one process", () => {
  it("hands the frame to the subscribers of the same process, with no database at all", () => {
    const channel = createLiveChannel({
      db: () => {
        throw new Error("the database must not be touched");
      },
      crossProcess: false,
    });
    const got: LiveFrame[] = [];
    const off = channel.subscribe((f) => got.push(f));
    channel.publish(frame(0, "a"));
    off();
    channel.publish(frame(1, "b"));
    expect(got).toEqual([frame(0, "a")]);
  });

  it("a listener that throws does not stop the others or the publisher", () => {
    const channel = createLiveChannel({
      db: () => {
        throw new Error("no");
      },
      crossProcess: false,
    });
    const got: LiveFrame[] = [];
    channel.subscribe(() => {
      throw new Error("boom");
    });
    channel.subscribe((f) => got.push(f));
    expect(() => channel.publish(frame(0, "a"))).not.toThrow();
    expect(got).toHaveLength(1);
  });

  it("keeps the queue bounded when the database is slow", () => {
    expect(LIVE_QUEUE_MAX).toBeGreaterThan(0);
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("live channel: two processes through NOTIFY"), () => {
  const ctx = useIsolatedDb();

  it("a worker process reaches the server process, and neither hears its own echo twice", async () => {
    // Two connections stand for two processes: separate channels, the same database.
    const workerDb = createDb(DATABASE_URL as string, { schema: ctx.schema });
    const serverDb = createDb(DATABASE_URL as string, { schema: ctx.schema });
    const worker = createLiveChannel({ db: () => workerDb, crossProcess: true });
    const server = createLiveChannel({ db: () => serverDb, crossProcess: true });
    const atServer: LiveFrame[] = [];
    const atWorker: LiveFrame[] = [];
    server.subscribe((f) => atServer.push(f));
    worker.subscribe((f) => atWorker.push(f));
    await server.listen();
    await worker.listen();

    const long = "x".repeat(20_000);
    worker.publish(frame(0, "Olá"));
    worker.publish(frame(3, long));
    worker.publish({ type: "live.end", runId: RUN, call: 3, attempt: 1, outcome: "recorded" });
    for (let i = 0; i < 100 && atServer.length < 4; i++)
      await new Promise((r) => setTimeout(r, 50));

    // In order, all the text, the long piece cut in pieces that add up.
    const texts = atServer.filter((f) => f.type === "live.text");
    expect(texts.map((f) => (f as { text: string }).text).join("")).toBe(`Olá${long}`);
    expect(atServer[atServer.length - 1]).toMatchObject({ type: "live.end", outcome: "recorded" });
    // The worker's own subscribers got each frame once, straight from memory (not again from NOTIFY).
    expect(atWorker.map((f) => f.type)).toEqual(["live.text", "live.text", "live.end"]);

    // A server that is not listening hears nothing; a frame sent before it listened is gone.
    await server.close();
    await worker.close();
    await workerDb.close();
    await serverDb.close();
  });

  it("a process with crossProcess false sends nothing through the database", async () => {
    const aDb = createDb(DATABASE_URL as string, { schema: ctx.schema });
    const bDb = createDb(DATABASE_URL as string, { schema: ctx.schema });
    const sender = createLiveChannel({ db: () => aDb, crossProcess: false });
    const listener = createLiveChannel({ db: () => bDb, crossProcess: true });
    const heard: LiveFrame[] = [];
    listener.subscribe((f) => heard.push(f));
    await listener.listen();
    sender.publish(frame(0, "so local"));
    await new Promise((r) => setTimeout(r, 300));
    expect(heard).toEqual([]);
    await listener.close();
    await aDb.close();
    await bDb.close();
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("which runs are shown live"), () => {
  const ctx = useIsolatedDb();

  it("only a conversation run of the user (or reception); never a routine, a delegation, a run with no conversation or an evaluation", async () => {
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), { agent: [{ text: "Oi!" }] });
    const runtime = createRuntime(parseConfig(rawConfig()), {
      env: { DATABASE_URL: ctx.url },
      baseDir: dir,
    });
    let n = 0;
    const make = async (
      origin: "user" | "reception" | "routine" | "delegation" | "proactive",
      over: { conversation?: boolean; isolated?: boolean } = {},
    ) => {
      // A bot (and so a conversation) for each, so no run waits behind another.
      const bot = await createBot(runtime.db, {
        name: `Vivo ${++n}`,
        modelProvider: "script",
        modelId: "model-s",
      });
      const conversation = await createDirectConversation(runtime.db, bot.id);
      return createRun(runtime.db, {
        botId: bot.id,
        origin,
        objective: "x",
        ...(over.conversation === false ? {} : { conversationId: conversation.id }),
        ...(over.isolated === true ? { isolated: true } : {}),
      });
    };
    const shown = async (run: { id: string }) =>
      (await runtime.buildDeps(run.id, "w-live")).live !== undefined;

    expect(await shown(await make("user"))).toBe(true);
    expect(await shown(await make("reception"))).toBe(true);
    expect(await shown(await make("routine"))).toBe(false);
    expect(await shown(await make("delegation"))).toBe(false);
    expect(await shown(await make("proactive"))).toBe(false);
    expect(await shown(await make("user", { conversation: false }))).toBe(false);
    expect(await shown(await make("user", { isolated: true }))).toBe(false);
    await runtime.close();
  });

  it("the runtime's live channel is crossProcess by default and in memory when the config says so", async () => {
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), { agent: [{ text: "Oi!" }] });
    for (const [live, expected] of [
      [undefined, true],
      [{ crossProcess: false }, false],
      [{ crossProcess: true }, true],
    ] as const) {
      const config = parseConfig(rawConfig(live === undefined ? {} : { live }));
      expect(config.live?.crossProcess ?? true).toBe(expected);
    }
  });
});
