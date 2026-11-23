import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { GateCall, ToolGate } from "../approvals/gate.js";
import { buildReviewMessage } from "../approvals/model-reviewer.js";
import { call, createRig, eventsOfType, say, testTools, use } from "../testing/index.js";
import { defineTool } from "../tool.js";
import { ROUTINE_NO_QUESTIONS } from "./control-calls.js";
import { runLoop } from "./loop.js";
import { buildSystemPrompt, ROUTINES_HOW } from "./prompts.js";
import type { RunContextSnapshot } from "./run-context.js";

const ROUTINE = {
  id: "r-1",
  name: "Ver o calendário",
  schedule: "todo dia às 08:00",
  timeZone: "America/Sao_Paulo",
  scheduledFor: "2026-11-23T11:00:00.000Z",
  kind: "catch_up" as const,
  missedCount: 2,
  state: "Já avisei do dentista.",
};

const context = (
  extra: Partial<RunContextSnapshot> = {},
  withRoutine = true,
): RunContextSnapshot => ({
  rules: [],
  profile: [],
  history: [],
  now: { iso: "2026-11-23T11:00:05.000Z", timeZone: "America/Sao_Paulo" },
  ...(withRoutine ? { routine: ROUTINE } : {}),
  ...extra,
});

/** A gate that records what it was asked and lets everything run. */
function recordingGate(seen: GateCall[]): ToolGate {
  return {
    async check(c) {
      seen.push(c);
      return null;
    },
  };
}

describe("a run opened by a routine", () => {
  it("is told what fired it, its own note, and that the fire is not approval", async () => {
    const rig = createRig({
      script: [say("Hoje você tem dentista às 15h.")],
      origin: "routine",
      objective: "Veja meu calendário de hoje.",
    });
    await runLoop(rig.deps({ loadRunContext: async () => context() }), rig.runId);
    const system = rig.provider.requests[0]?.system ?? "";
    expect(system).toContain("## This run is a routine");
    expect(system).toContain(
      'Your routine "Ver o calendário" (todo dia às 08:00, America/Sao_Paulo)',
    );
    expect(system).toContain("Monday 2026-11-23, 08:00");
    expect(system).toContain("2 earlier scheduled time(s) were missed and are NOT run");
    expect(system).toContain('"Já avisei do dentista."');
    expect(system).toContain("is not the user's approval");
    const [loaded] = eventsOfType(await rig.events(), "context_loaded");
    expect(loaded?.payload.routine).toEqual(ROUTINE);
  });

  it("refuses questions: nobody is watching live", async () => {
    const rig = createRig({
      script: [
        use(call("q1", "escalate", { question: "Qual calendário?" })),
        say("Não consegui saber qual calendário; me diga no chat."),
      ],
      origin: "routine",
    });
    expect(await runLoop(rig.deps(), rig.runId)).toBe("done");
    const results = eventsOfType(await rig.events(), "tool_result");
    expect(results[0]?.payload).toMatchObject({ isError: true, content: ROUTINE_NO_QUESTIONS });
    expect(eventsOfType(await rig.events(), "escalated")).toEqual([]);
  });

  it("the gate is told a routine started the run; its instruction is not a user message", async () => {
    const seen: GateCall[] = [];
    const rig = createRig({
      script: [use(call("c1", "echo", { text: "x" })), say("ok")],
      origin: "routine",
      objective: "Veja meu calendário de hoje.",
      bot: { allowedTools: ["echo"] },
    });
    await runLoop(rig.deps({ gate: recordingGate(seen) }), rig.runId);
    expect(seen[0]?.trigger).toEqual({
      kind: "routine",
      instruction: "Veja meu calendário de hoje.",
    });
    expect(seen[0]?.userMessages).toEqual([]);

    const user: GateCall[] = [];
    const live = createRig({
      script: [use(call("c1", "echo", { text: "x" })), say("ok")],
      objective: "Faça isso.",
      bot: { allowedTools: ["echo"] },
    });
    await runLoop(live.deps({ gate: recordingGate(user) }), live.runId);
    expect(user[0]?.trigger).toBeUndefined();
    expect(user[0]?.userMessages).toEqual(["Faça isso."]);
  });

  it("the reviewer's request says the run was started by a routine and shows the instruction apart", () => {
    const text = buildReviewMessage(
      {
        botId: "b",
        tool: "send",
        args: { to: "ana" },
        level: "external_irreversible",
        summary: "Send",
        context: {
          toolDescription: "Sends",
          userMessages: [],
          rules: [],
          trigger: { kind: "routine", instruction: "Mande o resumo para a Ana." },
        },
      },
      '{"to":"ana"}',
    );
    expect(text).toContain("## How this run started");
    expect(text).toContain("NOT the user's approval");
    expect(text).toContain(
      '<routine_instruction>"Mande o resumo para a Ana."</routine_instruction>',
    );
    const plain = buildReviewMessage(
      {
        botId: "b",
        tool: "send",
        args: {},
        level: "write_reversible",
        summary: "",
        context: { toolDescription: "", userMessages: ["oi"], rules: [] },
      },
      "{}",
    );
    expect(plain).not.toContain("How this run started");
  });
});

