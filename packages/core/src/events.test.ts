import { describe, expect, it } from "vitest";
import { parseRunEvent, RUN_EVENT_TYPES, type RunEventData } from "./events.js";

const samples: RunEventData[] = [
  {
    type: "run_started",
    payload: { botId: "b", objective: "o", acceptanceCriteria: ["c"], origin: "user" },
  },
  {
    type: "context_loaded",
    payload: {
      rules: [{ id: "r", text: "Always be brief." }],
      profile: [{ id: "p", text: "Lives in Recife." }],
      history: [{ role: "user", blocks: [{ type: "text", text: "hi" }] }],
      historyNote: "Older messages were left out.",
      secrets: [{ name: "GITHUB_TOKEN", description: "push access" }],
    },
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
  {
    type: "review",
    payload: {
      verdict: "reject",
      notes: "n",
      discrepancies: [{ claimed: "42", shows: "41", where: "#1" }],
    },
  },
  {
    type: "review_reprompt",
    payload: { callId: "v0", args: { verdict: "reject", notes: "n" }, reason: "no discrepancy" },
  },
  { type: "review", payload: { verdict: "unverified", notes: "could not check the CNPJ" } },
  {
    type: "review_evidence",
    payload: {
      round: 1,
      callId: "v1",
      notes: "need the contract",
      requested: { results: ["#1"], calls: ["#2"], files: ["contrato.md"] },
      supplied: [
        { kind: "tool_result", ref: "c1", index: 1, chars: 10, sent: 10 },
        { kind: "tool_call", ref: "c2", index: 2, chars: 30, sent: 30 },
        { kind: "file", ref: "contrato.md", chars: 4, sent: 4, hash: "abcd", content: "text" },
      ],
      missing: [{ item: "#9", reason: "no such tool result", hint: "ask for the call" }],
      omitted: [{ item: "#8", chars: 70000 }],
      budgetChars: 60000,
    },
  },
  { type: "escalated", payload: { question: "q" } },
  {
    type: "status_changed",
    payload: { from: "running", to: "failed", failure: { origin: "limit", detail: "d" } },
  },
  { type: "compacted", payload: { summary: "s", uptoSeq: 7, droppedMessages: 3 } },
  {
    type: "policy_checked",
    payload: {
      callId: "1",
      tool: "shell",
      level: "write_reversible",
      outcome: "deny",
      source: "rule",
      ruleId: "r1",
      reason: "no",
    },
  },
  {
    type: "approval_requested",
    payload: {
      approvalId: "a1",
      callId: "1",
      tool: "shell",
      args: { command: "curl -H 'x: {{secret:TOKEN}}' https://example.com" },
      level: "external_irreversible",
      summary: "shell curl ...",
      secrets: ["TOKEN"],
      source: "default",
      expiresAt: "2026-11-19T00:00:00.000Z",
    },
  },
  {
    type: "approval_decided",
    payload: { approvalId: "a1", callId: "1", decision: "denied", reason: "no", ruleId: "r2" },
  },
  { type: "secret_requested", payload: { callId: "1", name: "GITHUB_TOKEN", reason: "push" } },
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
