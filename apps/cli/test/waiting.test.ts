import { describe, expect, it } from "vitest";
import { isReallyWaiting, questionPending } from "../src/waiting.js";

const ev = (...types: string[]) => types.map((type) => ({ type }));
const ask = (callId: string, type = "escalated") => ({ type, payload: { callId } });
const answer = (callId: string) => ({ type: "tool_result", payload: { callId, inboxIds: ["1"] } });

describe("questionPending", () => {
  it("is pending when the last question or secret request has no answer after it", () => {
    expect(questionPending(ev("run_started", "escalated"))).toBe(true);
    expect(questionPending(ev("escalated", "tool_call", "secret_requested"))).toBe(true);
    expect(questionPending(ev("escalated", "user_message", "escalated"))).toBe(true);
  });

  it("is not pending once a user message follows, or when nothing was asked", () => {
    expect(questionPending(ev("escalated", "user_message"))).toBe(false);
    expect(questionPending(ev("secret_requested", "user_message", "tool_result"))).toBe(false);
    expect(questionPending(ev("run_started", "model_request"))).toBe(false);
    expect(questionPending([])).toBe(false);
  });

  it("an answer delivered as the tool_result of the asking call settles the question", () => {
    // This is how the loop delivers the answer to `escalate` and `request_secret`.
    expect(questionPending([ask("c1"), answer("c1")])).toBe(false);
    expect(questionPending([ask("c1", "secret_requested"), answer("c1")])).toBe(false);
    // The result of another call does not settle it.
    expect(questionPending([ask("c1"), { type: "tool_result", payload: { callId: "c2" } }])).toBe(
      true,
    );
    expect(questionPending([ask("c1"), answer("c1"), ask("c2")])).toBe(true);
  });
});

describe("isReallyWaiting", () => {
  it("waiting_user stops only with an unanswered question (the resume flip does not)", () => {
    expect(isReallyWaiting("waiting_user", ev("escalated"), 0)).toBe(true);
    // The row flips back to waiting_user on resume while the answer is already in the log.
    expect(isReallyWaiting("waiting_user", ev("escalated", "user_message"), 0)).toBe(false);
    expect(isReallyWaiting("waiting_user", [ask("c1"), answer("c1")], 0)).toBe(false);
  });

  it("waiting_user with the answer still in the inbox is the resume flip, not a wait", () => {
    // `suup say` queued the run; the worker took it and put the row back at the logged status
    // BEFORE absorbing the answer: the log still ends at the question, the inbox is not empty.
    expect(isReallyWaiting("waiting_user", [ask("c1")], 0, true)).toBe(false);
    expect(isReallyWaiting("waiting_user", [ask("c1")], 0, false)).toBe(true);
  });

  it("waiting_approval stops only with a pending card", () => {
    expect(isReallyWaiting("waiting_approval", [], 1)).toBe(true);
    expect(
      isReallyWaiting("waiting_approval", ev("approval_requested", "approval_decided"), 0),
    ).toBe(false);
  });

  it("any other status is never waiting", () => {
    for (const status of ["queued", "running", "done"]) {
      expect(isReallyWaiting(status, ev("escalated"), 3, true)).toBe(false);
      expect(isReallyWaiting(status, ev("escalated"), 3)).toBe(false);
    }
  });
});
