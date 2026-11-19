import type { ComparableEvent, PlanStep, ReplayReport, RunEventData } from "@suup/core";
import { describe, expect, it } from "vitest";
import { explainReplay } from "../src/commands/replay.js";
import {
  type Attempt,
  describeOutcome,
  outcomeKey,
  summarizeAttempts,
} from "../src/commands/resend.js";
import { describeRun } from "../src/commands/runs.js";
import {
  formatDuration,
  formatUsd,
  ORIGIN_EXPLANATION,
  originExplanation,
  statusPt,
} from "../src/format.js";
import {
  newRenderState,
  type RawEvent,
  renderEvent,
  renderFooter,
  renderPlan,
  summarizeArgs,
  summarizeEvent,
} from "../src/render.js";

let seq = 0;
const ev = (data: RunEventData): RawEvent => ({
  seq: ++seq,
  type: data.type,
  payload: data.payload as unknown as Record<string, unknown>,
  createdAt: new Date(2026, 10, 18, 14, 3, 22, 123),
});
const render = (data: RunEventData, state = newRenderState()) =>
  renderEvent(ev(data), state).join("\n");

describe("renderers: the live view", () => {
  it("shows the objective and the criteria", () => {
    const text = render({
      type: "run_started",
      payload: {
        botId: "b",
        objective: "Criar o arquivo",
        acceptanceCriteria: ["existe", "tem texto"],
        origin: "user",
      },
    });
    expect(text).toContain("Objetivo: Criar o arquivo");
    expect(text).toContain("1. existe");
    expect(text).toContain("2. tem texto");
  });

  it("numbers the agent turns and names the reviewer's call", () => {
    const state = newRenderState();
    const req = (purpose?: "review") => ({
      type: "model_request" as const,
      payload: {
        provider: "p",
        model: "model-x",
        system: "",
        messages: [],
        tools: [],
        maxOutputTokens: 10,
        ...(purpose ? { purpose } : {}),
      },
    });
    expect(render(req(), state)).toContain("turno 1: consultando model-x");
    expect(render(req(), state)).toContain("turno 2");
    expect(render(req("review"), state)).toContain("revisor (model-x)");
  });

  it("prints the model's text, and warns about a cut or refused answer", () => {
    const response = (stopReason: "end" | "max_tokens" | "refusal") => ({
      type: "model_response" as const,
      payload: {
        blocks: [{ type: "text" as const, text: "Olá!\nSegunda linha" }],
        stopReason,
        usage: { inputTokens: 1, outputTokens: 1 },
        modelVersion: "v1",
        durationMs: 5,
      },
    });
    expect(render(response("end"))).toContain("| Olá!");
    expect(render(response("end"))).toContain("| Segunda linha");
    expect(render(response("max_tokens"))).toContain("cortada pelo limite de tokens");
    expect(render(response("refusal"))).toContain("recusa");
  });

  it("shows a provider error with its kind, attempt and whether it will retry", () => {
    const text = render({
      type: "model_error",
      payload: { kind: "rate_limit", message: "slow down", retryable: true, attempt: 2 },
    });
    expect(text).toContain("erro do provedor (rate_limit)");
    expect(text).toContain("tentativa 2");
    expect(text).toContain("vai tentar de novo");
  });

  it("shows a tool call with a one-line summary of its arguments, then the outcome and first lines", () => {
    const state = newRenderState();
    const call = render(
      {
        type: "tool_call",
        payload: {
          callId: "c1",
          name: "shell",
          args: { command: "cat out.txt\nsecond line", timeout_seconds: 5 },
        },
      },
      state,
    );
    expect(call).toContain("→ shell");
    expect(call).toContain('command="cat out.txt second line"');
    expect(call.split("\n")).toHaveLength(1);

    const result = render(
      {
        type: "tool_result",
        payload: {
          callId: "c1",
          outcome: "ok",
          content: "l1\nl2\nl3\nl4\nl5\nl6\nl7",
          isError: false,
          truncated: false,
          durationMs: 12,
        },
      },
      state,
    );
    expect(result).toContain("← ok (12 ms)");
    expect(result).toContain("l1");
    expect(result).toContain("l5");
    expect(result).not.toContain("l6");
    expect(result).toContain("(+2 linhas)");
  });

  it("labels failed tool results in Portuguese", () => {
    const state = newRenderState();
    render(
      { type: "tool_call", payload: { callId: "c1", name: "read_file", args: { path: "x" } } },
      state,
    );
    const text = render(
      {
        type: "tool_result",
        payload: {
          callId: "c1",
          outcome: "tool_error",
          content: "no such file",
          isError: true,
          truncated: true,
          durationMs: 1,
        },
      },
      state,
    );
    expect(text).toContain("erro da ferramenta");
    expect(text).toContain("no such file");
    expect(text).toContain("saída truncada");
  });

  it("does not repeat the plan or the finish in their tool results, but shows the answer to an escalation", () => {
    const state = newRenderState();
    render(
      { type: "tool_call", payload: { callId: "p", name: "plan", args: { steps: [] } } },
      state,
    );
    render(
      { type: "tool_call", payload: { callId: "f", name: "finish", args: { summary: "s" } } },
      state,
    );
    render(
      {
        type: "tool_call",
        payload: { callId: "e", name: "escalate", args: { question: "Qual?" } },
      },
      state,
    );
    const result = (callId: string, content: string, isError = false) =>
      render(
        {
          type: "tool_result",
          payload: {
            callId,
            outcome: isError ? "tool_error" : "ok",
            content,
            isError,
            truncated: false,
            durationMs: 0,
          },
        },
        state,
      );
    expect(result("p", "Plan saved")).toBe("");
    expect(result("f", "Finish was not accepted")).toBe("");
    expect(result("e", "quarenta e dois")).toContain("resposta recebida");
    expect(result("e", "quarenta e dois")).toContain("quarenta e dois");
  });

  it("renders the plan as a checklist", () => {
    const plan: PlanStep[] = [
      { id: "a", title: "Feito", status: "done" },
      { id: "b", title: "Agora", status: "in_progress" },
      { id: "c", title: "Depois", status: "pending" },
      { id: "d", title: "Cortado", status: "dropped", note: "não precisa" },
    ];
    expect(renderPlan(plan)).toEqual([
      "  [x] Feito",
      "  [~] Agora",
      "  [ ] Depois",
      "  [-] Cortado (descartado: não precisa)",
    ]);
    expect(render({ type: "plan_updated", payload: { plan } })).toContain("Plano:\n  [x] Feito");
  });

  it("shows nudges, delivered user messages and the escalation", () => {
    expect(
      render({
        type: "nudge",
        payload: { reason: "stopped_without_finish", text: "faltam passos" },
      }),
    ).toContain("parou sem concluir");
    expect(
      render({ type: "user_message", payload: { text: "mude o plano", inboxId: "1" } }),
    ).toContain("sua mensagem chegou ao bot: mude o plano");
    const q = render({
      type: "escalated",
      payload: { question: "Qual cor?\nAzul ou verde?", callId: "e" },
    });
    expect(q).toContain("O bot precisa de você");
    expect(q).toContain("Azul ou verde?");
    expect(
      render({ type: "escalated", payload: { question: "decida", reason: "review_tie_break" } }),
    ).toContain("não chegaram a um acordo");
  });

  it("shows finish attempts with the rejection reasons, and the reviewer's verdict", () => {
    const rejected = render({
      type: "finish_attempt",
      payload: {
        summary: "s",
        evidence: [],
        accepted: false,
        rejectionReasons: ["falta evidência para 1", "passo s2 pendente"],
      },
    });
    expect(rejected).toContain("Conclusão recusada");
    expect(rejected).toContain("- falta evidência para 1");
    expect(rejected).toContain("- passo s2 pendente");
    expect(
      render({
        type: "finish_attempt",
        payload: { summary: "s", evidence: [], accepted: true, rejectionReasons: [] },
      }),
    ).toContain("Conclusão aceita");
    expect(
      render({ type: "review", payload: { verdict: "reject", notes: "o arquivo não foi lido" } }),
    ).toContain("Revisor reprovou: o arquivo não foi lido");
    expect(
      render({
        type: "review",
        payload: { verdict: "approve", notes: "", warning: "revisor fora do ar" },
      }),
    ).toContain("aviso: revisor fora do ar");
  });

  it("shows when the reviewer could not verify, and each round of evidence it asked for", () => {
    expect(
      render({
        type: "review",
        payload: { verdict: "unverified", notes: "o CNPJ não foi checado" },
      }),
    ).toContain("Revisor não conseguiu verificar: o CNPJ não foi checado");
    const round = render({
      type: "review_evidence",
      payload: {
        round: 1,
        callId: "v1",
        notes: "preciso do contrato",
        requested: { results: ["#1"], files: ["a.md", "b.md"] },
        supplied: [
          { kind: "tool_result", ref: "c1", index: 1, chars: 100, sent: 50 },
          { kind: "file", ref: "a.md", chars: 3, sent: 3, hash: "h", content: "abc" },
        ],
        missing: [{ item: "b.md", reason: "no such file in the workspace" }],
        budgetChars: 60000,
      },
    });
    expect(round).toContain("rodada 1");
    expect(round).toContain("2 item(ns) enviado(s)");
    expect(round).toContain("1 cortado(s)");
    expect(round).toContain("1 indisponível(is)");
  });

  it("shows how the run ended: the result with its evidence, or the failure with its origin and what it means", () => {
    const done = render({
      type: "status_changed",
      payload: {
        from: "running",
        to: "done",
        result: {
          summary: "Criei o arquivo",
          evidence: [{ criterion: "1", evidence: "cat mostrou o texto" }],
        },
      },
    });
    expect(done).toContain("Concluída.");
    expect(done).toContain("Criei o arquivo");
    expect(done).toContain("cat mostrou o texto");
    const failed = render({
      type: "status_changed",
      payload: {
        from: "running",
        to: "failed",
        failure: { origin: "limit", detail: "turn limit reached" },
      },
    });
    expect(failed).toContain("Falhou [origem: limit]: turn limit reached");
    expect(failed).toContain("limite configurado");
    expect(
      render({ type: "status_changed", payload: { from: "running", to: "cancelled" } }),
    ).toContain("Cancelada");
    expect(
      render({ type: "status_changed", payload: { from: "running", to: "waiting_user" } }),
    ).toContain("aguardando sua resposta");
  });

  it("does not choke on an event the schema does not know", () => {
    const text = renderEvent(
      { seq: 9, type: "from_the_future", payload: { a: 1 }, createdAt: new Date() },
      newRenderState(),
    ).join("\n");
    expect(text).toContain("from_the_future");
    expect(
      summarizeEvent({ seq: 9, type: "from_the_future", payload: { a: 1 }, createdAt: new Date() }),
    ).toContain('"a":1');
  });

  it("closes with status, turns, tokens and cost", () => {
    const text = renderFooter({
      id: "abc",
      status: "done",
      turns: 5,
      inputTokens: 9200,
      outputTokens: 430,
      costUsd: "0.034100",
      durationMs: 4200,
    }).join("\n");
    expect(text).toContain("concluída em 4,2 s");
    expect(text).toContain("Turnos: 5");
    expect(text).toContain("9.200 de entrada");
    expect(text).toContain("US$ 0,0341");
  });
});

