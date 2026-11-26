import type { StreamEvent } from "@suup/api";
import { describe, expect, it } from "vitest";
import { makeMessage, makeRun } from "../test-fixtures.js";
import { applyLiveEvent, expireLive, LIVE_SETTLE_MS, liveView, nextLiveExpiry } from "./live.js";
import { applyStreamEvent } from "./reducers.js";
import { type DataState, emptyData } from "./state.js";

// The answer being typed: which bubble a frame belongs to, which recorded message replaces it, and
// what is thrown away. Pure: the time comes in as a number.

const RUN = "11111111-1111-4111-8111-111111111111";
const T0 = 1_000_000;

const text = (
  call: number,
  block: number,
  offset: number,
  t: string,
  attempt = 1,
): StreamEvent => ({
  type: "live.text",
  data: { runId: RUN, call, attempt, block, offset, text: t },
});
const end = (
  call: number,
  outcome: "recorded" | "dropped" | "aborted" | "failed" | "retry",
  extra: { block?: number; attempt?: number } = {},
): StreamEvent => ({
  type: "live.end",
  data: {
    runId: RUN,
    call,
    attempt: extra.attempt ?? 1,
    outcome,
    ...(extra.block === undefined ? {} : { block: extra.block }),
  },
});
const created = (over: Parameters<typeof makeMessage>[0]): StreamEvent => ({
  type: "message.created",
  id: 1,
  data: { message: makeMessage({ authorKind: "bot", runId: RUN, ...over }) },
});
const runUpdated = (status: "running" | "done" | "waiting_user"): StreamEvent => ({
  type: "run.updated",
  id: 2,
  data: { run: makeRun({ id: RUN, status }) },
});

function play(events: [StreamEvent, number?][], from: DataState = emptyData()): DataState {
  return events.reduce((s, [e, now]) => applyStreamEvent(s, e, now ?? T0), from);
}
const view = (s: DataState) => liveView(s.live, new Set([RUN]));

describe("typed text: the bubble grows", () => {
  it("appends in order, replaces on a snapshot (offset 0), and ignores a hole", () => {
    let s = play([[text(5, 0, 0, "Olá")], [text(5, 0, 3, ", mun")]]);
    expect(view(s).typing).toMatchObject([{ call: 5, text: "Olá, mun" }]);
    s = play([[text(5, 0, 99, "buraco")]], s);
    expect(view(s).typing[0]?.text).toBe("Olá, mun");
    s = play([[text(5, 0, 0, "Olá, mundo!")]], s); // a reconnection's snapshot
    expect(view(s).typing[0]?.text).toBe("Olá, mundo!");
  });

  it("shows nothing for text that is only whitespace, and trims what it shows", () => {
    expect(view(play([[text(5, 0, 0, " \n ")]])).typing).toEqual([]);
    expect(view(play([[text(5, 0, 0, "  oi \n")]])).typing[0]?.text).toBe("oi");
  });

  it("keeps the blocks of one call apart, in order", () => {
    const s = play([[text(5, 1, 0, "segundo")], [text(5, 0, 0, "primeiro")]]);
    expect(view(s).typing.map((b) => b.text)).toEqual(["primeiro", "segundo"]);
  });
});

describe("typed text: the recorded message takes its place", () => {
  it("a part (eventSeq) takes the first block of the newest call before it, and the bubble's key stays", () => {
    const s = play([
      [text(5, 0, 0, "Vou conferir")],
      [text(5, 1, 0, "e depois outra")],
      [end(5, "recorded")],
    ]);
    const key0 = view(s).typing[0]?.key as string;
    const after = play([[created({ id: "m1", text: "Vou conferir", eventSeq: 9 })]], s);
    expect(view(after).typing.map((b) => b.text)).toEqual(["e depois outra"]); // the other waits
    expect(view(after).keyOf).toEqual({ m1: key0 });
    const both = play([[created({ id: "m2", text: "e depois outra", eventSeq: 9 })]], after);
    expect(view(both).typing).toEqual([]);
    expect(Object.keys(view(both).keyOf).sort()).toEqual(["m1", "m2"]);
  });

  it("a part of an older response never takes the bubble of a newer call", () => {
    const s = play([[text(20, 0, 0, "ainda escrevendo")]]);
    const after = play([[created({ id: "m1", text: "x", eventSeq: 9 })]], s);
    expect(view(after).typing).toHaveLength(1);
    expect(view(after).keyOf).toEqual({});
  });

  it("the end message (no eventSeq) takes the newest call", () => {
    const s = play([[text(5, 0, 0, "antigo")], [text(20, 0, 0, "A resposta final")]]);
    const after = play([[created({ id: "done", text: "A resposta final" })]], s);
    expect(view(after).keyOf).toEqual({ done: "live-" + `${RUN}:20:0` });
  });

  it("the same message twice (a replay) is placed once", () => {
    const s = play([[text(5, 0, 0, "a")], [text(5, 1, 0, "b")]]);
    const message = created({ id: "m1", text: "a", eventSeq: 9 });
    const once = play([[message]], s);
    expect(play([[message]], once)).toBe(once);
  });

  it("a message of a user, or of another run, takes nothing", () => {
    const s = play([[text(5, 0, 0, "a")]]);
    expect(view(play([[created({ id: "u", authorKind: "user" })]], s)).keyOf).toEqual({});
    expect(
      view(play([[created({ id: "o", runId: "someone-else", eventSeq: 9 })]], s)).keyOf,
    ).toEqual({});
  });

  it("a frame that arrives after its message took the bubble does not bring it back", () => {
    let s = play([[text(5, 0, 0, "abc")], [end(5, "recorded")]]);
    s = play([[created({ id: "m1", text: "abc", eventSeq: 9 })]], s);
    s = play([[text(5, 0, 3, "d")], [text(5, 0, 0, "abcd")]], s);
    expect(view(s).typing).toEqual([]);
  });
});

