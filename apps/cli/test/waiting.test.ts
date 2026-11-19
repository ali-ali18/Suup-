import { describe, expect, it } from "vitest";
import { isReallyWaiting, questionPending } from "../src/waiting.js";

const ev = (...types: string[]) => types.map((type) => ({ type }));

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
});

describe("isReallyWaiting", () => {
  it("waiting_user stops only with an unanswered question (the resume flip does not)", () => {
    expect(isReallyWaiting("waiting_user", ev("escalated"), 0)).toBe(true);
    // The row flips back to waiting_user on resume while the answer is already in the log.
    expect(isReallyWaiting("waiting_user", ev("escalated", "user_message"), 0)).toBe(false);
  });

  it("waiting_approval stops only with a pending card", () => {
    expect(isReallyWaiting("waiting_approval", [], 1)).toBe(true);
    expect(
      isReallyWaiting("waiting_approval", ev("approval_requested", "approval_decided"), 0),
    ).toBe(false);
  });

  it("any other status is never waiting", () => {
    for (const status of ["queued", "running", "done"]) {
      expect(isReallyWaiting(status, ev("escalated"), 3)).toBe(false);
    }
  });
});
