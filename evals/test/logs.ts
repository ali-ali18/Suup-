import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunRecord, StoredEvent } from "@suup/core";
import { LocalExecutor } from "@suup/sandbox";
import { afterAll } from "vitest";

type Json = Record<string, unknown>;

/**
 * Builds the event log a run would leave, event by event, so the checks that read the log can be
 * tested without a model. Only what the checks look at is filled in.
 */
export class Log {
  readonly events: StoredEvent[] = [];
  #calls = 0;

  #push(type: string, payload: Json): this {
    this.events.push({
      type,
      payload,
      seq: this.events.length + 1,
      createdAt: new Date(2026, 10, 18, 12, 0, this.events.length),
    } as unknown as StoredEvent);
    return this;
  }

  started(objective = "objetivo"): this {
    return this.#push("run_started", {
      botId: "bot",
      objective,
      acceptanceCriteria: [],
      origin: "user",
    });
  }

  /** A model request and its response (the agent's own turn). */
  turn(modelVersion = "versao-1"): this {
    this.#push("model_request", {
      provider: "p",
      model: "m",
      system: "s",
      messages: [],
      tools: [],
      maxOutputTokens: 100,
    });
    return this.#push("model_response", {
      blocks: [],
      stopReason: "tool_calls",
      usage: { inputTokens: 10, outputTokens: 5 },
      modelVersion,
      durationMs: 5,
    });
  }

  /** A tool call and its result. */
  call(name: string, args: Json, content = "ok", outcome = "ok"): this {
    const callId = `c${++this.#calls}`;
    this.#push("tool_call", { callId, name, args });
    return this.#push("tool_result", {
      callId,
      outcome,
      content,
      isError: outcome !== "ok",
      truncated: false,
      durationMs: 1,
    });
  }

  shell(command: string, exitCode = 0, output = ""): this {
    return this.call(
      "shell",
      { command },
      `exit code: ${exitCode}\n--- stdout ---\n${output || "(empty)"}\n--- stderr ---\n(empty)`,
    );
  }

  plan(): this {
    this.#push("plan_updated", { plan: [{ id: "s1", title: "fazer", status: "in_progress" }] });
    return this.call(
      "plan",
      { steps: [{ id: "s1", title: "fazer", status: "in_progress" }] },
      "Plan saved",
    );
  }

  nudge(): this {
    return this.#push("nudge", { reason: "stopped_without_finish", text: "continue" });
  }

  userMessage(text: string): this {
    return this.#push("user_message", { text, inboxId: "1" });
  }

  escalate(question: string): this {
    const callId = `c${++this.#calls}`;
    this.#push("tool_call", { callId, name: "escalate", args: { question } });
    return this.#push("escalated", { question, callId });
  }

  /** The user's answer to the last `escalate`, delivered as its tool result. */
  answer(text: string): this {
    const call = [...this.events].reverse().find((e) => e.type === "escalated");
    const callId = (call?.payload as { callId?: string } | undefined)?.callId ?? "c?";
    return this.#push("tool_result", {
      callId,
      outcome: "ok",
      content: text,
      isError: false,
      truncated: false,
      durationMs: 0,
      inboxIds: ["1"],
    });
  }

  /** A `finish` call, its attempt and (when accepted) the move to `done`. */
  finish(
    evidence: { criterion: string; evidence: string }[] = [],
    accepted = true,
    reasons: string[] = [],
    summary = "pronto",
  ): this {
    const callId = `c${++this.#calls}`;
    this.#push("tool_call", { callId, name: "finish", args: { summary, evidence } });
    this.#push("finish_attempt", {
      callId,
      summary,
      evidence,
      accepted,
      rejectionReasons: reasons,
    });
    this.#push("tool_result", {
      callId,
      outcome: accepted ? "ok" : "tool_error",
      content: accepted ? "Finish accepted." : "Finish was not accepted",
      isError: !accepted,
      truncated: false,
      durationMs: 1,
    });
    return accepted ? this.status("done", summary) : this;
  }

  status(to: string, summary?: string): this {
    return this.#push("status_changed", {
      from: "running",
      to,
      ...(summary === undefined ? {} : { result: { summary } }),
    });
  }
}

export function runRecord(
  status: RunRecord["status"],
  overrides: Partial<RunRecord> = {},
): RunRecord {
  return {
    id: "run-1",
    botId: "bot-1",
    objective: "objetivo",
    acceptanceCriteria: [],
    plan: [],
    status,
    origin: "user",
    turns: 3,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.01,
    createdAt: new Date(2026, 10, 18),
    startedAt: new Date(2026, 10, 18),
    ...overrides,
  };
}

const temps: string[] = [];
afterAll(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

export async function tempDir(prefix = "suup-evals-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/** A fresh workspace on the real filesystem, like a bot's machine. */
export async function workspace(): Promise<LocalExecutor> {
  return new LocalExecutor({ root: await tempDir(), iUnderstandThisIsNotIsolated: true });
}
