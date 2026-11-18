import { describe, expect, it } from "vitest";
import { makeEvent, makeRun } from "../test-fixtures.js";
import {
  acceptedFinish,
  deriveRunDisplay,
  failureLine,
  formatCost,
  formatDuration,
  planOf,
  timelineNotices,
} from "./derive.js";

const call = (seq: number, callId: string, name: string, args: Record<string, unknown> = {}) =>
  makeEvent(seq, "tool_call", { callId, name, args });
const result = (seq: number, callId: string, content = "ok", isError = false) =>
  makeEvent(seq, "tool_result", { callId, content, isError, truncated: false, durationMs: 1200 });

describe("deriveRunDisplay (FRONTEND.md sections 4 and 11)", () => {
  type Row = [
    string,
    Partial<Parameters<typeof makeRun>[0]>,
    ReturnType<typeof makeEvent>[],
    { chip: string | null; reaction: string; active: boolean },
  ];
  const rows: Row[] = [
    ["no run", {}, [], { chip: null, reaction: "idle", active: false }],
    ["done", { status: "done" }, [], { chip: "done", reaction: "done", active: false }],
    ["failed", { status: "failed" }, [], { chip: "failed", reaction: "failed", active: false }],
    [
      "cancelled",
      { status: "cancelled" },
      [],
      { chip: "cancelled", reaction: "idle", active: false },
    ],
    [
      "waiting for the user",
      { status: "waiting_user" },
      [],
      { chip: "doubt", reaction: "doubt", active: true },
    ],
    [
      "waiting approval",
      { status: "waiting_approval" },
      [],
      { chip: "permission", reaction: "permission", active: true },
    ],
    [
      "first time in the queue",
      { status: "queued", startedAt: null },
      [],
      { chip: "queued", reaction: "thinking", active: true },
    ],
    [
      "queued after it had started (answer to a question)",
      { status: "queued" },
      [],
      { chip: "resuming", reaction: "thinking", active: true },
    ],
    [
      "queued and paused",
      { status: "queued", paused: true },
      [],
      { chip: "paused", reaction: "paused", active: true },
    ],
    [
      "running and paused (on its way to stop)",
      { status: "running", paused: true },
      [],
      { chip: "paused", reaction: "paused", active: true },
    ],
    [
      "running, waiting for the model",
      { status: "running" },
      [],
      { chip: "thinking", reaction: "thinking", active: true },
    ],
    [
      "running, a tool in flight",
      { status: "running" },
      [call(1, "c1", "shell")],
      { chip: "working", reaction: "working", active: true },
    ],
    [
      "running, the tool returned",
      { status: "running" },
      [call(1, "c1", "shell"), result(2, "c1")],
      { chip: "thinking", reaction: "thinking", active: true },
    ],
    [
      "running, finish refused",
      { status: "running" },
      [makeEvent(1, "finish_attempt", { accepted: false })],
      { chip: "thinking", reaction: "scolded", active: true },
    ],
    [
      "running, reviewer rejected",
      { status: "running" },
      [makeEvent(1, "review", { verdict: "reject" })],
      { chip: "thinking", reaction: "scolded", active: true },
    ],
    [
      "running, control tools are not 'working'",
      { status: "running" },
      [call(1, "c1", "plan")],
      { chip: "thinking", reaction: "thinking", active: true },
    ],
  ];

  it.each(rows)("%s", (_name, run, events, expected) => {
    const display = deriveRunDisplay(_name === "no run" ? null : makeRun(run), events);
    expect(display).toMatchObject(expected);
    if (expected.chip === null) expect(display.label).toBe("");
  });

  it("the avatar's state follows the run: tools working, a question asking, an approval waiting", () => {
    const state = (
      run: Parameters<typeof makeRun>[0],
      events: ReturnType<typeof makeEvent>[] = [],
    ) => deriveRunDisplay(makeRun(run), events).avatar;
    expect(deriveRunDisplay(null).avatar).toBe("idle");
    expect(state({ status: "running" })).toBe("thinking");
    expect(state({ status: "running" }, [call(1, "c1", "shell")])).toBe("working");
    expect(state({ status: "running" }, [call(1, "c1", "shell"), result(2, "c1")])).toBe(
      "thinking",
    );
    expect(state({ status: "running", paused: true })).toBe("paused");
    expect(state({ status: "waiting_user" })).toBe("asking");
    expect(state({ status: "waiting_approval" })).toBe("waiting");
    expect(state({ status: "done" })).toBe("done");
    expect(state({ status: "failed" })).toBe("failed");
    expect(state({ status: "cancelled" })).toBe("idle");
  });

  it("labels are the ones of the design, in Portuguese", () => {
    const labels = (
      ["done", "failed", "cancelled", "waiting_user", "waiting_approval"] as const
    ).map((status) => deriveRunDisplay(makeRun({ status })).label);
    expect(labels).toEqual(["Concluiu", "Falhou", "Cancelada", "Com dúvida", "Pedindo permissão"]);
    expect(deriveRunDisplay(makeRun({ status: "queued" })).label).toBe("Retomando");
    expect(deriveRunDisplay(makeRun({ status: "queued", startedAt: null })).label).toBe("Na fila");
    expect(deriveRunDisplay(makeRun({ status: "running", paused: true })).label).toBe("Pausado");
  });

  it("a run is never required to be seen in `queued`: running right after waiting_user is just running", () => {
    expect(
      deriveRunDisplay(makeRun({ status: "running" }), [
        makeEvent(1, "escalated", { question: "?" }),
      ]).chip,
    ).toBe("thinking");
  });

  it("the reviewer's own model calls do not count as the bot thinking or working", () => {
    const events = [
      makeEvent(1, "model_request", { purpose: "review" }),
      call(2, "c1", "shell"),
      result(3, "c1"),
    ];
    expect(deriveRunDisplay(makeRun({ status: "running" }), events).chip).toBe("thinking");
  });
});

