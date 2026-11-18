import { describe, expect, it } from "vitest";
import { parseRunEvent, RUN_EVENT_TYPES, type RunEventData } from "./events.js";

const samples: RunEventData[] = [
  {
    type: "run_started",
    payload: { botId: "b", objective: "o", acceptanceCriteria: ["c"], origin: "user" },
  },
  {
    type: "model_request",
    payload: {
      provider: "p",
      model: "model-x",
      system: "s",
      messages: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      maxOutputTokens: 100,
      temperature: 0.2,
    },
  },
  {
    type: "model_response",
    payload: {
      blocks: [{ type: "tool_call", id: "1", name: "t", args: { a: [1] } }],
      stopReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 },
      modelVersion: "v",
      durationMs: 12,
    },
  },
  {
    type: "model_error",
    payload: { kind: "rate_limit", message: "m", retryable: true, attempt: 1 },
  },
  { type: "tool_call", payload: { callId: "1", name: "t", args: null } },
  {
    type: "tool_result",
    payload: {
      callId: "1",
      outcome: "denied",
      content: "c",
      isError: true,
      truncated: false,
      durationMs: 1,
    },
  },
  {
    type: "plan_updated",
    payload: { plan: [{ id: "1", title: "t", status: "dropped", note: "n" }] },
  },
  { type: "user_message", payload: { text: "t" } },
  { type: "nudge", payload: { reason: "pending steps", text: "continue" } },
  {
    type: "finish_attempt",
    payload: {
      summary: "s",
      evidence: [{ criterion: "c", evidence: "e" }],
      accepted: false,
      rejectionReasons: ["r"],
    },
  },
  { type: "review", payload: { verdict: "reject", notes: "n" } },
  { type: "escalated", payload: { question: "q" } },
  {
    type: "status_changed",
    payload: { from: "running", to: "failed", failure: { origin: "limit", detail: "d" } },
  },
  { type: "compacted", payload: { summary: "s", uptoSeq: 7, droppedMessages: 3 } },
];

describe("parseRunEvent", () => {
  it("round-trips a sample of every event type through JSON", () => {
    expect(new Set(samples.map((s) => s.type))).toEqual(new Set(RUN_EVENT_TYPES));
    for (const sample of samples) {
      const stored = JSON.parse(JSON.stringify(sample.payload));
      expect(parseRunEvent(sample.type, stored)).toEqual(sample);
    }
  });

  it("rejects a bad payload", () => {
    expect(() => parseRunEvent("tool_call", { callId: 1 })).toThrow();
    expect(() =>
      parseRunEvent("compacted", { summary: "s", uptoSeq: 1, droppedMessages: -1 }),
    ).toThrow();
    expect(() => parseRunEvent("status_changed", { from: "x", to: "done" })).toThrow();
  });

  it("rejects an unknown type", () => {
    expect(() => parseRunEvent("nope", {})).toThrow();
  });
});
