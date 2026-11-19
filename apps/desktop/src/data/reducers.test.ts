import type { StreamEvent } from "@suup/api";
import { describe, expect, it } from "vitest";
import {
  at,
  makeApproval,
  makeBot,
  makeConnector,
  makeConversation,
  makeEvent,
  makeMemory,
  makeMessage,
  makeRule,
  makeRun,
  makeSecret,
  makeWrittenRule,
} from "../test-fixtures.js";
import {
  addOptimisticMessage,
  applyStreamEvent,
  approvalsOfConversation,
  contiguousSeq,
  mergeApproval,
  mergeApprovals,
  mergeBot,
  mergeConnector,
  mergeConversation,
  mergeMessagePage,
  mergeRule,
  mergeRun,
  mergeRunEvents,
  mergeSecret,
  mergeWrittenRule,
  orderedEvents,
  orderedMessages,
  orderedRules,
  pendingApprovals,
  removeConnector,
  removeRule,
  removeSecret,
  removeWrittenRule,
  resolveOptimisticMessage,
  rollbackOptimisticMessage,
  setBotNetwork,
  setBots,
  setConnection,
  setConnectors,
  setMemories,
  setRules,
  setSecrets,
  setVaultStatus,
  setWrittenRules,
  stalePendingIds,
  upsertMessage,
  writtenRulesOf,
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

describe("approval cards", () => {
  const frameOf = (
    approval: ReturnType<typeof makeApproval>,
    change: "created" | "updated" = "created",
    id = 1,
  ) => frame("approval.changed", { change, approval }, id);

  it("approval.changed stores the card; the same frame twice changes nothing", () => {
    const card = makeApproval();
    const once = applyStreamEvent(emptyData(), frameOf(card));
    expect(once.approvals[card.id]).toEqual(card);
    expect(applyStreamEvent(once, frameOf(card, "created", 2))).toBe(once);
  });

  it("pending becomes decided, and a decided card is final: a late pending frame cannot reopen it", () => {
    const card = makeApproval();
    const decided = { ...card, status: "approved" as const, decidedAt: at(5000) };
    let s = applyStreamEvent(emptyData(), frameOf(card));
    s = applyStreamEvent(s, frameOf(decided, "updated", 2));
    expect(s.approvals[card.id]?.status).toBe("approved");
    // The REST read that started before the decision answers late, still pending.
    expect(mergeApproval(s, card)).toBe(s);
    expect(mergeApprovals(s, [card]).approvals[card.id]?.status).toBe("approved");
    // Nor can another decision overwrite it (it is decided once).
    expect(mergeApproval(s, { ...decided, status: "denied", reason: "x" })).toBe(s);
  });

  it("the pending list is the cards waiting, oldest first, of bots that exist", () => {
    const bot = makeBot();
    const a = makeApproval({ botId: bot.id, createdAt: at(2000) });
    const b = makeApproval({ botId: bot.id, createdAt: at(1000) });
    const decided = makeApproval({ botId: bot.id, status: "denied" });
    const orphan = makeApproval({ botId: makeBot().id });
    let s = setBots(emptyData(), [bot]);
    s = mergeApprovals(s, [a, b, decided, orphan]);
    expect(pendingApprovals(s).map((c) => c.id)).toEqual([b.id, a.id]);
    expect(s.approvalsLoaded).toBe(true);
  });

  it("after reading the whole pending list, a card held as pending that is missing was decided elsewhere", () => {
    const a = makeApproval();
    const b = makeApproval();
    const s = mergeApprovals(emptyData(), [a, b]);
    expect(stalePendingIds(s, [a])).toEqual([b.id]);
    expect(stalePendingIds(s, [a, b])).toEqual([]);
    const decided = mergeApproval(s, { ...b, status: "cancelled" });
    expect(stalePendingIds(decided, [a])).toEqual([]);
  });

  it("the cards of a conversation, oldest first; one without a conversation belongs to its run's", () => {
    const run = makeRun({ conversationId: "conv-1" });
    const mine = makeApproval({ conversationId: "conv-1", createdAt: at(2000) });
    const viaRun = makeApproval({ conversationId: null, runId: run.id, createdAt: at(1000) });
    const other = makeApproval({ conversationId: "conv-2" });
    const s = mergeApprovals(mergeRun(emptyData(), run), [mine, other, viaRun]);
    expect(approvalsOfConversation(s, "conv-1").map((c) => c.id)).toEqual([viaRun.id, mine.id]);
  });
});

describe("rules, vault and connectors (no stream frame: read again after writing)", () => {
  it("a list read replaces the set, but keeps a row the screen holds in a newer version", () => {
    const older = makeRule({ updatedAt: at(1000) });
    const gone = makeRule();
    let s = setRules(emptyData(), [older, gone]);
    expect(s.rulesLoaded).toBe(true);
    const edited = { ...older, effect: "deny" as const, updatedAt: at(5000) };
    s = mergeRule(s, edited);
    // A list that was read before the edit came back.
    s = setRules(s, [older]);
    expect(Object.keys(s.rules)).toEqual([older.id]);
    expect(s.rules[older.id]?.effect).toBe("deny");
  });

  it("merge and remove a rule; a stale write answer does not go back in time; same data is same state", () => {
    const rule = makeRule({ updatedAt: at(3000) });
    const s = mergeRule(emptyData(), rule);
    expect(mergeRule(s, rule)).toBe(s);
    expect(mergeRule(s, { ...rule, updatedAt: at(1000), effect: "deny" })).toBe(s);
    expect(removeRule(s, "nope")).toBe(s);
    expect(Object.keys(removeRule(s, rule.id).rules)).toEqual([]);
  });

  it("rules keep the server's order: the oldest first", () => {
    const first = makeRule({ createdAt: at(1000) });
    const second = makeRule({ createdAt: at(2000) });
    expect(orderedRules(setRules(emptyData(), [second, first])).map((r) => r.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("written rules: a list read keeps a newer row, merge is idempotent and never goes back, kinds keep the oldest first", () => {
    const older = makeWrittenRule({ updatedAt: at(1000), createdAt: at(1000) });
    const second = makeWrittenRule({ kind: "never", createdAt: at(2000) });
    const other = makeWrittenRule({ kind: "allow" });
    let s = setWrittenRules(emptyData(), [second, older, other]);
    expect(s.writtenRulesLoaded).toBe(true);
    expect(writtenRulesOf(s, "never").map((r) => r.id)).toEqual([older.id, second.id]);
    expect(writtenRulesOf(s, "allow").map((r) => r.id)).toEqual([other.id]);
    expect(writtenRulesOf(s, "ask")).toEqual([]);
    const edited = { ...older, text: "Outra frase", updatedAt: at(5000) };
    s = mergeWrittenRule(s, edited);
    s = setWrittenRules(s, [older, second, other]);
    expect(s.writtenRules[older.id]?.text).toBe("Outra frase");
    const same = mergeWrittenRule(s, edited);
    expect(same).toBe(s);
    expect(mergeWrittenRule(s, { ...older, updatedAt: at(10), text: "velha" })).toBe(s);
    expect(removeWrittenRule(s, "nope")).toBe(s);
    expect(Object.keys(removeWrittenRule(s, other.id).writtenRules)).not.toContain(other.id);
  });

  it("secrets are held by name with their metadata only, and removed by name", () => {
    const secret = makeSecret({ name: "GH_TOKEN", grantedBotIds: ["b1"] });
    let s = setSecrets(emptyData(), [secret]);
    expect(s.secretsLoaded).toBe(true);
    s = mergeSecret(s, { ...secret, grantedBotIds: [], updatedAt: at(9000) });
    expect(s.secrets.GH_TOKEN?.grantedBotIds).toEqual([]);
    expect(Object.keys(s.secrets.GH_TOKEN ?? {})).not.toContain("value");
    expect(Object.keys(removeSecret(s, "GH_TOKEN").secrets)).toEqual([]);
    expect(removeSecret(s, "OUTRO")).toBe(s);
  });

  it("the vault status is stored once; the same status is the same state", () => {
    const status = { configured: false, ok: false, keyEnv: null, reason: "cofre não configurado" };
    const s = setVaultStatus(emptyData(), status);
    expect(s.vault).toEqual(status);
    expect(setVaultStatus(s, { ...status })).toBe(s);
  });

  it("connectors are held by name; a grant answer replaces the row; removing drops it", () => {
    const connector = makeConnector({ name: "fake", updatedAt: at(1000) });
    let s = setConnectors(emptyData(), [connector]);
    expect(s.connectorsLoaded).toBe(true);
    s = mergeConnector(s, { ...connector, grantedBotIds: ["b1"], updatedAt: at(2000) });
    expect(s.connectors.fake?.grantedBotIds).toEqual(["b1"]);
    // A list read before the grant must not take the grant back.
    s = setConnectors(s, [connector]);
    expect(s.connectors.fake?.grantedBotIds).toEqual(["b1"]);
    expect(Object.keys(removeConnector(s, "fake").connectors)).toEqual([]);
    expect(removeConnector(s, "outro")).toBe(s);
  });
});

describe("the network of a bot's machine", () => {
  const view = (hosts: string[]) => ({
    defaults: ["registry.npmjs.org"],
    hosts: hosts.map((host) => ({ host, createdBy: "user" as const, createdAt: at(0) })),
    refusals: [],
  });

  it("keeps what the server last said, by bot, and replaces it whole", () => {
    const one = setBotNetwork(emptyData(), "b1", view(["a.com"]));
    expect(one.networks.b1?.hosts.map((h) => h.host)).toEqual(["a.com"]);
    const two = setBotNetwork(one, "b2", view([]));
    expect(Object.keys(two.networks).sort()).toEqual(["b1", "b2"]);
    const after = setBotNetwork(two, "b1", view([]));
    expect(after.networks.b1?.hosts).toEqual([]);
    expect(after.networks.b2).toBe(two.networks.b2);
  });

  it("the same answer twice changes nothing", () => {
    const once = setBotNetwork(emptyData(), "b1", view(["a.com"]));
    expect(setBotNetwork(once, "b1", view(["a.com"]))).toBe(once);
  });
});
