import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateConversation } from "../messages.js";
import { ProviderError } from "../provider.js";
import {
  call,
  createRig,
  eventsOfType,
  eventTypes,
  finishCall,
  lastStatus,
  planCall,
  problemsInRequests,
  REMINDER_MARK,
  type Rig,
  say,
  testTools,
  textOf,
  use,
} from "../testing/index.js";
import { defineTool } from "../tool.js";
import { runLoop } from "./loop.js";
import { rebuildState } from "./state.js";

/** Every request the provider got must be valid and carry the state reminder. */
function expectCleanRequests(rig: Rig): void {
  expect(problemsInRequests(rig.provider)).toEqual([]);
}

const s = (id: string, status: "pending" | "in_progress" | "done" | "dropped", note?: string) => ({
  id,
  title: `Step ${id}`,
  status,
  ...(note === undefined ? {} : { note }),
});

/** The tool results the model saw in request `index`, as `callId -> content`. */
function resultsIn(rig: Rig, index: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const message of rig.provider.requests[index]?.messages ?? []) {
    for (const block of message.blocks) {
      if (block.type === "tool_result") out[block.callId] = block.content;
    }
  }
  return out;
}

describe("runLoop: finishing", () => {
  it("answers a simple question without a plan", async () => {
    const rig = createRig({ script: [say("Four.")], objective: "What is 2+2?" });
    expect(await rig.run()).toBe("done");

    const events = await rig.events();
    expect(eventTypes(events)).toEqual([
      "run_started",
      "model_request",
      "model_response",
      "status_changed",
    ]);
    expect(lastStatus(events)).toEqual({
      from: "running",
      to: "done",
      result: { summary: "Four." },
    });
    expect((await rig.record()).status).toBe("done");
    expect(rig.store.outcome(rig.runId).result).toEqual({ summary: "Four." });
    expectCleanRequests(rig);
  });

  it("runs a multi-step task: plan, tools, finish accepted", async () => {
    const rig = createRig({
      objective: "Write a note and check it.",
      criteria: ["notes.txt exists", "the echo tool works"],
      script: [
        use(
          planCall("c1", [s("s1", "in_progress"), s("s2", "pending")]),
          call("c2", "echo", { text: "hello" }),
        ),
        use(
          planCall("c3", [s("s1", "done"), s("s2", "in_progress")]),
          call("c4", "write_note", { name: "notes.txt", body: "hi" }),
        ),
        use(planCall("c5", [s("s1", "done"), s("s2", "done")])),
        use(
          finishCall("c6", "Wrote notes.txt and checked echo.", [
            { criterion: "notes.txt exists", evidence: "write_note returned: wrote notes.txt" },
            { criterion: "2", evidence: "echo returned: echo: hello" },
          ]),
        ),
      ],
    });
    expect(await rig.run()).toBe("done");

    const events = await rig.events();
    expect(rig.executor.files.get("/workspace/notes.txt")).toBe("hi");
    expect((await rig.record()).plan.map((p) => p.status)).toEqual(["done", "done"]);

    // Each call has its tool_call before its tool_result.
    const order = events
      .filter((e) => e.type === "tool_call" || e.type === "tool_result")
      .map((e) => `${e.type}:${e.payload.callId}`);
    expect(order).toEqual([
      "tool_call:c1",
      "tool_result:c1",
      "tool_call:c2",
      "tool_result:c2",
      "tool_call:c3",
      "tool_result:c3",
      "tool_call:c4",
      "tool_result:c4",
      "tool_call:c5",
      "tool_result:c5",
      "tool_call:c6",
      "tool_result:c6",
    ]);
    const attempts = eventsOfType(events, "finish_attempt");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.payload).toMatchObject({ accepted: true, rejectionReasons: [] });
    expect(rig.store.outcome(rig.runId).result).toEqual({
      summary: "Wrote notes.txt and checked echo.",
      evidence: [
        { criterion: "notes.txt exists", evidence: "write_note returned: wrote notes.txt" },
        { criterion: "2", evidence: "echo returned: echo: hello" },
      ],
    });
    expect(rig.provider.calls).toBe(4);
    expect(rig.store.heartbeats(rig.runId)).toBeGreaterThan(0);
    const run = await rig.record();
    expect(run.turns).toBe(4);
    expect(run.inputTokens).toBe(40);
    expectCleanRequests(rig);
  });

  it("does not accept text as the end once a plan exists: nudges with the open steps", async () => {
    const rig = createRig({
      script: [
        use(planCall("c1", [s("s1", "done"), s("s2", "in_progress"), s("s3", "pending")])),
        say("All done!"),
        use(planCall("c2", [s("s1", "done"), s("s2", "done"), s("s3", "done")])),
        use(finishCall("c3", "Done.")),
      ],
    });
    expect(await rig.run()).toBe("done");

    const nudges = eventsOfType(await rig.events(), "nudge");
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.payload.text).toContain("without calling finish");
    expect(nudges[0]?.payload.text).toContain("[in_progress] s2: Step s2");
    expect(nudges[0]?.payload.text).toContain("[pending] s3: Step s3");
    expect(nudges[0]?.payload.text).not.toContain("s1:");
    // The model sees the nudge in its next request, after the plan result.
    const lastUser = rig.provider.requests[2]?.messages.at(-1);
    expect(textOf(lastUser)).toContain("[Harness notice]");
    expectCleanRequests(rig);
  });

  it("nudges even when the plan is fully closed", async () => {
    const rig = createRig({
      script: [
        use(planCall("c1", [s("s1", "done")])),
        say("Finished."),
        use(finishCall("c2", "Done.")),
      ],
    });
    expect(await rig.run()).toBe("done");
    const [nudge] = eventsOfType(await rig.events(), "nudge");
    expect(nudge?.payload.text).toContain("All steps are closed");
  });

  it("fails with origin model after three stops without finishing", async () => {
    const rig = createRig({
      script: [use(planCall("c1", [s("s1", "in_progress")])), say("a"), say("b"), say("c")],
    });
    expect(await rig.run()).toBe("failed");
    const events = await rig.events();
    expect(eventsOfType(events, "nudge")).toHaveLength(2);
    const status = lastStatus(events);
    expect(status?.to).toBe("failed");
    expect(status?.failure?.origin).toBe("model");
    expect(status?.failure?.detail).toContain("3 consecutive turns without any tool call");
    expect(rig.store.outcome(rig.runId).failure?.origin).toBe("model");
    expect(rig.provider.calls).toBe(4);
  });

  it("a tool call between stops resets the no-progress count", async () => {
    const rig = createRig({
      script: [
        use(planCall("c1", [s("s1", "in_progress")])),
        say("a"),
        say("b"),
        use(call("c2", "echo", { text: "x" })),
        say("c"),
        say("d"),
        use(planCall("c3", [s("s1", "done")])),
        use(finishCall("c4", "ok")),
      ],
    });
    expect(await rig.run()).toBe("done");
  });

  it("treats an empty response as no progress and nudges", async () => {
    const rig = createRig({ script: [{ blocks: [] }, say("Hello")] });
    expect(await rig.run()).toBe("done");
    const [nudge] = eventsOfType(await rig.events(), "nudge");
    expect(nudge?.payload.reason).toBe("empty_response");
    expectCleanRequests(rig);
  });
});

