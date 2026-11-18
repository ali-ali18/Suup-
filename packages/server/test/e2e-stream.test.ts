import { createConnection } from "node:net";
import type { StreamEvent } from "@suup/api";
import {
  appendMessage,
  appendRunEvent,
  changeLogBounds,
  createBot,
  createDirectConversation,
  createRun,
  pruneChangeLog,
  setRunStatus,
} from "@suup/db";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, follow, until, useWorld } from "./world.js";

// The realtime stream across the processes of a deployment: two servers on one database, resuming,
// the limits, the back-pressure, the shutdown.

const usage = { inputTokens: 100, outputTokens: 10 };
const SCRIPTS = {
  roteiro: {
    cases: [
      {
        whenObjectiveContains: "CASE-ECHO",
        agent: [
          { text: "Eco.", usage },
          { text: "Eco de novo.", usage },
        ],
      },
    ],
  },
  outro: { agent: [] },
};

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("the realtime stream: several servers, resuming, limits"),
  { timeout: 60_000 },
  () => {
    const w = useWorld({ scripts: SCRIPTS });

    it("two servers on the same database both deliver every event, under the same ids", async () => {
      const a = w.started;
      const b = await w.startServer();
      expect(b.url).not.toBe(a.url);
      const bot = await a.api.bots.create({
        name: "Dois",
        modelId: "model-x",
        allowedTools: ["shell"],
      });
      const conversation = await a.api.bots.openConversation(bot.id);

      const fa = follow(a.api);
      const fb = follow(b.api);
      await fa.waitFor((e) => e.type === "ready", "ready on A");
      await fb.waitFor((e) => e.type === "ready", "ready on B");

      // A request to one server shows up on the stream of the other.
      const sent = await a.api.conversations.send(conversation.id, "CASE-ECHO oi");
      fa.sub.setRuns([sent.run.id]);
      fb.sub.setRuns([sent.run.id]);
      const isBotMessage = (e: StreamEvent) =>
        e.type === "message.created" && e.data.message.authorKind === "bot";
      // The diary entry the worker writes after the answer is the last change of the run.
      const isJournal = (e: StreamEvent) =>
        e.type === "memory.changed" && e.data.memory.layer === "journal";
      await fa.waitFor(isJournal, "the end of the run on A");
      await fb.waitFor(isJournal, "the end of the run on B");

      const idsOf = (events: StreamEvent[], runId: string) =>
        events.flatMap((e) =>
          e.id !== undefined && (e.type !== "run.event" || e.data.runId === runId)
            ? [`${e.id}:${e.type}`]
            : [],
        );
      const onA = idsOf(fa.events, sent.run.id);
      const onB = idsOf(fb.events, sent.run.id);
      // Same changes, same ids: compare from the first change both of them were following.
      const first = (list: string[]) => Number((list[0] as string).split(":")[0]);
      const from = Math.max(first(onA), first(onB));
      const since = (list: string[]) => list.filter((x) => Number(x.split(":")[0]) >= from);
      expect(since(onA).length).toBeGreaterThan(5);
      expect(since(onA)).toEqual(since(onB));
      // Both carry the run's events complete.
      const seqs = (f: { events: StreamEvent[] }) =>
        f.events.flatMap((e) =>
          e.type === "run.event" && e.data.runId === sent.run.id ? [e.data.event.seq] : [],
        );
      expect(seqs(fa)).toEqual(seqs(fb));
      expect(seqs(fa).length).toBeGreaterThan(3);

      // An id from server A resumes on server B: ids mean the same everywhere.
      const resumedFrom = fa.sub.lastEventId as number;
      fa.close();
      fb.close();
      const next = await b.api.conversations.send(conversation.id, "CASE-ECHO de novo");
      const fresh = follow(b.api, { lastEventId: resumedFrom, runs: [next.run.id] });
      await fresh.waitFor(isBotMessage, "the next bot message after resuming on B");
      expect(fresh.events[0]).toMatchObject({ type: "ready", data: { resync: false } });
      const resumedIds = fresh.events.flatMap((e) => (e.id === undefined ? [] : [e.id]));
      expect(resumedIds.every((id) => id > resumedFrom)).toBe(true);
      expect(resumedIds).toEqual([...new Set(resumedIds)].sort((x, y) => x - y));
      fresh.close();
    });
  },
);