describe("renderers: summaries", () => {
  it("summarizes arguments by the one that matters", () => {
    expect(summarizeArgs("plan", { steps: [1, 2, 3] })).toBe("(3 passos)");
    expect(summarizeArgs("shell", { cwd: "x", command: "ls -la" })).toBe(
      'command="ls -la" cwd="x"',
    );
    expect(summarizeArgs("finish", { summary: "pronto", evidence: [{ a: 1 }] })).toBe('"pronto"');
    expect(summarizeArgs("web_fetch", { url: "https://example.com" })).toBe(
      'url="https://example.com"',
    );
    expect(summarizeArgs("x", {})).toBe("");
    expect(summarizeArgs("x", { n: 1, list: [1, 2] })).toBe("n=1 list=[1,2]");
    expect(summarizeArgs("shell", { command: "x".repeat(500) }).length).toBeLessThanOrEqual(100);
  });

  it("gives a compact line for each kind of event", () => {
    const line = (data: RunEventData) => summarizeEvent(ev(data));
    expect(
      line({
        type: "tool_call",
        payload: { callId: "c9", name: "shell", args: { command: "ls" } },
      }),
    ).toBe('c9 shell command="ls"');
    expect(
      line({
        type: "status_changed",
        payload: { from: "running", to: "failed", failure: { origin: "tool", detail: "boom" } },
      }),
    ).toContain("running → failed [tool] boom");
    expect(
      line({
        type: "plan_updated",
        payload: {
          plan: [
            { id: "a", title: "t", status: "done" },
            { id: "b", title: "u", status: "pending" },
          ],
        },
      }),
    ).toBe("1/2 passos feitos");
    expect(
      line({
        type: "model_response",
        payload: {
          blocks: [{ type: "tool_call", id: "1", name: "plan", args: {} }],
          stopReason: "tool_calls",
          usage: { inputTokens: 1500, outputTokens: 20 },
          modelVersion: "mv-1",
          durationMs: 800,
        },
      }),
    ).toMatch(/tool_calls · mv-1 · 1\.500→20 tok · 800 ms · chamadas: plan/);
  });
});

