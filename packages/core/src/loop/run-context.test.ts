import { describe, expect, it } from "vitest";
import type { Message } from "../messages.js";
import { validateConversation } from "../messages.js";
import { replayRun } from "../replay.js";
import {
  call,
  createRig,
  eventsOfType,
  eventTypes,
  finishCall,
  type Rig,
  say,
  testBot,
  textOf,
  use,
} from "../testing/index.js";
import { historyMessages } from "./history.js";
import type { RunContextSnapshot } from "./run-context.js";
import { rebuildState } from "./state.js";
import type { StoredEvent } from "./store.js";

const turn = (role: "user" | "assistant", text: string): Message => ({
  role,
  blocks: [{ type: "text", text }],
});

const SNAPSHOT: RunContextSnapshot = {
  rules: [
    { id: "r1", text: "Always answer in formal Portuguese." },
    { id: "r2", text: "Never delete files without asking." },
  ],
  profile: [{ id: "p1", text: "The user's name is Marina and she lives in Recife." }],
  history: [
    turn("user", "My dog is called Bolt."),
    turn("assistant", "Nice name!"),
    turn("user", "Remember that I like short answers."),
    turn("assistant", "Understood."),
  ],
};

/** A rig whose context comes from `loadRunContext`, counting its calls. */
function rigWithContext(
  snapshot: RunContextSnapshot | (() => RunContextSnapshot),
  options: Parameters<typeof createRig>[0],
): { rig: Rig; loads: string[] } {
  const loads: string[] = [];
  const rig = createRig(options);
  const loadRunContext = async (runId: string) => {
    loads.push(runId);
    return typeof snapshot === "function" ? snapshot() : snapshot;
  };
  const original = rig.deps.bind(rig);
  rig.deps = (overrides = {}) => original({ loadRunContext, ...overrides });
  rig.run = (opts) => import("./loop.js").then((m) => m.runLoop(rig.deps(), rig.runId, opts));
  return { rig, loads };
}