describe("typed text: what is thrown away", () => {
  it("a block dropped by the server goes at once (text before a finish)", () => {
    const s = play([
      [text(5, 0, 0, "rascunho")],
      [text(5, 1, 0, "Resumo")],
      [end(5, "dropped", { block: 0 })],
    ]);
    expect(view(s).typing.map((b) => b.text)).toEqual(["Resumo"]);
  });

  it.each(["aborted", "failed", "retry"] as const)(
    "a call that ended %s goes at once, and nothing of it comes back",
    (outcome) => {
      let s = play([[text(5, 0, 0, "abc")], [end(5, outcome)]]);
      expect(view(s).typing).toEqual([]);
      s = play([[text(5, 0, 3, "d")]], s);
      expect(view(s).typing).toEqual([]);
    },
  );

  it("a retry shows the new attempt from its start", () => {
    let s = play([[text(5, 0, 0, "primeira tentativa")], [end(5, "retry")]]);
    s = play([[text(5, 0, 0, "segunda", 2)]], s);
    expect(view(s).typing.map((b) => b.text)).toEqual(["segunda"]);
    s = play([[text(5, 0, 18, "atrasado", 1)]], s);
    expect(view(s).typing.map((b) => b.text)).toEqual(["segunda"]);
  });

  it("a refused finish: its summary is thrown away when the next call starts, if no message took it", () => {
    let s = play([[text(5, 0, 0, "Acabei cedo demais.")], [end(5, "recorded")]]);
    expect(nextLiveExpiry(s)).toBeUndefined();
    s = play([[text(11, 0, 0, "Agora sim.")]], s); // the newer call
    expect(nextLiveExpiry(s)).toBe(T0 + LIVE_SETTLE_MS);
    expect(view(expireLive(s, T0 + LIVE_SETTLE_MS - 1)).typing).toHaveLength(2);
    const later = expireLive(s, T0 + LIVE_SETTLE_MS);
    expect(view(later).typing.map((b) => b.text)).toEqual(["Agora sim."]);
    expect(nextLiveExpiry(later)).toBeUndefined();
  });

  it("a turn that was sent back (text only, then the next call): the text is thrown away after the wait", () => {
    const s = play([[text(5, 0, 0, "quase lá")], [end(5, "recorded")], [text(9, 0, 0, "outra")]]);
    expect(view(expireLive(s, T0 + LIVE_SETTLE_MS)).typing.map((b) => b.text)).toEqual(["outra"]);
  });

  it("when the run stops working, what no message took is thrown away after the wait; a message that comes first keeps it", () => {
    let s = play([[text(5, 0, 0, "Pronto.")], [end(5, "recorded")], [runUpdated("done"), T0]]);
    expect(nextLiveExpiry(s)).toBe(T0 + LIVE_SETTLE_MS);
    const placed = applyLiveEvent(s, created({ id: "done", text: "Pronto." }), T0 + 500);
    expect(view(expireLive(placed, T0 + LIVE_SETTLE_MS)).keyOf).toHaveProperty("done");
    s = expireLive(s, T0 + LIVE_SETTLE_MS);
    expect(view(s).typing).toEqual([]);
  });

  it("a run that is still running keeps its text", () => {
    const s = play([[text(5, 0, 0, "Pronto.")], [runUpdated("running")]]);
    expect(nextLiveExpiry(s)).toBeUndefined();
  });

  it("is never a message: the typed text does not touch the messages or the events", () => {
    const before = emptyData();
    const s = play([[text(5, 0, 0, "abc")], [end(5, "recorded")]], before);
    expect({ ...s, live: {} }).toEqual(before);
  });
});