describe("runLoop: finish validation", () => {
  const reasonsOf = async (rig: Rig) =>
    eventsOfType(await rig.events(), "finish_attempt").map((e) => e.payload.rejectionReasons);

  it("rejects while steps are open, and the reasons reach the model", async () => {
    const rig = createRig({
      script: [
        use(planCall("c1", [s("s1", "in_progress"), s("s2", "pending")])),
        use(finishCall("c2", "Done.")),
        use(planCall("c3", [s("s1", "done"), s("s2", "done")])),
        use(finishCall("c4", "Done for real.")),
      ],
    });
    expect(await rig.run()).toBe("done");
    const [first, second] = await reasonsOf(rig);
    expect(first?.join(" ")).toContain('s1 "Step s1" (in_progress)');
    expect(first?.join(" ")).toContain('s2 "Step s2" (pending)');
    expect(second).toEqual([]);
    const seen = resultsIn(rig, 2).c2;
    expect(seen).toContain("Finish was not accepted");
    expect(seen).toContain("s1");
    expectCleanRequests(rig);
  });

  it("rejects missing evidence; criteria match by exact text or by 1-based index", async () => {
    const rig = createRig({
      criteria: ["Tests pass", "Docs updated"],
      script: [
        use(finishCall("c1", "Done.", [{ criterion: "Tests pass", evidence: "42 passed" }])),
        use(
          finishCall("c2", "Done.", [
            { criterion: "1", evidence: "42 passed" },
            { criterion: "Docs updated", evidence: "README.md changed" },
          ]),
        ),
      ],
    });
    expect(await rig.run()).toBe("done");
    const [first, second] = await reasonsOf(rig);
    expect(first).toHaveLength(1);
    expect(first?.[0]).toContain('acceptance criterion 2 ("Docs updated") has no evidence');
    expect(second).toEqual([]);
    expect(resultsIn(rig, 1).c1).toContain("criterion 2");
  });

  it("returns every reason at once: empty summary, empty evidence, open steps", async () => {
    const rig = createRig({
      criteria: ["A", "B"],
      script: [
        use(planCall("c1", [s("s1", "pending")])),
        use(finishCall("c2", "  ", [{ criterion: "A", evidence: " " }])),
        use(planCall("c3", [s("s1", "done")])),
        use(
          finishCall("c4", "ok", [
            { criterion: "A", evidence: "seen" },
            { criterion: "B", evidence: "seen too" },
          ]),
        ),
      ],
    });
    expect(await rig.run()).toBe("done");
    const [first] = await reasonsOf(rig);
    expect(first).toHaveLength(4);
    const joined = (first ?? []).join("\n");
    expect(joined).toContain("the summary is empty");
    expect(joined).toContain("plan steps are still open");
    expect(joined).toContain("the evidence for acceptance criterion 1");
    expect(joined).toContain('criterion 2 ("B") has no evidence');
    // All reasons are in the one tool result the model gets.
    const seen = resultsIn(rig, 2).c2 ?? "";
    for (const part of ["summary is empty", "still open", "criterion 1", "criterion 2"]) {
      expect(seen).toContain(part);
    }
  });

  it("rejects an empty evidence text even when there are no criteria", async () => {
    const rig = createRig({
      script: [
        use(finishCall("c1", "ok", [{ criterion: "whatever", evidence: "" }])),
        use(finishCall("c2", "ok")),
      ],
    });
    expect(await rig.run()).toBe("done");
    const [first] = await reasonsOf(rig);
    expect(first?.[0]).toContain("is empty");
  });

  it("rejects a finish that is not alone in its turn; the other tool still runs", async () => {
    const rig = createRig({
      script: [
        use(call("c1", "echo", { text: "hi" }), finishCall("c2", "Done.")),
        use(finishCall("c3", "Done.")),
      ],
    });
    expect(await rig.run()).toBe("done");
    const results = resultsIn(rig, 1);
    expect(results.c1).toBe("echo: hi");
    expect(results.c2).toContain(
      "call finish alone, after you have seen the results of the other tools",
    );
    const [first] = await reasonsOf(rig);
    expect(first?.[0]).toContain("call finish alone");
  });

  it("fails with origin model after three rejected finishes in a row", async () => {
    const rig = createRig({
      script: [use(finishCall("c1", "")), use(finishCall("c2", " ")), use(finishCall("c3", ""))],
    });
    expect(await rig.run()).toBe("failed");
    const status = lastStatus(await rig.events());
    expect(status?.failure?.origin).toBe("model");
    expect(rig.provider.calls).toBe(3);
  });

  it("reports invalid finish arguments as a tool error", async () => {
    const rig = createRig({
      script: [use(call("c1", "finish", { evidence: [] })), use(finishCall("c2", "ok"))],
    });
    expect(await rig.run()).toBe("done");
    expect(resultsIn(rig, 1).c1).toContain('Invalid arguments for tool "finish"');
  });
});

