import { describe, expect, it } from "vitest";
import type { RunEventData } from "../events.js";
import { validateConversation } from "../messages.js";
import { estimateTokens, rebuildState } from "./state.js";
import type { StoredEvent } from "./store.js";

let seq = 0;
const at = (event: RunEventData): StoredEvent => ({ ...event, seq: ++seq, createdAt: new Date(0) });
const log = (...events: RunEventData[]): StoredEvent[] => {
  seq = 0;
  return events.map(at);
};

const started: RunEventData = {
  type: "run_started",
  payload: { botId: "b", objective: "Goal", acceptanceCriteria: [], origin: "user" },
};
const response = (blocks: Extract<RunEventData, { type: "model_response" }>["payload"]["blocks"]) =>
  ({
    type: "model_response",
    payload: {
      blocks,
      stopReason: blocks.some((b) => b.type === "tool_call") ? "tool_calls" : "end",
      usage: { inputTokens: 100, outputTokens: 20 },
      modelVersion: "v",
      durationMs: 1,
    },
  }) satisfies RunEventData;
const toolCall = (id: string, name = "echo"): RunEventData => ({
  type: "tool_call",
  payload: { callId: id, name, args: {} },
});
const toolResult = (id: string, content = "ok", isError = false): RunEventData => ({
  type: "tool_result",
  payload: {
    callId: id,
    outcome: isError ? "tool_error" : "ok",
    content,
    isError,
    truncated: false,
    durationMs: 1,
  },
});
const call = (id: string, name = "echo") => ({ type: "tool_call" as const, id, name, args: {} });

describe("rebuildState", () => {
  it("builds assistant messages from responses and user messages from results, messages and nudges", () => {
    const state = rebuildState(
      log(
        started,
        response([{ type: "text", text: "Working" }, call("1"), call("2")]),
        toolCall("1"),
        toolResult("1", "r1"),
        toolCall("2"),
        toolResult("2", "r2", true),
        { type: "user_message", payload: { text: "hey" } },
        { type: "nudge", payload: { reason: "x", text: "keep going" } },
      ),
    );
    expect(state.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(state.messages[0]?.blocks).toEqual([{ type: "text", text: "Goal" }]);
    const last = state.messages[2]?.blocks ?? [];
    expect(last[0]).toEqual({ type: "tool_result", callId: "1", content: "r1" });
    expect(last[1]).toEqual({ type: "tool_result", callId: "2", content: "r2", isError: true });
    expect(last[2]).toMatchObject({ type: "text" });
    expect(JSON.stringify(last[2])).toContain("hey");
    expect(JSON.stringify(last[3])).toContain("keep going");
    expect(validateConversation(state.messages)).toEqual([]);
    expect(state.pendingCalls).toEqual([]);
    expect(state.pending).toBeNull();
    expect(state.responses).toBe(1);
  });

  it("tracks calls that have no result yet, and whether they started", () => {
    const state = rebuildState(
      log(started, response([call("1"), call("2")]), toolCall("1"), toolResult("1"), toolCall("2")),
    );
    expect(state.pendingCalls).toEqual([{ id: "2", name: "echo", args: {}, started: true }]);
    expect(state.pending?.toolCalls).toHaveLength(2);
    expect(validateConversation(state.messages)[0]).toContain("has no tool_result");
  });

  it("takes the plan from plan_updated and remembers that a plan ever existed", () => {
    const state = rebuildState(
      log(started, {
        type: "plan_updated",
        payload: { plan: [{ id: "a", title: "A", status: "pending" }] },
      }),
    );
    expect(state.plan).toHaveLength(1);
    expect(state.hasPlan).toBe(true);
    expect(rebuildState(log(started)).hasPlan).toBe(false);
  });

  it("a compaction replaces everything up to uptoSeq with the summary", () => {
    const events = log(
      started, // 1
      response([call("1")]), // 2
      toolCall("1"), // 3
      toolResult("1", "first"), // 4
      response([call("2")]), // 5
      toolCall("2"), // 6
      toolResult("2", "second"), // 7
      response([call("3")]), // 8
      toolCall("3"), // 9
      toolResult("3", "third"), // 10
      { type: "compacted", payload: { summary: "SUM", uptoSeq: 4, droppedMessages: 3 } },
    );
    const state = rebuildState(events);
    expect(state.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(JSON.stringify(state.messages[0])).toContain("SUM");
    expect(JSON.stringify(state.messages)).not.toContain("first");
    expect(JSON.stringify(state.messages)).toContain("second");
    expect(validateConversation(state.messages)).toEqual([]);
    // New results still attach to the right message afterwards.
    const more = rebuildState([
      ...events,
      at(response([call("4")])),
      at(toolResult("4", "fourth")),
    ]);
    expect(validateConversation(more.messages)).toEqual([]);
    expect(more.messages).toHaveLength(7);
  });

  it("derives waiting, finish and review bookkeeping", () => {
    const state = rebuildState(
      log(started, response([call("e", "escalate")]), toolCall("e", "escalate"), {
        type: "escalated",
        payload: { question: "Q?", callId: "e" },
      }),
    );
    expect(state.waiting).toEqual({ kind: "escalate", callId: "e", question: "Q?" });
    expect(state.pendingCalls).toHaveLength(1);

    const answered = rebuildState([
      ...log(started, response([call("e", "escalate")]), toolCall("e", "escalate"), {
        type: "escalated",
        payload: { question: "Q?", callId: "e" },
      }),
      at(toolResult("e", "A")),
    ]);
    expect(answered.waiting).toBeNull();
    expect(answered.pendingCalls).toEqual([]);
  });

  it("counts turns without progress and repeated identical results", () => {
    const events = log(
      started,
      response([{ type: "text", text: "hm" }]),
      { type: "nudge", payload: { reason: "r", text: "t" } },
      response([call("1")]),
      toolCall("1"),
      toolResult("1", "same"),
      response([call("2")]),
      toolCall("2"),
      toolResult("2", "same"),
    );
    const state = rebuildState(events);
    expect(state.noProgressStreak).toBe(0);
    expect(state.repeat).toMatchObject({ name: "echo", count: 2, nudged: false });
    const stalled = rebuildState(events.slice(0, 3));
    expect(stalled.noProgressStreak).toBe(1);
  });
});

describe("estimateTokens", () => {
  it("uses the last real count plus chars/4 of what came after", () => {
    const state = rebuildState(
      log(started, response([call("1")]), toolCall("1"), toolResult("1", "x".repeat(400))),
    );
    expect(estimateTokens(state, 10_000)).toBe(120 + 100);
  });

  it("falls back to chars/4 of everything", () => {
    const state = rebuildState(log(started));
    expect(estimateTokens(state, 400)).toBe(Math.ceil((400 + "Goal".length) / 4));
  });
});