describe("formatting", () => {
  it("formats durations, money and statuses for a Brazilian reader", () => {
    expect(formatDuration(340)).toBe("340 ms");
    expect(formatDuration(2300)).toBe("2,3 s");
    expect(formatDuration(63_000)).toBe("1 min 03 s");
    expect(formatUsd(0.5)).toBe("US$ 0,5000");
    expect(statusPt("waiting_user")).toBe("aguardando você");
    expect(statusPt("done")).toBe("concluída");
  });

  it("explains every failure origin in one line", () => {
    for (const origin of ["provider", "model", "tool", "harness", "limit", "approval", "user"]) {
      expect(originExplanation(origin).length).toBeGreaterThan(20);
      expect(originExplanation(origin).split("\n")).toHaveLength(1);
    }
    expect(Object.keys(ORIGIN_EXPLANATION)).toHaveLength(7);
  });
});

describe("suup show: the failure origin is prominent", () => {
  const baseRun = {
    id: "3f2a9c1d-0000-4000-8000-000000000000",
    botId: "b",
    parentRunId: null,
    origin: "user" as const,
    objective: "Fazer algo",
    acceptanceCriteria: [],
    plan: [],
    status: "failed" as const,
    failureOrigin: "provider" as const,
    failureDetail: "auth: chave inválida",
    result: null,
    turns: 2,
    inputTokens: 10,
    outputTokens: 5,
    costUsd: "0.001000",
    traceId: null,
    lockedBy: null,
    lockedAt: null,
    createdAt: new Date(2026, 10, 18, 14, 0, 0),
    updatedAt: new Date(),
    startedAt: new Date(2026, 10, 18, 14, 0, 1),
    finishedAt: new Date(2026, 10, 18, 14, 0, 3),
  };
  const extra = {
    events: 9,
    versions: [],
    modelErrors: [
      { seq: 4, kind: "auth", message: "chave inválida", attempt: 1, retryable: false },
    ],
    question: null,
  };

  it("puts the origin, its meaning and the detail up front", () => {
    const text = describeRun(baseRun, null, extra).join("\n");
    expect(text).toContain(">>> FALHOU — ORIGEM: PROVIDER");
    expect(text).toContain(ORIGIN_EXPLANATION.provider);
    expect(text).toContain("Detalhe: auth: chave inválida");
    expect(text).toContain("Erros do provedor (1)");
    // the origin comes before the objective
    expect(text.indexOf("ORIGEM")).toBeLessThan(text.indexOf("Objetivo:"));
  });

  it("works for every origin", () => {
    for (const origin of [
      "provider",
      "model",
      "tool",
      "harness",
      "limit",
      "approval",
      "user",
    ] as const) {
      const text = describeRun({ ...baseRun, failureOrigin: origin }, null, extra).join("\n");
      expect(text).toContain(`ORIGEM: ${origin.toUpperCase()}`);
      expect(text).toContain(ORIGIN_EXPLANATION[origin]);
    }
  });
});