describe("runLoop: plan validation", () => {
  it("returns validation errors to the model and saves only valid plans", async () => {
    const rig = createRig({
      script: [
        use(
          planCall("p1", [s("a", "pending"), s("a", "pending")]),
          planCall("p2", [{ id: "a", title: "  ", status: "pending" }]),
          planCall("p3", [s("a", "in_progress"), s("b", "in_progress")]),
          planCall("p4", [s("a", "dropped")]),
          call("p5", "plan", { steps: [] }),
        ),
        use(planCall("p6", [s("a", "done"), s("b", "pending")])),
        use(planCall("p7", [s("a", "done")])),
        use(planCall("p8", [s("a", "done"), s("b", "dropped")])),
        use(planCall("p9", [s("a", "done"), s("b", "dropped", "not needed")])),
        use(planCall("p10", [s("a", "done")])),
        use(finishCall("c1", "ok")),
      ],
    });
    expect(await rig.run()).toBe("done");

    const first = resultsIn(rig, 1);
    expect(first.p1).toContain('duplicate step id "a"');
    expect(first.p2).toContain('step "a" has an empty title');
    expect(first.p3).toContain("2 steps are in_progress");
    expect(first.p4).toContain('"a" is dropped but has no note');
    expect(first.p5).toContain("Invalid arguments");
    expect(first.p1).toContain("The plan was not saved");

    expect(resultsIn(rig, 3).p7).toContain('step "b" (Step b) was removed');
    expect(resultsIn(rig, 4).p8).toContain('"b" is dropped but has no note');
    expect(resultsIn(rig, 5).p9).toContain("Plan saved");
    // b was already dropped, so a later plan may leave it out.
    expect(resultsIn(rig, 6).p10).toContain("Plan saved");

    const saved = eventsOfType(await rig.events(), "plan_updated").map(
      (e) => e.payload.plan.length,
    );
    expect(saved).toEqual([2, 2, 1]);
  });
});

