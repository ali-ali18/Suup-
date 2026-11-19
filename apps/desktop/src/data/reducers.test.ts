import type { StreamEvent } from "@suup/api";
import { describe, expect, it } from "vitest";
import {
  at,
  makeBot,
  makeConversation,
  makeEvent,
  makeMemory,
  makeMessage,
  makeRun,
} from "../test-fixtures.js";
import {
  addOptimisticMessage,
  applyStreamEvent,
  contiguousSeq,
  mergeBot,
  mergeConversation,
  mergeMessagePage,
  mergeRun,
  mergeRunEvents,
  orderedEvents,
  orderedMessages,
  resolveOptimisticMessage,
  rollbackOptimisticMessage,
  setBots,
  setConnection,
  setMemories,
  upsertMessage,
} from "./reducers.js";
import { type DataState, emptyData } from "./state.js";

const frame = <T extends StreamEvent["type"]>(
  type: T,
  data: Extract<StreamEvent, { type: T }>["data"],
  id = 1,
): StreamEvent => ({ type, id, data }) as StreamEvent;

describe("stream frames", () => {
  it("run.updated stores the run; the same frame twice changes nothing", () => {
    const run = makeRun({ status: "running" });
    const once = applyStreamEvent(emptyData(), frame("run.updated", { run }));
    expect(once.runs[run.id]).toEqual(run);
    expect(applyStreamEvent(once, frame("run.updated", { run }, 2))).toBe(once);
  });

  it("run.event is idempotent by seq and keeps seq order whatever the arrival order", () => {
    const runId = makeRun().id;
    const e = (seq: number) => makeEvent(seq, "tool_call", { callId: `c${seq}` });
    let s = emptyData();
    for (const seq of [3, 1, 2, 2, 3, 1]) {
      s = applyStreamEvent(s, frame("run.event", { runId, event: e(seq) }, seq));
    }
    expect(orderedEvents(s.events[runId]).map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(contiguousSeq(s.events[runId])).toBe(3);
  });

  it("message.created and message.updated go to the conversation of the message", () => {
    const m = makeMessage({ seq: 1, text: "oi" });
    let s = applyStreamEvent(emptyData(), frame("message.created", { message: m }));
    s = applyStreamEvent(
      s,
      frame("message.updated", { message: { ...m, status: "delivered" } }, 2),
    );
    expect(orderedMessages(s.messages[m.conversationId]).map((x) => x.status)).toEqual([
      "delivered",
    ]);
  });

  it("conversation.updated, bot.updated and memory.changed are merged", () => {
    const conversation = makeConversation({ unreadCount: 2 });
    const bot = makeBot();
    const memory = makeMemory();
    let s = applyStreamEvent(emptyData(), frame("conversation.updated", { conversation }));
    s = applyStreamEvent(s, frame("bot.updated", { bot }, 2));
    s = applyStreamEvent(s, frame("memory.changed", { change: "created", memory }, 3));
    expect(s.conversations[conversation.id]?.unreadCount).toBe(2);
    expect(s.bots[bot.id]).toEqual(bot);
    expect(s.memories[memory.id]).toEqual(memory);
  });

  it("ready and resync do not touch the data (the sync layer reloads)", () => {
    const s = emptyData();
    expect(applyStreamEvent(s, { type: "ready", data: { head: 1, resync: false, runs: [] } })).toBe(
      s,
    );
    expect(applyStreamEvent(s, { type: "resync", data: { reason: "too_old" } })).toBe(s);
  });
});

describe("runs never go back in time", () => {
  const base = makeRun({ status: "running", updatedAt: at(2000), turns: 2 });

  it("an older version is ignored", () => {
    const s = mergeRun(emptyData(), base);
    expect(mergeRun(s, { ...base, status: "queued", updatedAt: at(1000), turns: 1 })).toBe(s);
  });

  it("a finished run is never replaced by an unfinished one, even with a later date", () => {
    const done = { ...base, status: "done" as const, updatedAt: at(3000) };
    const s = mergeRun(emptyData(), done);
    expect(mergeRun(s, { ...base, status: "running", updatedAt: at(9000) })).toBe(s);
    expect(
      mergeRun(s, { ...base, status: "waiting_user", updatedAt: at(9000) }).runs[base.id]?.status,
    ).toBe("done");
  });

  it("a finished version replaces an unfinished one that is newer by date (the REST answer lost the race)", () => {
    const s = mergeRun(emptyData(), { ...base, updatedAt: at(5000) });
    expect(
      mergeRun(s, { ...base, status: "done", updatedAt: at(4000) }).runs[base.id]?.status,
    ).toBe("done");
  });

  it("the plan, usage and pause of the newest version win", () => {
    let s = mergeRun(emptyData(), base);
    s = mergeRun(s, { ...base, updatedAt: at(2500), paused: true, turns: 3, costUsd: "0.010000" });
    expect(s.runs[base.id]).toMatchObject({ paused: true, turns: 3, costUsd: "0.010000" });
  });
});

describe("bots, conversations, memories: versions", () => {
  it("keeps the newer version when an older one arrives late", () => {
    const bot = makeBot({ updatedAt: at(2000), name: "Novo" });
    let s = mergeBot(emptyData(), bot);
    s = mergeBot(s, { ...bot, updatedAt: at(1000), name: "Velho" });
    expect(s.bots[bot.id]?.name).toBe("Novo");

    const conversation = makeConversation({ updatedAt: at(2000), unreadCount: 0 });
    let c = mergeConversation(emptyData(), conversation);
    c = mergeConversation(c, { ...conversation, updatedAt: at(1000), unreadCount: 5 });
    expect(c.conversations[conversation.id]?.unreadCount).toBe(0);
  });

  it("a full bot list replaces the set but keeps a bot the stream made newer meanwhile", () => {
    const a = makeBot({ name: "A", updatedAt: at(1000) });
    const b = makeBot({ name: "B" });
    let s = mergeBot(emptyData(), { ...a, name: "A2", updatedAt: at(2000) });
    s = setBots(s, [a]);
    expect(Object.keys(s.bots)).toEqual([a.id]);
    expect(s.bots[a.id]?.name).toBe("A2");
    s = setBots(s, [b]);
    expect(Object.keys(s.bots)).toEqual([b.id]);
    expect(s.botsLoaded).toBe(true);
  });

  it("a conversation brings its active run into the run table", () => {
    const run = makeRun({ status: "waiting_user" });
    const s = mergeConversation(emptyData(), makeConversation({ activeRun: run }));
    expect(s.runs[run.id]?.status).toBe("waiting_user");
  });

  it("memories: newest wins; a list keeps archived ones for restore", () => {
    const m = makeMemory({ updatedAt: at(2000), text: "novo" });
    const s = setMemories(emptyData(), [
      { ...m, updatedAt: at(1000), text: "velho" },
      makeMemory({ archivedAt: at(5) }),
    ]);
    expect(Object.keys(s.memories)).toHaveLength(2);
    const t = applyStreamEvent(
      setMemories(emptyData(), [m]),
      frame("memory.changed", {
        change: "updated",
        memory: { ...m, updatedAt: at(1000), text: "velho" },
      }),
    );
    expect(t.memories[m.id]?.text).toBe("novo");
  });
});

describe("messages", () => {
  const conversationId = makeConversation().id;
  const msg = (seq: number, over = {}) =>
    makeMessage({ conversationId, seq, text: `m${seq}`, ...over });

  it("a message never goes from delivered back to sent", () => {
    const m = msg(1, { status: "delivered" });
    const s = upsertMessage(emptyData(), m);
    const after = upsertMessage(s, { ...m, status: "sent" });
    expect(orderedMessages(after.messages[conversationId])[0]?.status).toBe("delivered");
  });

  it("pages: the newest page, older pages and newer pages merge in seq order without duplicates", () => {
    let s = mergeMessagePage(emptyData(), conversationId, [msg(3), msg(4)], true, "newest");
    expect(s.messages[conversationId]).toMatchObject({ hasOlder: true, loaded: true });
    s = mergeMessagePage(s, conversationId, [msg(1), msg(2)], false, "older");
    const again = orderedMessages(s.messages[conversationId]).find((m) => m.seq === 4);
    s = mergeMessagePage(s, conversationId, [again ?? msg(4), msg(5)], false, "newer");
    expect(orderedMessages(s.messages[conversationId]).map((m) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(s.messages[conversationId]?.hasOlder).toBe(false);
  });

  it("a reload of the newest page drops older messages when a hole could exist between them", () => {
    let s = mergeMessagePage(emptyData(), conversationId, [msg(1), msg(2)], false, "newest");
    s = mergeMessagePage(s, conversationId, [msg(10), msg(11)], true, "newest");
    expect(orderedMessages(s.messages[conversationId]).map((m) => m.seq)).toEqual([10, 11]);
    expect(s.messages[conversationId]?.hasOlder).toBe(true);
  });

  describe("optimistic send", () => {
    const input = { tempId: "t1", conversationId, text: "oi", now: at(0) };

    it("shows the message at once, after the confirmed ones", () => {
      let s = upsertMessage(emptyData(), msg(1));
      s = addOptimisticMessage(s, input);
      const list = orderedMessages(s.messages[conversationId]);
      expect(list.map((m) => m.text)).toEqual(["m1", "oi"]);
      expect(list[1]?.local).toBe("sending");
    });

    it("is replaced by the server's message; if the stream delivered it first, there is one", () => {
      const real = msg(2, { text: "oi", status: "sent" });
      let s = addOptimisticMessage(emptyData(), input);
      s = upsertMessage(s, real); // the stream was faster than the response
      s = resolveOptimisticMessage(s, "t1", real);
      expect(orderedMessages(s.messages[conversationId]).map((m) => [m.id, m.local])).toEqual([
        [real.id, undefined],
      ]);
    });

    it("rolls back when the server refuses, leaving the rest alone", () => {
      let s = upsertMessage(emptyData(), msg(1));
      s = addOptimisticMessage(s, input);
      s = rollbackOptimisticMessage(s, conversationId, "t1");
      expect(orderedMessages(s.messages[conversationId]).map((m) => m.text)).toEqual(["m1"]);
      expect(rollbackOptimisticMessage(s, conversationId, "t1")).toBe(s);
    });
  });
});

describe("run events: pages and gaps", () => {
  const runId = makeRun().id;
  it("contiguousSeq stops at the first hole, so a fetch resumes from there", () => {
    const s = mergeRunEvents(emptyData(), runId, [
      makeEvent(1, "run_started"),
      makeEvent(2, "x"),
      makeEvent(4, "x"),
    ]);
    expect(contiguousSeq(s.events[runId])).toBe(2);
    const filled = mergeRunEvents(s, runId, [makeEvent(3, "x")], { loaded: true });
    expect(contiguousSeq(filled.events[runId])).toBe(4);
    expect(filled.events[runId]?.loaded).toBe(true);
  });

  it("merging nothing new returns the same state", () => {
    const s = mergeRunEvents(emptyData(), runId, [makeEvent(1, "x")], { loaded: true });
    expect(mergeRunEvents(s, runId, [makeEvent(1, "x")])).toBe(s);
  });
});

describe("connection", () => {
  it("only changes when the phase or the detail change", () => {
    const s: DataState = setConnection(emptyData(), { phase: "online" });
    expect(setConnection(s, { phase: "online" })).toBe(s);
    expect(setConnection(s, { phase: "reconnecting" }).connection.phase).toBe("reconnecting");
  });
});