describe("suup replay: the reading of a report", () => {
  const same: ComparableEvent = { type: "tool_call", payload: {} };
  const report = (over: Partial<ReplayReport>): ReplayReport => ({
    identical: true,
    requestDiffs: [],
    finalStatus: { recorded: "done", replayed: "done" },
    replayedEvents: [],
    ...over,
  });
  const seqOf = (i: number) => i + 1;

  it("identical: the current loop reproduces the run", () => {
    const text = explainReplay(report({}), seqOf);
    expect(text).toContain("O loop atual reproduz a execução");
  });

  it("identical decisions but different requests: only what is sent to the model changed", () => {
    const text = explainReplay(
      report({
        requestDiffs: [
          {
            index: 3,
            purpose: "agent",
            changes: [{ field: "system", recorded: "a", replayed: "b" }],
          },
        ],
      }),
      seqOf,
    );
    expect(text).toContain("Só o que é enviado ao modelo mudou");
    expect(text).toContain("um pedido");
  });

  it("divergence: the harness behaviour changed at event N", () => {
    const text = explainReplay(
      report({
        identical: false,
        firstDivergence: { index: 16, recorded: same, replayed: undefined },
      }),
      seqOf,
    );
    expect(text).toContain("O comportamento do harness mudou no evento 17");
    expect(text).toContain("regressão");
  });

  it("a replay that stopped because the recording lacked something says so", () => {
    const text = explainReplay(
      report({
        identical: false,
        stoppedBecause: "no recorded response",
        firstDivergence: { index: 2, recorded: undefined, replayed: same },
      }),
      seqOf,
    );
    expect(text).toContain("a gravação não tinha o que ela pediu");
  });
});