describe("runLoop: escalate", () => {
  const question = "Which database should I use?";

  it("pauses in waiting_user and does nothing when resumed without an answer", async () => {
    const rig = createRig({ script: [use(call("c1", "escalate", { question }))] });
    expect(await rig.run()).toBe("waiting_user");
    const events = await rig.events();
    expect(eventTypes(events).slice(-3)).toEqual(["tool_call", "escalated", "status_changed"]);
    expect(eventsOfType(events, "escalated")[0]?.payload).toEqual({ question, callId: "c1" });
    expect((await rig.record()).status).toBe("waiting_user");

    expect(await rig.run()).toBe("waiting_user");
    expect(await rig.events()).toEqual(events);
    expect(rig.provider.calls).toBe(1);
  });

  it("uses the user's answer as the result of the escalate call and continues", async () => {
    const rig = createRig({
      script: [use(call("c1", "escalate", { question })), say("Using Postgres.")],
    });
    expect(await rig.run()).toBe("waiting_user");
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "Postgres, please" });
    expect(await rig.run()).toBe("done");

    const events = await rig.events();
    const result = eventsOfType(events, "tool_result").find((e) => e.payload.callId === "c1");
    expect(result?.payload).toMatchObject({ content: "Postgres, please", isError: false });
    expect(eventsOfType(events, "user_message")).toHaveLength(0);
    expect(
      eventsOfType(events, "status_changed").map((e) => `${e.payload.from}>${e.payload.to}`),
    ).toEqual(["running>waiting_user", "waiting_user>running", "running>done"]);
    expect(resultsIn(rig, 1).c1).toBe("Postgres, please");
    expectCleanRequests(rig);
  });

  it("joins several answers, and a stop cancels a waiting run", async () => {
    const rig = createRig({
      script: [use(call("c1", "escalate", { question })), say("ok")],
    });
    await rig.run();
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "one" });
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "two" });
    await rig.run();
    expect(resultsIn(rig, 1).c1).toBe("one\n\ntwo");

    const stopped = createRig({ script: [use(call("c1", "escalate", { question }))] });
    await stopped.run();
    stopped.store.postInbox(stopped.runId, { kind: "stop" });
    expect(await stopped.run()).toBe("cancelled");
    expect((await stopped.record()).status).toBe("cancelled");
  });

  it("rejects an escalate that is not alone, and an empty question", async () => {
    const rig = createRig({
      script: [
        use(call("c1", "echo", { text: "x" }), call("c2", "escalate", { question })),
        use(call("c3", "escalate", { question: " " })),
        say("fine"),
      ],
    });
    expect(await rig.run()).toBe("done");
    expect(resultsIn(rig, 1).c2).toContain("escalate must be the only tool call");
    expect(resultsIn(rig, 2).c3).toContain("question is empty");
  });
});

describe("runLoop: starting", () => {
  it("returns terminal and approval states untouched", async () => {
    for (const status of ["done", "failed", "cancelled", "waiting_approval"] as const) {
      const rig = createRig({ script: [], status });
      expect(await rig.run()).toBe(status);
      expect(await rig.events()).toEqual([]);
    }
  });

  it("moves a queued run to running", async () => {
    const rig = createRig({ script: [say("hi")], status: "queued" });
    expect(await rig.run()).toBe("done");
    const changes = eventsOfType(await rig.events(), "status_changed").map(
      (e) => `${e.payload.from}>${e.payload.to}`,
    );
    expect(changes).toEqual(["queued>running", "running>done"]);
  });

  it("the first request holds the objective and then the reminder", async () => {
    const rig = createRig({
      objective: "Count the files.",
      criteria: ["a number is reported"],
      script: [say("3")],
    });
    await rig.run();
    const first = rig.provider.requests[0]?.messages;
    expect(first).toHaveLength(1);
    expect(first?.[0]?.blocks[0]).toEqual({ type: "text", text: "Count the files." });
    const reminder = textOf(first?.[0]).split("\n");
    expect(reminder.join("\n")).toContain(REMINDER_MARK);
    expect(reminder.join("\n")).toContain("1. a number is reported");
  });
});