// Tests that write to the database directly: no worker, so nothing else touches their runs.
describe.skipIf(!DATABASE_URL)(
  dbSuiteName("the realtime stream: resync, limits, back-pressure, shutdown"),
  { timeout: 60_000 },
  () => {
    const w = useWorld({ scripts: SCRIPTS, worker: false });

    const connect = (
      url: string,
      token: string,
      headers: Record<string, string> = {},
      query = "",
    ) =>
      fetch(`${url}/v1/stream${query}`, {
        headers: { Authorization: `Bearer ${token}`, ...headers },
      });

    it("starting a server settles runs that ended without their effects and makes sure a main bot exists", async () => {
      const bot = await createBot(w.db, {
        name: "Órfã",
        modelProvider: "roteiro",
        modelId: "model-x",
      });
      const conversation = await createDirectConversation(w.db, bot.id);
      const run = await createRun(w.db, {
        botId: bot.id,
        conversationId: conversation.id,
        origin: "user",
        objective: "x",
      });
      await appendMessage(w.db, {
        conversationId: conversation.id,
        authorKind: "user",
        text: "x",
        runId: run.id,
      });
      // The worker that finished it died before writing the answer.
      await setRunStatus(w.db, run.id, {
        from: "queued",
        to: "done",
        result: { summary: "Resultado esquecido." },
      });
      const before = await w.db
        .sql`select 1 from messages where dedupe_key = ${`run:${run.id}:done`}`;
      expect(before).toHaveLength(0);

      const second = await w.startServer({ bootstrap: true });
      expect(second.url).toBeDefined();
      const after = await w.db.sql<
        { text: string }[]
      >`select text from messages where dedupe_key = ${`run:${run.id}:done`}`;
      expect(after.map((m) => m.text)).toEqual(["Resultado esquecido."]);
      const defaults = (await second.api.bots.list()).filter((b) => b.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.name).toBe("Principal");
    });

    it("tells a client that cannot resume to reload: too old, from another database, too much to replay", async () => {
      const small = await w.startServer({ hub: { maxReplay: 3 } });
      const bot = await createBot(w.db, {
        name: "Resync",
        modelProvider: "roteiro",
        modelId: "model-x",
      });
      const conversation = await createDirectConversation(w.db, bot.id);
      const head =
        (await w.db.sql<{ n: string }[]>`select max(id) as n from change_log`)[0]?.n ?? "0";

      const read = async (header: string | undefined, server = small) => {
        const f = follow(server.api, header === undefined ? {} : { lastEventId: Number(header) });
        await f.waitFor((e) => e.type === "ready", "ready");
        await new Promise((r) => setTimeout(r, 100)); // a resync frame follows ready at once
        f.close();
        return f.events;
      };

      // Too many missed changes for this server's window.
      for (let i = 0; i < 5; i++) {
        await appendMessage(w.db, {
          conversationId: conversation.id,
          authorKind: "user",
          text: `m${i}`,
        });
      }
      const many = await read("1");
      expect(many[0]).toMatchObject({ type: "ready", data: { resync: true } });
      expect(many[1]).toMatchObject({ type: "resync", data: { reason: "too_many" } });
      // After a resync the client resumes from the head it was told, and the next reconnect is clean.
      const f = follow(small.api, { lastEventId: 1 });
      await f.waitFor((e) => e.type === "resync", "resync");
      const told = (f.events[0] as Extract<StreamEvent, { type: "ready" }>).data.head;
      expect(f.sub.lastEventId).toBe(told);
      f.close();

      // From another database (an id from the future).
      const future = await read("999999999");
      expect(future[1]).toMatchObject({ type: "resync", data: { reason: "unknown_id" } });

      // Too old: the log was pruned past it.
      await pruneChangeLog(w.db, { olderThanMs: 0, keepLast: 0 });
      const old = await read(String(Number(head)));
      expect(old[0]).toMatchObject({ type: "ready", data: { resync: true } });
      expect(old[1]).toMatchObject({ type: "resync", data: { reason: "too_old" } });
      // A client that is up to date (resuming from the newest id) is not told to reload.
      const { newest } = await changeLogBounds(w.db);
      const current = await read(String(newest));
      expect(current[0]).toMatchObject({ type: "ready", data: { resync: false } });
      expect(current.some((e) => e.type === "resync")).toBe(false);
    });

    it("caps the concurrent streams and frees a slot when one closes", async () => {
      const capped = await w.startServer({ maxStreams: 2 });
      const open = async () => {
        const controller = new AbortController();
        const res = await fetch(`${capped.url}/v1/stream`, {
          headers: { Authorization: `Bearer ${w.token}` },
          signal: controller.signal,
        });
        return { res, controller };
      };
      const one = await open();
      const two = await open();
      expect([one.res.status, two.res.status]).toEqual([200, 200]);
      expect(one.res.headers.get("content-type")).toContain("text/event-stream");
      const refused = await fetch(`${capped.url}/v1/stream`, {
        headers: { Authorization: `Bearer ${w.token}` },
      });
      expect(refused.status).toBe(429);
      expect(await refused.json()).toMatchObject({ error: { code: "too_many_streams" } });
      expect(capped.server.hub.size).toBe(2);

      one.controller.abort();
      await until(
        () => capped.server.hub.size === 1 || undefined,
        "the closed stream to be forgotten",
      );
      const three = await open();
      expect(three.res.status).toBe(200);
      two.controller.abort();
      three.controller.abort();
      await until(() => capped.server.hub.size === 0 || undefined, "all streams to be forgotten");
    });

    it("sends keep-alive comments, and the frames follow the SSE format", async () => {
      const lively = await w.startServer({ hub: { keepAliveMs: 40 } });
      const controller = new AbortController();
      const res = await connect(lively.url, w.token, {}, "");
      void controller;
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let text = "";
      await until(async () => {
        const { value, done } = await reader.read();
        if (done) return true;
        text += decoder.decode(value, { stream: true });
        return (text.match(/^: ping$/gm) ?? []).length >= 2 || undefined;
      }, "two keep-alive comments");
      await reader.cancel();
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toContain("no-cache");
      expect(res.headers.get("x-accel-buffering")).toBe("no");
      expect(text).toMatch(/^retry: \d+\n\n/);
      expect(text).toMatch(/event: ready\ndata: \{"head":\d+,"resync":false,"runs":\[\]\}\n\n/);
    });

    it("drops a client that cannot keep up, with memory bounded, and it resumes from where it was", async () => {
      const tight = await w.startServer({ hub: { maxPendingBytes: 64 * 1024 } });
      const bot = await createBot(w.db, {
        name: "Lento",
        modelProvider: "roteiro",
        modelId: "model-x",
      });
      const conversation = await createDirectConversation(w.db, bot.id);
      const url = new URL(tight.url);

      // A raw client that asks for the stream and then never reads.
      const socket = createConnection({ host: url.hostname, port: Number(url.port) }, () => {
        socket.write(
          `GET /v1/stream HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${w.token}\r\nAccept: text/event-stream\r\n\r\n`,
        );
        socket.pause();
      });
      socket.on("error", () => {});
      await until(() => tight.server.hub.size === 1 || undefined, "the slow client to connect");

      // Enough big messages to fill the socket buffers on both ends several times over.
      const big = "x".repeat(40_000);
      for (let i = 0; i < 400 && tight.server.hub.size > 0; i++) {
        await appendMessage(w.db, {
          conversationId: conversation.id,
          authorKind: "user",
          text: `${i} ${big}`,
        });
        if (i % 20 === 19) await new Promise((r) => setTimeout(r, 30)); // let the hub read the log
      }
      await until(
        () => tight.server.hub.size === 0 || undefined,
        "the slow client to be dropped",
        120_000,
      );
      socket.destroy();

      // Other clients are unaffected, and a reconnection resumes without loss.
      const f = follow(tight.api);
      await f.waitFor((e) => e.type === "ready", "ready");
      const resumedFrom = f.sub.lastEventId as number;
      f.close();
      await appendMessage(w.db, {
        conversationId: conversation.id,
        authorKind: "user",
        text: "depois",
      });
      const g = follow(tight.api, { lastEventId: resumedFrom });
      await g.waitFor(
        (e) => e.type === "message.created" && e.data.message.text === "depois",
        "the message sent after",
      );
      g.close();
    }, 180_000);

    it("shuts down gracefully: open streams end at once and close() returns promptly", async () => {
      const doomed = await w.startServer();
      const controller = new AbortController();
      const res = await fetch(`${doomed.url}/v1/stream`, {
        headers: { Authorization: `Bearer ${w.token}` },
        signal: controller.signal,
      });
      expect(res.status).toBe(200);
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read(); // retry + ready
      await until(() => doomed.server.hub.size === 1 || undefined, "the stream to be registered");

      const started = Date.now();
      await doomed.server.close();
      // The stream is over (done, not an error), and the server no longer answers.
      const ended = await reader.read().then(
        (r) => r.done,
        () => true,
      );
      expect(ended).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
      await expect(fetch(`${doomed.url}/health`)).rejects.toBeDefined();
      // Idempotent.
      await doomed.server.close();
      controller.abort();
    });

    it("events of runs nobody subscribed to do not travel, status changes of all runs do", async () => {
      const bot = await createBot(w.db, {
        name: "Filtro",
        modelProvider: "roteiro",
        modelId: "model-x",
      });
      const quiet = await createRun(w.db, { botId: bot.id, origin: "user", objective: "x" });
      const f = follow(w.started.api);
      await f.waitFor((e) => e.type === "ready", "ready");
      await appendRunEvent(w.db, quiet.id, "nudge", { reason: "r", text: "segredo do evento" });
      await setRunStatus(w.db, quiet.id, { from: "queued", to: "cancelled" });
      await f.waitFor(
        (e) =>
          e.type === "run.updated" &&
          e.data.run.id === quiet.id &&
          e.data.run.status === "cancelled",
        "the run status",
      );
      expect(f.events.some((e) => e.type === "run.event")).toBe(false);
      expect(JSON.stringify(f.events)).not.toContain("segredo do evento");
      // Subscribing afterwards does not go back in time: history is read from the REST endpoint,
      // the stream carries what happens from the last id seen on.
      f.sub.setRuns([quiet.id]);
      await f.waitFor(
        (e) => e.type === "ready" && e.data.runs.includes(quiet.id),
        "the reconnection",
      );
      f.close();
      const history = await w.started.api.runs.events(quiet.id);
      expect(history.items.map((e) => e.payload.text)).toEqual(["segredo do evento"]);
    });

    it("an API-only server does not check the bot machine, and the doctor says why", async () => {
      const apiOnly = await w.startServer({ checkSandbox: false });
      const { checks } = await apiOnly.api.diagnostics.doctor();
      const sandbox = checks.find((c) => c.component === "Sandbox");
      expect(sandbox).toMatchObject({
        ok: true,
        detail: expect.stringContaining("não verificado neste processo"),
      });
    });
  },
);