describe("suup resend: counting outcomes", () => {
  const ok = (
    n: number,
    calls: { name: string; args: unknown }[],
    stopReason: "tool_calls" | "end" = "tool_calls",
  ): Attempt => ({
    attempt: n,
    ok: true,
    latencyMs: 10,
    stopReason,
    toolCalls: calls,
    text: "",
    usage: { inputTokens: 1, outputTokens: 1 },
    modelVersion: "v",
  });
  const fail = (n: number): Attempt => ({
    attempt: n,
    ok: false,
    latencyMs: 1,
    error: { kind: "rate_limit", message: "x", retryable: true },
  });
  const shell = { name: "shell", args: { command: "ls" } };
  const readFile = { name: "read_file", args: { path: "a" } };

  it("reduces an attempt to the decision: why it stopped and which tools it called", () => {
    expect(outcomeKey(ok(1, [shell]))).toBe("tool_calls|shell");
    expect(outcomeKey(ok(1, [shell, readFile]))).toBe("tool_calls|shell+read_file");
    expect(outcomeKey(ok(1, [], "end"))).toBe("end|só texto");
    expect(outcomeKey(fail(1))).toBe("erro:rate_limit");
    expect(describeOutcome("tool_calls|shell+read_file")).toBe(
      "chamou shell + read_file (parada: tool_calls)",
    );
    expect(describeOutcome("end|só texto")).toContain("só com texto");
  });

  it("same model, always the recorded outcome: wrong every time means what was sent is the problem", () => {
    const attempts = [1, 2, 3].map((n) => ok(n, [shell]));
    const s = summarizeAttempts(attempts, ok(0, [shell]), { sameModel: true, model: "model-x" });
    expect(s.distinct).toHaveLength(1);
    expect(s.distinct[0]).toMatchObject({ count: 3 });
    expect(s.recordedRepeated).toBe(3);
    expect(s.reading).toContain("3 de 3");
    expect(s.reading).toContain("o problema está no que foi enviado");
  });

  it("same model, sometimes the recorded outcome: variation of the model", () => {
    const attempts = [ok(1, [shell]), ok(2, [readFile]), ok(3, [shell]), ok(4, [readFile])];
    const s = summarizeAttempts(attempts, ok(0, [shell]), { sameModel: true, model: "model-x" });
    expect(s.distinct).toHaveLength(2);
    expect(s.recordedRepeated).toBe(2);
    expect(s.reading).toContain("2 de 4");
    expect(s.reading).toContain("variação do modelo");
  });

  it("same model, never the recorded outcome: the recorded one was the exception", () => {
    const s = summarizeAttempts([ok(1, [readFile]), ok(2, [readFile])], ok(0, [shell]), {
      sameModel: true,
      model: "model-x",
    });
    expect(s.recordedRepeated).toBe(0);
    expect(s.reading).toContain("exceção");
  });

  it("another model: compares with the recorded outcome of the original", () => {
    const s = summarizeAttempts([ok(1, [readFile])], ok(0, [shell]), {
      sameModel: false,
      model: "model-y",
    });
    expect(s.reading).toContain("Com model-y");
    expect(s.reading).toContain("só o modelo original erra");
  });

  it("notes when the tools match but the arguments differ, and counts failures as outcomes", () => {
    const s = summarizeAttempts(
      [
        ok(1, [{ name: "shell", args: { command: "a" } }]),
        ok(2, [{ name: "shell", args: { command: "b" } }]),
        fail(3),
      ],
      null,
      { sameModel: true, model: "m" },
    );
    expect(s.distinct).toHaveLength(2);
    expect(s.sameArguments).toBe(false);
    expect(s.recorded).toBeNull();
    expect(s.reading).toContain("varia");
  });
});
