import { describe, expect, it } from "vitest";
import type { ProviderEvent } from "../provider.js";
import { createRedactor, secretForms } from "../secrets.js";
import { LIVE_MAX_BLOCK_CHARS, type LiveFrame, LiveText, liveAllowed } from "./live.js";

// The text of the answer shown while the model writes it. The rule that matters most: a secret
// that the model writes, cut between two deltas anywhere, never reaches the screen.

const SECRET = "tok/en+Pa=ss_9XyZ!kQ";
const redactor = createRedactor({ API_TOKEN: SECRET });

function make(batchMs = 0) {
  const frames: LiveFrame[] = [];
  const live = new LiveText({
    runId: "r1",
    call: 7,
    attempt: 1,
    feed: { publish: (f) => frames.push(f) },
    redactor,
    batchMs,
  });
  return { frames, live };
}

/** What each block shows after every frame, assembled the way the app does (by offset). */
function replay(frames: LiveFrame[]): {
  states: Map<number, string>[];
  final: Map<number, string>;
} {
  const now = new Map<number, string>();
  const states: Map<number, string>[] = [];
  for (const f of frames) {
    if (f.type === "live.text") {
      const had = now.get(f.block) ?? "";
      if (f.offset !== had.length) throw new Error(`hole in block ${f.block}`);
      now.set(f.block, had + f.text);
    } else if (f.block !== undefined && f.outcome === "dropped") now.delete(f.block);
    states.push(new Map(now));
  }
  return { states, final: now };
}

const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });

function feedPieces(pieces: string[]) {
  const { frames, live } = make();
  for (const p of pieces) live.onEvent(text(p));
  live.complete();
  live.end("recorded");
  return frames;
}

function assertSafe(raw: string, pieces: string[]) {
  const expected = redactor.redact(raw);
  const frames = feedPieces(pieces);
  const { states, final } = replay(frames);
  // The end is exactly the recorded text (the scrubbed one).
  expect(final.get(0) ?? "").toBe(expected);
  for (const forms of secretForms(SECRET)) {
    for (const state of states) expect(state.get(0) ?? "").not.toContain(forms);
  }
  // Every step is a start of the final text: nothing shown is ever taken back or changed, so a
  // piece of a secret that was shown could only be one the final text has too.
  for (const state of states) expect(expected.startsWith(state.get(0) ?? "")).toBe(true);
}