describe("timeline helpers", () => {
  it("the plan comes from the run, else from the last plan_updated event", () => {
    const plan = [{ id: "s1", title: "Um", status: "done" as const }];
    expect(planOf({ plan }, [])).toEqual(plan);
    expect(planOf({ plan: [] }, [makeEvent(1, "plan_updated", { plan })])).toEqual(plan);
    expect(planOf(null, [])).toEqual([]);
  });

  it("notices: context, rejected finish, retries; accepted finish is detected", () => {
    const t = timelineNotices([
      makeEvent(1, "context_loaded", {
        rules: [{}, {}, {}],
        profile: [{}],
        history: [{}, {}, {}, {}, {}, {}],
      }),
      makeEvent(2, "finish_attempt", { accepted: false, rejectionReasons: ["a", "b"] }),
      makeEvent(3, "model_error", { retryable: true, message: "x", purpose: "agent" }),
      makeEvent(4, "user_message", { text: "oi" }),
    ]);
    expect(t.context).toBe("3 regras, 1 fato do perfil, 6 mensagens anteriores");
    expect(t.notices.map((n) => n.text)).toEqual([
      "Conclusão recusada (2 motivos).",
      "Tentando de novo…",
    ]);
    expect(t.readUserMessages).toEqual(["oi"]);
    expect(acceptedFinish([makeEvent(1, "finish_attempt", { accepted: true })])).toBe(true);
  });
});

describe("formatting", () => {
  it("money stays text until the display rounds it", () => {
    expect(formatCost("0.034100")).toBe("US$ 0,03");
    expect(formatCost("12.500000")).toBe("US$ 12,50");
    expect(formatCost("0.000000")).toBe("US$ 0,00");
    expect(formatCost("0.003400")).toBe("US$ 0,0034");
  });
  it("durations", () => {
    expect(formatDuration(450)).toBe("450 ms");
    expect(formatDuration(3100)).toBe("3,1 s");
    expect(formatDuration(125000)).toBe("2 min 5 s");
  });
});

describe("failure lines", () => {
  it("a failure is one plain-language line by origin", () => {
    expect(failureLine("limit")).toBe(
      "Não consegui terminar: um limite foi atingido (turnos, custo ou tempo)",
    );
    expect(failureLine("provider")).toContain("provedor");
    expect(failureLine(null)).toContain("Suup");
  });
});