describe("runLoop: inbox", () => {
  const withPoster = (messages: ({ kind: "user_message"; text: string } | { kind: "stop" })[]) => {
    const state: { rig?: Rig } = {};
    const post = defineTool({
      name: "post",
      description: "Simulates the user writing while the bot works.",
      input: z.object({}),
      risk: "read",
      execute: async () => {
        for (const item of messages) state.rig?.store.postInbox(state.rig.runId, item);
        return { content: "posted" };
      },
    });
    return { state, tools: [...testTools(), post] };
  };

  it("delivers a message that arrived during a tool at the next safe point", async () => {
    const { state, tools } = withPoster([{ kind: "user_message", text: "Actually, use red." }]);
    const rig = createRig({
      tools,
      bot: { allowedTools: ["post", "echo"] },
      script: [use(call("c1", "post")), say("Using red.")],
    });
    state.rig = rig;
    expect(await rig.run()).toBe("done");

    const events = await rig.events();
    const types = eventTypes(events);
    // tool_result, then user_message, then the request that carries it.
    const at = types.indexOf("user_message");
    expect(types.slice(at - 1, at + 2)).toEqual(["tool_result", "user_message", "model_request"]);
    const second = rig.provider.requests[1]?.messages;
    const user = second?.at(-1);
    expect(user?.blocks[0]).toMatchObject({ type: "tool_result", callId: "c1" });
    expect(textOf(user)).toContain("[Message from the user, received while you were working]");
    expect(textOf(user)).toContain("Actually, use red.");
    expectCleanRequests(rig);
  });

  it("delivers several messages together in the same request", async () => {
    const { state, tools } = withPoster([
      { kind: "user_message", text: "first thing" },
      { kind: "user_message", text: "second thing" },
    ]);
    const rig = createRig({
      tools,
      bot: { allowedTools: ["post"] },
      script: [use(call("c1", "post")), say("ok")],
    });
    state.rig = rig;
    await rig.run();
    const user = rig.provider.requests[1]?.messages.at(-1);
    const texts = user?.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])) ?? [];
    expect(
      texts.filter((t) => t.includes("first thing") || t.includes("second thing")),
    ).toHaveLength(2);
    expect(eventsOfType(await rig.events(), "user_message")).toHaveLength(2);
    expect(rig.provider.calls).toBe(2);
  });

  it("a message posted before the run starts joins the objective", async () => {
    const rig = createRig({ script: [say("ok")], objective: "Do X." });
    rig.store.postInbox(rig.runId, { kind: "user_message", text: "and also Y" });
    await rig.run();
    const first = rig.provider.requests[0]?.messages;
    expect(first).toHaveLength(1);
    expect(textOf(first?.[0])).toContain("Do X.");
    expect(textOf(first?.[0])).toContain("and also Y");
  });

  it("a stop cancels the run at the safe point, without another model call", async () => {
    const { state, tools } = withPoster([{ kind: "stop" }]);
    const rig = createRig({
      tools,
      bot: { allowedTools: ["post"] },
      script: [use(call("c1", "post")), say("never")],
    });
    state.rig = rig;
    expect(await rig.run()).toBe("cancelled");
    expect(rig.provider.calls).toBe(1);
    expect((await rig.record()).status).toBe("cancelled");
    expect(lastStatus(await rig.events())).toEqual({ from: "running", to: "cancelled" });
  });

  it("a user message resets the stalled counters", async () => {
    const holder: { rig?: Rig } = {};
    const rig = createRig({
      script: [
        use(planCall("c1", [s("s1", "in_progress")])),
        say("a"),
        () => {
          holder.rig?.store.postInbox(holder.rig.runId, {
            kind: "user_message",
            text: "still there?",
          });
          return say("b");
        },
        // Without the reset this third stop in a row would fail the run.
        say("c"),
        say("d"),
        use(planCall("c2", [s("s1", "done")])),
        use(finishCall("c3", "ok")),
      ],
    });
    holder.rig = rig;
    expect(await rig.run()).toBe("done");
  });
});