describe("live text: a secret cut between deltas never gets through", () => {
  for (const form of secretForms(SECRET)) {
    it(`every cut of the form "${form.slice(0, 12)}…" (${form.length} chars)`, () => {
      const raw = `Antes ${form} depois, e de novo ${form}.`;
      for (let i = 0; i <= raw.length; i++) assertSafe(raw, [raw.slice(0, i), raw.slice(i)]);
      assertSafe(raw, [...raw]); // one character at a time
      for (let i = 1; i < raw.length; i += 2) {
        for (let j = i + 1; j < raw.length; j += 3) {
          assertSafe(raw, [raw.slice(0, i), raw.slice(i, j), raw.slice(j)]);
        }
      }
    });
  }

  it("holds back as many characters as the longest known text, minus one, until the block closes", () => {
    const { frames, live } = make();
    const longest = redactor.longestNeedle();
    live.onEvent(text("x".repeat(100)));
    const shown = frames
      .filter((f) => f.type === "live.text")
      .map((f) => (f as { text: string }).text);
    expect(shown.join("").length).toBe(100 - (longest - 1));
    live.complete();
    expect(
      frames
        .filter((f) => f.type === "live.text")
        .map((f) => (f as { text: string }).text)
        .join(""),
    ).toBe("x".repeat(100));
  });

  it("does not cut a surrogate pair in two", () => {
    const { frames, live } = make();
    live.onEvent(text(`${"a".repeat(80)}\u{1F600}${"b".repeat(longestMinusOne() - 1)}`));
    for (const f of frames) {
      if (f.type !== "live.text") continue;
      const last = f.text.charCodeAt(f.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it("the summary of a finish goes through the same hold-back", () => {
    const raw = `Feito. A chave é ${SECRET} e acabou.`;
    for (let i = 0; i <= raw.length; i++) {
      const { frames, live } = make();
      live.onEvent({ type: "finish_start" });
      live.onEvent({ type: "summary_delta", text: raw.slice(0, i) });
      live.onEvent({ type: "summary_delta", text: raw.slice(i) });
      live.onEvent({ type: "tool_call", id: "c", name: "finish", args: { summary: raw } });
      live.complete();
      live.end("recorded");
      const { states, final } = replay(frames);
      expect(final.get(0)).toBe(redactor.redact(raw));
      for (const s of states) expect(s.get(0) ?? "").not.toContain(SECRET);
    }
  });

  it("a value the vault learns while the model writes is covered too", () => {
    const mutable = createRedactor({ A_KEY: "first-secret-value" });
    const frames: LiveFrame[] = [];
    const live = new LiveText({
      runId: "r",
      call: 1,
      attempt: 1,
      feed: { publish: (f) => frames.push(f) },
      redactor: mutable,
      batchMs: 0,
    });
    live.onEvent(text("hello "));
    mutable.add("B_KEY", "a-much-longer-second-secret-value-1234567890");
    const secret = "a-much-longer-second-secret-value-1234567890";
    for (const piece of [secret.slice(0, 20), secret.slice(20), " bye"]) live.onEvent(text(piece));
    live.complete();
    const { states, final } = replay(frames);
    expect(final.get(0)).toBe(mutable.redact(`hello ${secret} bye`));
    for (const s of states) expect(s.get(0) ?? "").not.toContain(secret);
  });
});

function longestMinusOne(): number {
  return redactor.longestNeedle() - 1;
}

describe("live text: what is shown", () => {
  it("equals the recorded text at the end, for text blocks separated by a tool call", () => {
    const { frames, live } = make();
    live.onEvent(text("Vou conferir "));
    live.onEvent(text("o arquivo."));
    live.onEvent({ type: "tool_call", id: "c1", name: "read_file", args: {} });
    live.onEvent(text("Agora o segundo."));
    live.complete();
    live.end("recorded");
    const { final } = replay(frames);
    expect([...final.entries()]).toEqual([
      [0, "Vou conferir o arquivo."],
      [1, "Agora o segundo."],
    ]);
    expect(frames[frames.length - 1]).toMatchObject({ type: "live.end", outcome: "recorded" });
  });

  it("a block of only whitespace never shows", () => {
    const { frames, live } = make();
    live.onEvent(text("  \n "));
    live.onEvent({ type: "tool_call", id: "c1", name: "plan", args: {} });
    live.complete();
    expect(frames.filter((f) => f.type === "live.text")).toEqual([]);
  });

  it("text + finish: the typed text is dropped when the finish block starts, and the summary is typed", () => {
    const { frames, live } = make();
    live.onEvent(text("Terminei tudo, "));
    live.onEvent(text(`veja abaixo. ${"mais texto ".repeat(20)}`));
    live.onEvent({ type: "finish_start" });
    live.onEvent({ type: "summary_delta", text: "Resumo " });
    live.onEvent({ type: "summary_delta", text: "final." });
    live.onEvent(text("texto depois do finish")); // that turn posts no part: never shown
    live.onEvent({
      type: "tool_call",
      id: "f",
      name: "finish",
      args: { summary: "Resumo final." },
    });
    live.complete();
    live.end("recorded");
    const dropped = frames.filter((f) => f.type === "live.end" && f.block !== undefined);
    expect(dropped).toEqual([
      { type: "live.end", runId: "r1", call: 7, attempt: 1, block: 0, outcome: "dropped" },
    ]);
    const { final } = replay(frames);
    expect([...final.entries()]).toEqual([[1, "Resumo final."]]);
  });

  it("text before finish that was not sent yet (batched) is never sent at all", () => {
    const { frames, live } = make(50);
    live.onEvent(text("rascunho"));
    live.onEvent({ type: "finish_start" });
    live.onEvent({ type: "summary_delta", text: "Final." });
    live.complete();
    expect(frames.some((f) => f.type === "live.text" && f.text.includes("rascunho"))).toBe(false);
    expect(frames.some((f) => f.type === "live.end" && f.outcome === "dropped")).toBe(false);
  });

  it("batches deltas: one frame per timer tick, whole at the end", () => {
    const timers: (() => void)[] = [];
    const frames: LiveFrame[] = [];
    const live = new LiveText({
      runId: "r",
      call: 1,
      attempt: 1,
      feed: { publish: (f) => frames.push(f) },
      redactor: undefined,
      setTimer: (fn) => timers.push(fn),
      clearTimer: () => {},
    });
    for (const p of ["a", "b", "c"]) live.onEvent(text(p));
    expect(frames).toHaveLength(0);
    expect(timers).toHaveLength(1);
    timers.shift()?.();
    expect(frames).toEqual([
      { type: "live.text", runId: "r", call: 1, attempt: 1, block: 0, offset: 0, text: "abc" },
    ]);
  });

  it("stops after the cap and an aborted or failed call ends without flushing what was held", () => {
    const { frames, live } = make();
    live.onEvent(text("y".repeat(LIVE_MAX_BLOCK_CHARS + 500)));
    live.complete();
    const total = frames
      .filter((f) => f.type === "live.text")
      .map((f) => (f as { text: string }).text)
      .join("").length;
    expect(total).toBe(LIVE_MAX_BLOCK_CHARS);

    const b = make();
    b.live.onEvent(text("z".repeat(100)));
    const before = b.frames.length;
    b.live.end("aborted");
    expect(b.frames.slice(before)).toEqual([
      { type: "live.end", runId: "r1", call: 7, attempt: 1, outcome: "aborted" },
    ]);
  });

  it("a broken feed never breaks the call", () => {
    const live = new LiveText({
      runId: "r",
      call: 1,
      attempt: 1,
      feed: {
        publish: () => {
          throw new Error("down");
        },
      },
      redactor: undefined,
      batchMs: 0,
    });
    expect(() => {
      live.onEvent(text("oi"));
      live.complete();
      live.end("recorded");
    }).not.toThrow();
  });
});

describe("who may be shown live", () => {
  const conv = "c1";
  it("only a conversation run that answers the user, and never an evaluation", () => {
    expect(liveAllowed({ conversationId: conv, origin: "user" })).toBe(true);
    expect(liveAllowed({ conversationId: conv, origin: "reception" })).toBe(true);
    for (const origin of ["routine", "delegation", "proactive"]) {
      expect(liveAllowed({ conversationId: conv, origin })).toBe(false);
    }
    expect(liveAllowed({ conversationId: null, origin: "user" })).toBe(false);
    expect(liveAllowed({ conversationId: undefined, origin: "user" })).toBe(false);
    expect(liveAllowed({ conversationId: conv, origin: "user", isolated: true })).toBe(false);
  });
});