describe("run context snapshot", () => {
  it("is loaded once, recorded right after run_started and rendered in the system prompt", async () => {
    const { rig, loads } = rigWithContext(SNAPSHOT, {
      script: [use(call("c1", "echo", { text: "x" })), say("Done.")],
    });
    expect(await rig.run()).toBe("done");

    expect(loads).toHaveLength(1);
    const events = await rig.events();
    expect(eventTypes(events).slice(0, 3)).toEqual([
      "run_started",
      "context_loaded",
      "model_request",
    ]);
    const [loaded] = eventsOfType(events, "context_loaded");
    expect(loaded?.payload.rules.map((r) => r.id)).toEqual(["r1", "r2"]);

    const system = rig.provider.requests[0]?.system ?? "";
    const rules = system.indexOf("## Standing rules from the user");
    const profile = system.indexOf("## What you know about the user");
    expect(system.indexOf("## Who you are")).toBeLessThan(rules);
    expect(rules).toBeLessThan(profile);
    // The shared rules come first (a stable prefix for the prompt cache), the user's after.
    expect(system.indexOf("## How you work")).toBeLessThan(system.indexOf("## Who you are"));
    // The request says where that shared part ends, for the provider's cache breakpoint.
    expect(rig.provider.requests[0]?.systemCacheBreak).toBe(system.indexOf("## Who you are"));
    // In the given order, binding wording, one bullet each.
    expect(system).toContain("binding");
    expect(system).toContain("outrank your own preferences");
    expect(system.indexOf("- Always answer in formal Portuguese.")).toBeLessThan(
      system.indexOf("- Never delete files without asking."),
    );
    expect(system).toContain("- The user's name is Marina and she lives in Recife.");
  });

  it("omits an empty section, and everything when there is no snapshot", async () => {
    const onlyProfile = rigWithContext(
      { rules: [], profile: SNAPSHOT.profile, history: [] },
      { script: [say("Hi.")] },
    );
    await onlyProfile.rig.run();
    const system = onlyProfile.rig.provider.requests[0]?.system ?? "";
    expect(system).not.toContain("Standing rules from the user");
    expect(system).toContain("What you know about the user");

    const plain = createRig({ script: [say("Hi.")] });
    await plain.run();
    const bare = plain.provider.requests[0]?.system ?? "";
    expect(bare).not.toContain("Standing rules from the user");
    expect(bare).not.toContain("What you know about the user");
    expect(eventTypes(await plain.events())).not.toContain("context_loaded");
  });

  it("places the history before the objective, alternating roles, valid for every provider", async () => {
    const { rig } = rigWithContext(
      { ...SNAPSHOT, historyNote: "Earlier messages were left out; use search_conversations." },
      { objective: "What is my dog called?", script: [say("Bolt.")] },
    );
    await rig.run();
    const messages = rig.provider.requests[0]?.messages ?? [];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user"]);
    expect(textOf(messages[0])).toContain("Earlier messages were left out");
    expect(textOf(messages[0])).toContain("My dog is called Bolt.");
    expect(textOf(messages[3])).toBe("Understood.");
    expect(textOf(messages[4])).toContain("What is my dog called?");
    expect(textOf(messages[4])).toContain("[STATE REMINDER");
    expect(validateConversation(messages)).toEqual([]);
  });

  it("merges a trailing unanswered user message into the objective turn", async () => {
    const { rig } = rigWithContext(
      { rules: [], profile: [], history: [turn("user", "Unanswered question.")] },
      { objective: "Now this.", script: [say("ok")] },
    );
    await rig.run();
    const messages = rig.provider.requests[0]?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0])).toContain("Unanswered question.");
    expect(textOf(messages[0])).toContain("Now this.");
  });

  it("a note alone (everything older was omitted) still reaches the model", async () => {
    const { rig } = rigWithContext(
      { rules: [], profile: [], history: [], historyNote: "Older messages are not shown." },
      { script: [say("ok")] },
    );
    await rig.run();
    const messages = rig.provider.requests[0]?.messages ?? [];
    expect(messages).toHaveLength(1);
    expect(textOf(messages[0])).toContain("Older messages are not shown.");
  });

  it("keeps the system prompt byte-identical and only grows the conversation at its end", async () => {
    const { rig } = rigWithContext(SNAPSHOT, {
      objective: "Do the job.",
      script: [
        use(call("c1", "echo", { text: "a" })),
        use(call("c2", "echo", { text: "b" }), call("c3", "counter")),
        use(call("c4", "write_note", { name: "n.txt", body: "x" })),
        say("All done."),
      ],
    });
    // A message arrives while the run works, too.
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "Also be quick." });
    expect(await rig.run()).toBe("done");

    const requests = rig.provider.requests;
    expect(requests.length).toBeGreaterThanOrEqual(4);
    const system = requests[0]?.system;
    expect(system).toContain("Standing rules from the user");
    for (const [i, req] of requests.entries()) {
      expect(req.system, `request ${i} system`).toBe(system);
      expect(req.tools, `request ${i} tools`).toEqual(requests[0]?.tools);
      if (i === 0) continue;
      const previous = requests[i - 1]?.messages ?? [];
      // Every earlier message is untouched: the new request only adds to the end.
      expect(req.messages.slice(0, previous.length), `request ${i} prefix`).toEqual(previous);
      expect(req.messages.length).toBeGreaterThan(previous.length);
    }
  });

  it("treats history as compactable like any old message", async () => {
    const big = "The earlier chat about the garden. ".repeat(20);
    const { rig } = rigWithContext(
      {
        rules: [],
        profile: [],
        history: [
          turn("user", big),
          turn("assistant", "Noted the garden."),
          turn("user", "More."),
          turn("assistant", "Ok."),
        ],
      },
      {
        bot: { model: { id: "m", contextWindow: 1000, maxOutputTokens: 500 } },
        script: [
          use(call("c1", "echo", { text: "alpha" })),
          use(call("c2", "echo", { text: "bravo" })),
          {
            blocks: [call("c3", "echo", { text: "charlie" })],
            usage: { inputTokens: 800, outputTokens: 10 },
          },
          say("SUMMARY of the garden chat."),
          say("All done."),
        ],
      },
    );
    expect(await rig.run()).toBe("done");
    const [compacted] = eventsOfType(await rig.events(), "compacted");
    expect(compacted).toBeDefined();
    const summarizer = rig.provider.requests.find((r) => r.tools.length === 0);
    expect(textOf(summarizer?.messages[0])).toContain("The earlier chat about the garden.");
    const last = rig.provider.requests.at(-1)?.messages ?? [];
    expect(textOf(last[0])).toContain("SUMMARY of the garden chat.");
    expect(validateConversation(last)).toEqual([]);
  });

  it("is not loaded for a run that already went on without it", async () => {
    // A run started before this feature: events past run_started, no context_loaded.
    const plain = createRig({ script: [use(call("c1", "echo", { text: "x" })), say("Done.")] });
    await plain.run();
    const loads: string[] = [];
    const status = await import("./loop.js").then((m) =>
      m.runLoop(
        plain.deps({
          loadRunContext: async (id) => {
            loads.push(id);
            return SNAPSHOT;
          },
        }),
        plain.runId,
      ),
    );
    expect(status).toBe("done");
    expect(loads).toEqual([]);
    expect(eventTypes(await plain.events())).not.toContain("context_loaded");
  });

  it("rebuilds the same state from the log, history first", async () => {
    const { rig } = rigWithContext(SNAPSHOT, { script: [say("Hi.")] });
    await rig.run();
    const state = rebuildState(await rig.events());
    expect(state.contextLoaded).toBe(true);
    expect(state.context?.rules).toHaveLength(2);
    expect(state.messages[0]?.role).toBe("user");
    expect(textOf(state.messages[0])).toContain("My dog is called Bolt.");
    expect(validateConversation(state.messages)).toEqual([]);
  });
});