describe("runLoop: tools", () => {
  it("returns tool errors, invalid arguments, unknown and disallowed tools to the model", async () => {
    const rig = createRig({
      bot: { allowedTools: ["echo", "boom"] },
      script: [
        use(
          call("c1", "boom"),
          call("c2", "echo", {}),
          call("c3", "no_such_tool"),
          call("c4", "counter"),
          call("c5", "write_note", { name: "a", body: "b" }),
        ),
        say("I see."),
      ],
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    const results = eventsOfType(events, "tool_result").map((e) => [
      e.payload.callId,
      e.payload.outcome,
      e.payload.isError,
    ]);
    expect(results).toEqual([
      ["c1", "tool_error", true],
      ["c2", "invalid_args", true],
      ["c3", "unknown_tool", true],
      ["c4", "unknown_tool", true],
      ["c5", "unknown_tool", true],
    ]);
    const seen = resultsIn(rig, 1);
    expect(seen.c1).toBe("it broke: disk full");
    expect(seen.c2).toContain("Invalid arguments");
    expect(seen.c4).toContain("Unknown tool");
    expect(rig.executor.files.size).toBe(0);
    expectCleanRequests(rig);
  });

  it("offers the control tools plus only the allowed tools", async () => {
    const rig = createRig({ bot: { allowedTools: ["echo"] }, script: [say("hi")] });
    await rig.run();
    const names = rig.provider.requests[0]?.tools.map((t) => t.name);
    expect(names).toEqual(["plan", "finish", "escalate", "echo"]);
    const finish = rig.provider.requests[0]?.tools.find((t) => t.name === "finish");
    expect(finish?.description.length).toBeGreaterThan(200);
  });

  it("passes the call id to the invoker and sees external data labelled", async () => {
    const rig = createRig({ script: [use(call("call/7", "web")), say("done")] });
    const seen: (string | undefined)[] = [];
    const invoke = rig.registry.invoke.bind(rig.registry);
    const status = await runLoop(
      {
        ...rig.deps(),
        tools: {
          specs: (allowed) => rig.registry.specs(allowed),
          invoke: (name, args, ctx, opts) => {
            seen.push(opts?.callId);
            return invoke(name, args, ctx, opts);
          },
        },
      },
      rig.runId,
    );
    expect(status).toBe("done");
    expect(seen).toEqual(["call/7"]);
    expect(resultsIn(rig, 1)["call/7"]).toContain("<<<EXTERNAL_DATA");
  });

  it("turns an invoker that throws into a crashed result", async () => {
    const rig = createRig({ script: [use(call("c1", "echo", { text: "x" })), say("ok")] });
    const status = await runLoop(
      {
        ...rig.deps(),
        tools: {
          specs: (allowed) => rig.registry.specs(allowed),
          invoke: async () => {
            throw new Error("replay mismatch");
          },
        },
      },
      rig.runId,
    );
    expect(status).toBe("done");
    expect(resultsIn(rig, 1).c1).toContain("replay mismatch");
  });
});

describe("runLoop: limits", () => {
  const turns = (n: number) => Array.from({ length: n }, (_, i) => use(call(`c${i}`, "counter")));

  it("fails with origin limit when the turn limit is reached", async () => {
    const rig = createRig({ bot: { limits: { maxTurns: 2 } }, script: turns(5) });
    expect(await rig.run()).toBe("failed");
    const status = lastStatus(await rig.events());
    expect(status?.failure?.origin).toBe("limit");
    expect(status?.failure?.detail).toContain("turn limit");
    expect(rig.provider.calls).toBe(2);
  });

  it("fails with origin limit when the cost limit is reached", async () => {
    const rig = createRig({
      bot: {
        limits: { maxTurns: 50, maxCostUsd: 15 },
        model: {
          id: "m",
          contextWindow: 100_000,
          maxOutputTokens: 1000,
          // 10 input tokens per call at $1,000,000 per MTok = $10 a call.
          pricing: { inputPerMTok: 1_000_000, outputPerMTok: 0 },
        },
      },
      script: turns(5),
    });
    expect(await rig.run()).toBe("failed");
    const status = lastStatus(await rig.events());
    expect(status?.failure?.origin).toBe("limit");
    expect(status?.failure?.detail).toContain("cost limit");
    expect(rig.provider.calls).toBe(2);
    expect((await rig.record()).costUsd).toBeCloseTo(20);
  });

  it("fails with origin limit when the duration limit is reached", async () => {
    const holder: { rig?: Rig } = {};
    const slow = (id: string) => () => {
      holder.rig?.clock.advance(60_000);
      return use(call(id, "counter"));
    };
    const rig = createRig({
      bot: { limits: { maxTurns: 50, maxDurationMs: 100_000 } },
      script: [slow("c1"), slow("c2"), slow("c3")],
    });
    holder.rig = rig;
    expect(await rig.run()).toBe("failed");
    const status = lastStatus(await rig.events());
    expect(status?.failure?.origin).toBe("limit");
    expect(status?.failure?.detail).toContain("duration limit");
    expect(rig.provider.calls).toBe(2);
  });

  it("computes cost with cached input pricing", async () => {
    const rig = createRig({
      bot: {
        model: {
          id: "m",
          contextWindow: 100_000,
          maxOutputTokens: 1000,
          pricing: { inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 },
        },
      },
      script: [
        {
          blocks: [{ type: "text", text: "hi" }],
          usage: { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 500_000 },
        },
      ],
    });
    await rig.run();
    // 500k * 3 + 500k * 0.3 + 100k * 15, per million.
    expect((await rig.record()).costUsd).toBeCloseTo(1.5 + 0.15 + 1.5);
  });
});

describe("runLoop: provider errors", () => {
  it("retries retryable errors with backoff, then succeeds", async () => {
    const rig = createRig({
      script: [
        new ProviderError("rate_limit", "slow down"),
        new ProviderError("overloaded", "busy", { retryAfterMs: 5000 }),
        say("Hi."),
      ],
    });
    expect(await rig.run()).toBe("done");
    const events = await rig.events();
    expect(eventsOfType(events, "model_request")).toHaveLength(1);
    expect(
      eventsOfType(events, "model_error").map((e) => [e.payload.kind, e.payload.attempt]),
    ).toEqual([
      ["rate_limit", 1],
      ["overloaded", 2],
    ]);
    expect(rig.sleeps).toEqual([1000, 5000]);
    expect((await rig.record()).turns).toBe(1);
  });

  it("fails with origin provider when retries run out", async () => {
    const rig = createRig({
      script: [
        new ProviderError("network", "down"),
        new ProviderError("network", "down"),
        new ProviderError("network", "down"),
        say("never"),
      ],
    });
    expect(await rig.run()).toBe("failed");
    const status = lastStatus(await rig.events());
    expect(status?.failure?.origin).toBe("provider");
    expect(status?.failure?.detail).toContain("network");
    expect(rig.provider.calls).toBe(3);
    expect(rig.sleeps).toHaveLength(2);
  });

  it("does not retry a non-retryable error", async () => {
    const rig = createRig({ script: [new ProviderError("auth", "bad key"), say("never")] });
    expect(await rig.run()).toBe("failed");
    expect(lastStatus(await rig.events())?.failure?.origin).toBe("provider");
    expect(rig.sleeps).toEqual([]);
    expect(rig.provider.calls).toBe(1);
  });

  it("turns a crashing stream into a provider failure", async () => {
    const rig = createRig({ script: [] });
    expect(await rig.run()).toBe("failed");
    const status = lastStatus(await rig.events());
    expect(status?.failure?.origin).toBe("provider");
    expect(status?.failure?.detail).toContain("only 0 step(s) were scripted");
  });

  it("fails with origin model on a refusal", async () => {
    const rig = createRig({
      script: [
        { blocks: [{ type: "text", text: "I can't help with that." }], stopReason: "refusal" },
      ],
    });
    expect(await rig.run()).toBe("failed");
    const status = lastStatus(await rig.events());
    expect(status?.failure?.origin).toBe("model");
    expect(status?.failure?.detail).toContain("refused");
  });

  it("nudges after a max_tokens stop with no tool call", async () => {
    const rig = createRig({
      script: [
        { blocks: [{ type: "text", text: "Let me write the whole" }], stopReason: "max_tokens" },
        say("Short answer."),
      ],
    });
    expect(await rig.run()).toBe("done");
    const [nudge] = eventsOfType(await rig.events(), "nudge");
    expect(nudge?.payload.reason).toBe("output_truncated");
    expect(nudge?.payload.text).toContain("cut off");
    expect(textOf(rig.provider.requests[1]?.messages.at(-1))).toContain("smaller steps");
    expectCleanRequests(rig);
  });
});

describe("runLoop: interruption", () => {
  it("an abort during the model call returns running and the run can resume", async () => {
    const controller = new AbortController();
    const rig = createRig({
      script: [
        () => {
          controller.abort();
          return say("never seen");
        },
      ],
    });
    expect(await rig.run({ signal: controller.signal })).toBe("running");
    expect((await rig.record()).status).toBe("running");
    const events = await rig.events();
    expect(eventsOfType(events, "model_error")[0]?.payload.kind).toBe("aborted");
    expect(validateConversation(rebuildState(events).messages)).toEqual([]);

    // The worker decides to resume: a fresh loop with a fresh provider script.
    const resumed = createRig({ script: [say("Hello.")] });
    expect(await runLoop({ ...rig.deps(), provider: resumed.provider }, rig.runId)).toBe("done");
    expect(problemsInRequests(resumed.provider)).toEqual([]);
  });

  it("an abort between tool calls gives the rest an interrupted result and stays valid", async () => {
    const controller = new AbortController();
    const trigger = defineTool({
      name: "trigger",
      description: "Aborts the run when it finishes.",
      input: z.object({}),
      risk: "read",
      execute: async () => {
        queueMicrotask(() => controller.abort());
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { content: "late" };
      },
    });
    const rig = createRig({
      tools: [...testTools(), trigger],
      bot: { allowedTools: ["trigger", "echo", "counter"] },
      script: [
        use(call("c1", "trigger"), call("c2", "echo", { text: "x" }), call("c3", "counter")),
      ],
    });
    expect(await rig.run({ signal: controller.signal })).toBe("running");

    const events = await rig.events();
    const results = eventsOfType(events, "tool_result");
    expect(results.map((r) => [r.payload.callId, r.payload.outcome])).toEqual([
      ["c1", "aborted"],
      ["c2", "aborted"],
      ["c3", "aborted"],
    ]);
    expect(results[1]?.payload.content).toContain("was not run");
    expect(validateConversation(rebuildState(events).messages)).toEqual([]);
    expect((await rig.record()).status).toBe("running");

    const resumed = createRig({ script: [say("Back.")] });
    expect(await runLoop({ ...rig.deps(), provider: resumed.provider }, rig.runId)).toBe("done");
    expect(problemsInRequests(resumed.provider)).toEqual([]);
  });

  it("returns running at once when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const rig = createRig({ script: [say("x")] });
    expect(await rig.run({ signal: controller.signal })).toBe("running");
    expect(rig.provider.calls).toBe(0);
  });
});

describe("runLoop: repetition guard", () => {
  const same = (n: number) => Array.from({ length: n }, (_, i) => use(call(`c${i}`, "fixed")));

  it("nudges at the third identical call and fails at the fifth", async () => {
    const rig = createRig({ script: same(8) });
    expect(await rig.run()).toBe("failed");
    const events = await rig.events();
    const nudges = eventsOfType(events, "nudge");
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.payload.reason).toBe("repetition");
    expect(nudges[0]?.payload.text).toContain('"fixed"');
    const status = lastStatus(events);
    expect(status?.failure?.origin).toBe("model");
    expect(status?.failure?.detail).toContain("5 times in a row");
    expect(rig.provider.calls).toBe(5);
    // The nudge rides in the same user message as the third result.
    const fourth = rig.provider.requests[3]?.messages.at(-1);
    expect(fourth?.blocks[0]).toMatchObject({ type: "tool_result", callId: "c2" });
    expect(textOf(fourth)).toContain("[Harness notice]");
  });

  it("does not count calls whose results differ, or different arguments", async () => {
    const rig = createRig({
      script: [
        use(call("a", "counter")),
        use(call("b", "counter")),
        use(call("c", "counter")),
        use(call("d", "counter")),
        use(call("e", "counter")),
        use(call("f", "counter")),
        say("ok"),
      ],
    });
    expect(await rig.run()).toBe("done");
    expect(eventsOfType(await rig.events(), "nudge")).toHaveLength(0);
  });

  it("changing the call breaks the streak", async () => {
    const rig = createRig({
      script: [
        use(call("a", "fixed")),
        use(call("b", "fixed")),
        use(call("c", "echo", { text: "different" })),
        use(call("d", "fixed")),
        use(call("e", "fixed")),
        say("ok"),
      ],
    });
    expect(await rig.run()).toBe("done");
    expect(eventsOfType(await rig.events(), "nudge")).toHaveLength(0);
  });
});

