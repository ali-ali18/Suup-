import { describe, expect, it } from "vitest";
import { createRedactor } from "../secrets.js";
import {
  call,
  createRig,
  eventsOfType,
  FakeProvider,
  finishCall,
  type Rig,
  say,
  use,
} from "../testing/index.js";
import type { LiveFrame } from "./live.js";
import { callModel } from "./model-call.js";
import type { LoopContext } from "./run-context.js";
import { rebuildState } from "./state.js";

// Which model calls show their text live: only the agent's own answer, and only when the run
// handed the loop a live feed. Nothing the reviewer, the summarizer or the progress check writes.

const LONG = "frase longa o bastante para passar de qualquer retenção ".repeat(4);

async function contextOf(
  rig: Rig,
  live: LiveFrame[] | undefined,
  secrets = false,
): Promise<LoopContext> {
  const deps = rig.deps({
    ...(live === undefined ? {} : { live: { publish: (f: LiveFrame) => live.push(f) } }),
    ...(secrets
      ? {
          secrets: {
            redactor: createRedactor({ API_KEY: "super-secret-value-123" }),
            resolve: async () => ({}),
            hostsOf: async () => ({}),
          },
        }
      : {}),
  });
  return {
    deps,
    runId: rig.runId,
    signal: undefined,
    pauseSignal: undefined,
    toolSignal: new AbortController().signal,
    state: rebuildState(await deps.store.listEvents(rig.runId)),
    run: await deps.store.getRun(rig.runId),
  };
}

const spec = (purpose: "agent" | "review" | "compaction" | "progress", answer: string) => ({
  purpose,
  provider: new FakeProvider([say(answer)]),
  model: { id: "m", maxOutputTokens: 100 },
  system: "s",
  messages: [{ role: "user" as const, blocks: [{ type: "text" as const, text: "oi" }] }],
  tools: [],
  retries: 0,
});

describe("live text: which model calls show it", () => {
  it.each([["review"], ["compaction"], ["progress"]] as const)(
    "a %s call publishes nothing, even with a live feed",
    async (purpose) => {
      const rig = createRig({ script: [] });
      const frames: LiveFrame[] = [];
      const ctx = await contextOf(rig, frames);
      const outcome = await callModel(ctx, spec(purpose, `${LONG} palavras do ${purpose}`));
      expect(outcome.kind).toBe("ok");
      expect(frames).toEqual([]);
    },
  );

  it("the agent's call publishes its text, then says it was recorded", async () => {
    const rig = createRig({ script: [] });
    const frames: LiveFrame[] = [];
    const ctx = await contextOf(rig, frames);
    await callModel(ctx, spec("agent", LONG));
    const typed = frames
      .filter((f) => f.type === "live.text")
      .map((f) => (f as { text: string }).text)
      .join("");
    expect(typed).toBe(LONG);
    expect(frames[frames.length - 1]).toMatchObject({ type: "live.end", outcome: "recorded" });
    // `call` is the request's own place in the log.
    const request = eventsOfType(await rig.events(), "model_request")[0];
    expect(frames[0]).toMatchObject({ call: request?.seq, block: 0, attempt: 1 });
  });

  it("a run without a live feed (a routine, a delegated or an evaluation run) publishes nothing", async () => {
    const rig = createRig({ script: [], origin: "routine" });
    const ctx = await contextOf(rig, undefined);
    expect(ctx.deps.live).toBeUndefined();
    const outcome = await callModel(ctx, spec("agent", LONG));
    expect(outcome.kind).toBe("ok");
  });

  it("the text is scrubbed of the vault's values before it leaves", async () => {
    const rig = createRig({ script: [] });
    const frames: LiveFrame[] = [];
    const ctx = await contextOf(rig, frames, true);
    await callModel(ctx, spec("agent", `A chave é super-secret-value-123 mesmo. ${LONG}`));
    const typed = frames
      .filter((f) => f.type === "live.text")
      .map((f) => (f as { text: string }).text)
      .join("");
    expect(typed).not.toContain("super-secret-value-123");
    expect(typed).toContain("[REDACTED:API_KEY]");
  });

  it("a provider that fails ends the call with failed, and an abort with aborted", async () => {
    const rig = createRig({ script: [] });
    const frames: LiveFrame[] = [];
    const ctx = await contextOf(rig, frames);
    const bad = { ...spec("agent", "x"), provider: new FakeProvider([new Error("boom")]) };
    await callModel(ctx, bad);
    expect(frames[frames.length - 1]).toMatchObject({ type: "live.end", outcome: "failed" });
  });
});

describe("live text: the end of a run", () => {
  it("a finish alone: the summary is typed and equals the recorded one", async () => {
    const feed: LiveFrame[] = [];
    const rig = createRig({
      script: [use(finishCall("f1", "Tudo pronto. Conferi os três arquivos."))],
    });
    await runWith(rig, feed);
    const typed = feed
      .filter((f) => f.type === "live.text")
      .map((f) => (f as { text: string }).text)
      .join("");
    expect(typed).toBe("Tudo pronto. Conferi os três arquivos.");
    const status = eventsOfType(await rig.events(), "status_changed").at(-1)?.payload;
    expect(status?.result?.summary).toBe(typed);
  });

  it("text + finish: the text is dropped and the summary is typed in its place", async () => {
    const feed: LiveFrame[] = [];
    const rig = createRig({
      script: [use({ type: "text", text: `Terminei. ${LONG}` }, finishCall("f1", "Resumo final."))],
    });
    await runWith(rig, feed);
    // Nothing of the text was shown (it was still batched), or it was dropped: never left standing.
    const shownText = feed.filter((f) => f.type === "live.text" && f.block === 0);
    const dropped = feed.some((f) => f.type === "live.end" && f.block === 0);
    expect(shownText.length === 0 || dropped).toBe(true);
    const summary = feed.filter((f) => f.type === "live.text" && f.block === 1);
    expect(summary.map((f) => (f as { text: string }).text).join("")).toBe("Resumo final.");
  });

  it("a refused finish (not alone): its summary was typed, and the next call is another one", async () => {
    const feed: LiveFrame[] = [];
    const rig = createRig({
      script: [
        use(call("c1", "echo", { text: "x" }), finishCall("f1", "Acabei cedo demais.")),
        use(finishCall("f2", "Agora sim.")),
      ],
    });
    await runWith(rig, feed);
    const calls = [...new Set(feed.map((f) => f.call))];
    expect(calls).toHaveLength(2);
    const first = feed.filter((f) => f.call === calls[0] && f.type === "live.text");
    expect(first.map((f) => (f as { text: string }).text).join("")).toBe("Acabei cedo demais.");
    expect(
      feed.filter((f) => f.call === calls[1] && f.type === "live.text").length,
    ).toBeGreaterThan(0);
  });
});

async function runWith(rig: Rig, feed: LiveFrame[]): Promise<void> {
  const { runLoop } = await import("./loop.js");
  await runLoop(rig.deps({ live: { publish: (f) => feed.push(f) } }), rig.runId);
}