describe("historyMessages", () => {
  it("keeps text only, drops blanks and leading assistant messages, merges equal roles", () => {
    const out = historyMessages(
      [
        turn("assistant", "orphan"),
        turn("user", "a"),
        {
          role: "user",
          blocks: [
            { type: "text", text: "b" },
            { type: "tool_call", id: "x", name: "n", args: {} },
          ],
        },
        turn("assistant", "   "),
        turn("assistant", "c"),
      ],
      undefined,
    );
    expect(out.map((m) => [m.role, textOf(m)])).toEqual([
      ["user", "a\nb"],
      ["assistant", "c"],
    ]);
  });

  it("is empty for no history and no note", () => {
    expect(historyMessages([], undefined)).toEqual([]);
    expect(historyMessages([], "   ")).toEqual([]);
  });
});

describe("replay of a run with context", () => {
  it("is identical and uses the recorded context, whatever memory says now", async () => {
    let memory: RunContextSnapshot = SNAPSHOT;
    const { rig, loads } = rigWithContext(() => memory, {
      objective: "What do you know about me?",
      script: [
        use(call("c1", "echo", { text: "x" })),
        use(finishCall("c2", "Marina from Recife.")),
      ],
    });
    expect(await rig.run()).toBe("done");
    expect(loads).toHaveLength(1);
    const events = await rig.events();

    // Memory changes after the run: the recording is what counts.
    memory = {
      rules: [{ id: "r9", text: "Answer only in French." }],
      profile: [],
      history: [],
    };
    const report = await replayRun(events, { bot: testBot() });
    expect(report.identical).toBe(true);
    expect(report.requestDiffs).toEqual([]);
    expect(loads).toHaveLength(1); // nothing called the dep again
    expect(eventTypes(events)).toContain("context_loaded");
  });
});