describe("runLoop: state reminder", () => {
  it("is the last block of every request, current, and never stored", async () => {
    const rig = createRig({
      objective: "Ship the report.",
      criteria: ["report.md exists"],
      script: [
        use(planCall("c1", [s("s1", "in_progress"), s("s2", "pending")])),
        use(
          planCall("c2", [s("s1", "done"), s("s2", "done")]),
          call("c3", "write_note", { name: "report.md", body: "x" }),
        ),
        use(finishCall("c4", "Done.", [{ criterion: "1", evidence: "wrote it" }])),
      ],
    });
    expect(await rig.run()).toBe("done");
    expectCleanRequests(rig);

    const reminderOf = (i: number) =>
      textOf(rig.provider.requests[i]?.messages.at(-1)).split(REMINDER_MARK)[1] ?? "";
    expect(reminderOf(0)).toContain("Ship the report.");
    expect(reminderOf(0)).toContain("no plan yet");
    expect(reminderOf(1)).toContain("[in_progress] s1: Step s1");
    expect(reminderOf(1)).toContain("[pending] s2: Step s2");
    expect(reminderOf(1)).toContain("2 step(s) still open: s1, s2");
    expect(reminderOf(2)).toContain("[done] s2");
    expect(reminderOf(2)).toContain("All plan steps are closed");
    expect(reminderOf(2)).toContain("1. report.md exists");

    // A turn's reminder is not left behind in the next request's history.
    for (const request of rig.provider.requests) {
      const mentions = request.messages.filter((m) => textOf(m).includes(REMINDER_MARK));
      expect(mentions).toHaveLength(1);
    }

    // Only model_request events (what was really sent) contain it; no other event, and nothing
    // rebuilt from the events.
    const events = await rig.events();
    for (const event of events) {
      if (event.type === "model_request") continue;
      expect(JSON.stringify(event.payload)).not.toContain(REMINDER_MARK);
    }
    expect(JSON.stringify(rebuildState(events).messages)).not.toContain(REMINDER_MARK);
  });

  it("the recorded request is exactly what the provider received", async () => {
    const rig = createRig({ script: [use(call("c1", "echo", { text: "x" })), say("ok")] });
    await rig.run();
    const requests = eventsOfType(await rig.events(), "model_request");
    expect(requests).toHaveLength(2);
    requests.forEach((event, i) => {
      const received = rig.provider.requests[i];
      expect(event.payload.messages).toEqual(received?.messages);
      expect(event.payload.system).toBe(received?.system);
      expect(event.payload.tools).toEqual(received?.tools);
      expect(event.payload.model).toBe("model-x");
    });
  });
});