describe("the prompt about routines", () => {
  it("tells a bot with create_routine to choose the time itself and say it", async () => {
    const rig = createRig({
      script: [say("ok")],
      tools: [
        ...testTools(),
        defineTool({
          name: "create_routine",
          description: "Creates a routine.",
          input: z.object({ name: z.string() }),
          risk: "write_reversible",
          execute: async () => ({ content: "ok" }),
        }),
      ],
      bot: { allowedTools: ["create_routine"] },
    });
    await rig.run();
    const system = rig.provider.requests[0]?.system ?? "";
    expect(system).toContain(ROUTINES_HOW);
    expect(system).toContain("- Routines: `create_routine`");
    const without = createRig({ script: [say("ok")] });
    await without.run();
    expect(without.provider.requests[0]?.system).not.toContain("create_routine");
  });

  it("says when the user's time zone is not known, instead of using the server's", () => {
    const known = buildSystemPrompt({ name: "B", personality: "" }, context({}, false));
    expect(known).toContain("in the user's time zone");
    const unknown = buildSystemPrompt(
      { name: "B", personality: "" },
      context(
        { now: { iso: "2026-11-23T11:00:05.000Z", timeZone: "UTC", timeZoneKnown: false } },
        false,
      ),
    );
    expect(unknown).toContain("The user's time zone is NOT known yet");
    expect(unknown).not.toContain("in the user's time zone. That is when");
  });
});

describe("a message of the user that is about a routine (the app's Editar)", () => {
  const REF = { id: "rot-123", name: "Calendário da manhã", schedule: "todo dia às 08:00" };
  const texts = (rig: ReturnType<typeof createRig>, n = 0) =>
    (rig.provider.requests[n]?.messages ?? [])
      .flatMap((m) => m.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])))
      .join("\n");

  it("the opening message: the model reads which routine (with its id) in a note, recorded once", async () => {
    const rig = createRig({
      script: [say("Pronto.")],
      objective: "Editar a rotina “Calendário da manhã” (todo dia às 08:00): muda pra 7h",
    });
    await runLoop(
      rig.deps({ loadRunContext: async () => context({ routineRefs: [REF] }, false) }),
      rig.runId,
    );
    const said = texts(rig);
    expect(said).toContain("muda pra 7h");
    expect(said).toContain('your routine "Calendário da manhã" (todo dia às 08:00), id rot-123');
    expect(said).toContain('pass routine: "rot-123"');
    const [loaded] = eventsOfType(await rig.events(), "context_loaded");
    expect(loaded?.payload.routineRefs).toEqual([REF]);
    // the run's objective (what the user typed) stays without the id
    expect(eventsOfType(await rig.events(), "run_started")[0]?.payload.objective).not.toContain(
      "rot-123",
    );
  });

  it("a message posted while the bot works carries its own note, recorded with it", async () => {
    const rig = createRig({ script: [say("Pronto.")], objective: "Oi" });
    rig.store.postInbox(rig.runId, {
      kind: "user_message",
      text: "Editar a rotina “Calendário da manhã”: muda pra 7h",
      routineRef: REF,
    });
    await runLoop(rig.deps(), rig.runId);
    const [message] = eventsOfType(await rig.events(), "user_message");
    expect(message?.payload).toMatchObject({
      text: "Editar a rotina “Calendário da manhã”: muda pra 7h",
      routineRef: REF,
    });
    expect(texts(rig)).toContain("id rot-123");
    // without a reference there is no note
    const plain = createRig({ script: [say("ok")], objective: "Oi" });
    plain.store.postInbox(plain.runId, { kind: "user_message", text: "muda pra 7h" });
    await runLoop(plain.deps(), plain.runId);
    expect(texts(plain)).not.toContain("your routine");
  });
});
