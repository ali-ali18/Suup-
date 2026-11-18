import { join } from "node:path";
import { appendRunEvent, createBot } from "@suup/db";
import { describe, expect, it } from "vitest";
import {
  createRuntime,
  describeOutcome,
  inspectModelRequest,
  MAX_RESEND_TIMES,
  outcomeKey,
  parseConfig,
  replayRecordedRun,
  resendRecordedRequest,
  runDoctorChecks,
  summarizeAttempts,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

// The diagnostics shared by the CLI and the server, on a run recorded by hand.

describe.skipIf(!DATABASE_URL)(dbSuiteName("diagnostics shared by the CLI and the server"), () => {
  const ctx = useIsolatedDb();

  const open = async () => {
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), { agent: [{ text: "Resposta gravada." }] });
    return createRuntime(parseConfig(rawConfig()), {
      env: { DATABASE_URL: ctx.url },
      baseDir: dir,
    });
  };

  const recordRun = async (runtime: Awaited<ReturnType<typeof open>>) => {
    const bot = await createBot(runtime.db, {
      name: "Diag",
      modelProvider: "script",
      modelId: "model-s",
    });
    const run = await runtime.createRun({ botId: bot.id, objective: "Dizer algo." });
    const request = {
      provider: "script",
      model: "model-s",
      system: "Sistema.",
      messages: [{ role: "user", blocks: [{ type: "text", text: "Dizer algo." }] }],
      tools: [{ name: "plan", description: "d", inputSchema: { type: "object" } }],
      maxOutputTokens: 100,
    };
    await appendRunEvent(runtime.db, run.id, "run_started", {
      botId: bot.id,
      objective: "Dizer algo.",
      acceptanceCriteria: [],
      origin: "user",
    });
    await appendRunEvent(runtime.db, run.id, "model_request", request);
    await appendRunEvent(runtime.db, run.id, "model_response", {
      blocks: [{ type: "text", text: "Resposta gravada." }],
      stopReason: "end",
      usage: { inputTokens: 10, outputTokens: 5 },
      modelVersion: "scripted-1",
      durationMs: 3,
    });
    return run;
  };

  it("inspectModelRequest returns the request and its answer, and explains a wrong seq", async () => {
    const runtime = await open();
    const run = await recordRun(runtime);
    const view = await inspectModelRequest(runtime.db, run.id, 2);
    expect(view).toMatchObject({
      runId: run.id,
      seq: 2,
      purpose: "agent",
      turn: 1,
      request: { system: "Sistema.", model: "model-s" },
      response: { seq: 3, stopReason: "end", modelVersion: "scripted-1" },
    });
    await expect(inspectModelRequest(runtime.db, run.id, 1)).rejects.toMatchObject({
      code: "not_a_model_request",
      message: expect.stringContaining("Pedidos ao modelo desta execução: seq 2"),
    });
    await expect(inspectModelRequest(runtime.db, run.id, 99)).rejects.toMatchObject({
      code: "event_not_found",
    });
    await expect(
      inspectModelRequest(runtime.db, "00000000-0000-4000-8000-000000000000", 1),
    ).rejects.toMatchObject({ code: "run_not_found" });
    await runtime.close();
  });

  it("resendRecordedRequest sends it again and summarizes, validating how many times", async () => {
    const runtime = await open();
    const run = await recordRun(runtime);
    const seen: number[] = [];
    const result = await resendRecordedRequest(runtime, {
      runId: run.id,
      seq: 2,
      times: 2,
      onAttempt: (a) => seen.push(a.attempt),
    });
    expect(seen).toEqual([1, 2]);
    expect(result).toMatchObject({
      requestSeq: 2,
      purpose: "agent",
      recordedModel: "model-s",
      sentTo: { provider: "script", model: "model-s" },
      summary: { attempts: 2, recordedRepeated: 2 },
    });
    expect(result.attempts.every((a) => a.ok && a.text === "Resposta gravada.")).toBe(true);
    for (const times of [0, 1.5, MAX_RESEND_TIMES + 81]) {
      await expect(
        resendRecordedRequest(runtime, { runId: run.id, seq: 2, times }),
      ).rejects.toMatchObject({
        code: "invalid_input",
      });
    }
    await expect(
      resendRecordedRequest(runtime, { runId: run.id, seq: 2, model: "nope" }),
    ).rejects.toMatchObject({ code: "unknown_model" });
    // A stop requested in advance sends nothing.
    const stopped = new AbortController();
    stopped.abort();
    expect(
      (
        await resendRecordedRequest(runtime, {
          runId: run.id,
          seq: 2,
          times: 3,
          signal: stopped.signal,
        })
      ).attempts,
    ).toEqual([]);
    await runtime.close();
  });

  it("replayRecordedRun needs events, and says what it did not find", async () => {
    const runtime = await open();
    const bot = await createBot(runtime.db, {
      name: "Vazia",
      modelProvider: "script",
      modelId: "model-s",
    });
    const empty = await runtime.createRun({ botId: bot.id, objective: "x" });
    await expect(replayRecordedRun(runtime, empty.id)).rejects.toMatchObject({ code: "no_events" });
    await expect(
      replayRecordedRun(runtime, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toMatchObject({ code: "run_not_found" });
    await runtime.close();
  });

  it("runDoctorChecks lists the components and never throws", async () => {
    const runtime = await open();
    const checks = await runDoctorChecks(runtime);
    const by = new Map(checks.map((c) => [c.component, c]));
    expect(by.get("Banco de dados")).toMatchObject({ ok: true });
    expect(by.get("Sandbox")).toMatchObject({ ok: true });
    expect(by.get("Busca")?.ok).toBe(true);
    expect(by.get("Fila de execuções")).toMatchObject({ ok: true });
    expect(by.get("Provedor anthropic")).toMatchObject({ ok: false }); // KEY_A is not set
    expect(by.get("Provedor script")?.detail).toContain("NÃO é um modelo de verdade");
    expect(by.get("Ferramentas")?.detail).toContain("shell");

    // A broken database does not throw: it is a failed line.
    const broken = createRuntime(parseConfig(rawConfig()), {
      env: { DATABASE_URL: "postgres://suup@127.0.0.1:1/none" },
      baseDir: "/tmp",
    });
    const failed = await runDoctorChecks(broken);
    expect(failed.find((c) => c.component === "Banco de dados")).toMatchObject({ ok: false });
    await broken.close();
    await runtime.close();
  });

  it("the doctor warns when the queue has been waiting for a worker too long", async () => {
    const runtime = await open();
    const bot = await createBot(runtime.db, {
      name: "Fila",
      modelProvider: "script",
      modelId: "model-s",
    });
    const run = await runtime.createRun({ botId: bot.id, objective: "esperando" });
    await runtime.db
      .sql`update runs set created_at = now() - interval '10 minutes' where id = ${run.id}`;
    const queue = (await runDoctorChecks(runtime)).find((c) => c.component === "Fila de execuções");
    expect(queue).toMatchObject({ ok: false, detail: expect.stringContaining("nenhum worker") });
    await runtime.db
      .sql`update runs set status = 'cancelled', finished_at = now() where id = ${run.id}`;
    await runtime.close();
  });
});

describe("the reading of resend outcomes", () => {
  const ok = (stopReason: string, names: string[], attempt = 1) =>
    ({
      attempt,
      ok: true as const,
      latencyMs: 1,
      stopReason: stopReason as never,
      toolCalls: names.map((name) => ({ name, args: { a: 1 } })),
      text: "",
      usage: { inputTokens: 1, outputTokens: 1 },
      modelVersion: "v",
    }) satisfies Parameters<typeof outcomeKey>[0];

  it("keys an outcome by why it stopped and which tools it called", () => {
    expect(outcomeKey(ok("tool_calls", ["plan", "shell"]))).toBe("tool_calls|plan+shell");
    expect(outcomeKey(ok("end", []))).toBe("end|só texto");
    expect(describeOutcome("end|só texto")).toBe("respondeu só com texto (parada: end)");
    expect(describeOutcome("erro:rate_limit")).toBe("falha do provedor (rate_limit)");
  });

  it("tells a model that always errs from one that sometimes does", () => {
    const same = [1, 2, 3].map((n) => ok("end", [], n));
    const recorded = ok("end", [], 0);
    expect(summarizeAttempts(same, recorded, { sameModel: true, model: "m" }).reading).toContain(
      "3 de 3",
    );
    const mixed = [ok("end", [], 1), ok("tool_calls", ["shell"], 2)];
    expect(summarizeAttempts(mixed, recorded, { sameModel: true, model: "m" })).toMatchObject({
      recordedRepeated: 1,
      distinct: [{ count: 1 }, { count: 1 }],
    });
    expect(
      summarizeAttempts(mixed, recorded, { sameModel: false, model: "outro" }).reading,
    ).toContain("outro");
  });
});