describe("the clock of a run", () => {
  const WITH_FACTS: RunContextSnapshot = {
    ...SNAPSHOT,
    now: { iso: new Date(1_700_000_000_000).toISOString(), timeZone: "America/Sao_Paulo" },
    team: [{ name: "Finanças", description: "Cuida do dinheiro." }],
    machine: { terminal: true, files: true, isolated: true },
    connectors: [],
  };

  it("is recorded in context_loaded, once, and the system prompt never moves while the time does", async () => {
    const { rig } = rigWithContext(WITH_FACTS, {
      script: [
        use(call("c1", "echo", { text: "a" })),
        use(call("c2", "echo", { text: "b" })),
        say("Done."),
      ],
    });
    // Each turn happens an hour later than the one before.
    const original = rig.provider.generate.bind(rig.provider);
    rig.provider.generate = (request) => {
      rig.clock.advance(3_600_000);
      return original(request);
    };
    expect(await rig.run()).toBe("done");

    const [loaded] = eventsOfType(await rig.events(), "context_loaded");
    expect(loaded?.payload.now).toEqual(WITH_FACTS.now);
    expect(loaded?.payload.team).toEqual(WITH_FACTS.team);
    expect(loaded?.payload.machine).toEqual(WITH_FACTS.machine);

    const requests = rig.provider.requests;
    expect(requests.length).toBeGreaterThanOrEqual(3);
    const systems = new Set(requests.map((r) => r.system));
    expect(systems.size).toBe(1); // byte-identical on every request of the run
    expect([...systems][0]).toContain(
      "## Now\n\nIt is Tuesday 2023-11-14, 19:13 (America/Sao_Paulo, GMT-3)",
    );

    // The live time is in the reminder of the last user turn, and it moves.
    const reminders = requests.map((r) => {
      const last = r.messages.at(-1);
      return textOf(last).split("Now (the current time):\n")[1]?.split("\n")[0];
    });
    expect(new Set(reminders).size).toBe(requests.length);
    expect(reminders[0]).toContain("Tuesday 2023-11-14");
  });

  it("is replayed identically: the replay says the same, whatever the real clock says", async () => {
    const { rig } = rigWithContext(WITH_FACTS, {
      script: [use(call("c1", "echo", { text: "x" })), say("Done.")],
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    const real = Date.now;
    Date.now = () => 0;
    try {
      const report = await replayRun(events, { bot: testBot() });
      expect(report.identical).toBe(true);
      expect(report.requestDiffs).toEqual([]);
    } finally {
      Date.now = real;
    }
  });

  /** A recorded run of two requests, with the stored `createdAt` of each request moved by `shiftMs`. */
  async function recordedWithStamp(
    shiftMs: number,
    keepAt: boolean,
  ): Promise<{ events: StoredEvent[]; reminders: string[] }> {
    const { rig } = rigWithContext(WITH_FACTS, {
      script: [use(call("c1", "echo", { text: "x" })), say("Done.")],
    });
    // The request is built a few ms before a minute boundary (19:13:59.995 in the user's zone).
    rig.clock.now = 1_700_000_039_995;
    expect(await rig.run()).toBe("done");
    const events = (await rig.events()).map((event) => {
      if (event.type !== "model_request") return event;
      const { at, ...rest } = event.payload;
      return {
        ...event,
        payload: keepAt ? event.payload : rest,
        createdAt: new Date(new Date(at ?? event.createdAt).getTime() + shiftMs),
      } as StoredEvent;
    });
    const reminders = rig.provider.requests.map(
      (r) => textOf(r.messages.at(-1)).split("Now (the current time):\n")[1]?.split("\n")[0] ?? "",
    );
    return { events, reminders };
  }

  it("records the instant each request was built at, and the reminder shows exactly that time", async () => {
    const { events, reminders } = await recordedWithStamp(0, true);
    const requests = eventsOfType(events, "model_request");
    expect(requests.length).toBeGreaterThanOrEqual(2);
    for (const request of requests)
      expect(request.payload.at).toBe(request.createdAt.toISOString());
    expect(reminders[0]).toContain("2023-11-14, 19:13 ");
  });

  it("a replay rebuilds the request at the recorded instant, even when the event was stored in the next minute", async () => {
    // The event is stamped 90 s after the build (the database clock, a few ms later in real life).
    const { events } = await recordedWithStamp(90_000, true);
    const report = await replayRun(events, { bot: testBot() });
    expect(report.requestDiffs).toEqual([]);
    expect(report.identical).toBe(true);
  });

  it("a recording without `at` (made before it existed) is replayed at the event's createdAt", async () => {
    const same = await recordedWithStamp(0, false);
    for (const request of eventsOfType(same.events, "model_request")) {
      expect(request.payload.at).toBeUndefined();
    }
    const report = await replayRun(same.events, { bot: testBot() });
    expect(report.requestDiffs).toEqual([]);
    expect(report.identical).toBe(true);
    // The fallback is the stored time: a stamp in another minute is a visible difference.
    const shifted = await recordedWithStamp(90_000, false);
    const other = await replayRun(shifted.events, { bot: testBot() });
    expect(other.requestDiffs.length).toBeGreaterThan(0);
    expect(other.requestDiffs[0]?.changes.map((c) => c.field)).toEqual(["messages"]);
  });

  it("a run recorded before the clock existed has no clock block and no live time", async () => {
    const { rig } = rigWithContext(SNAPSHOT, { script: [say("Hi.")] });
    await rig.run();
    const request = rig.provider.requests[0];
    expect(request?.system).not.toContain("## Now");
    expect(textOf(request?.messages.at(-1))).not.toContain("Now (the current time)");
  });
});
