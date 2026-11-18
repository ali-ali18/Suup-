import { describe, expect, it } from "vitest";
import { type Message, messageSchema, validateConversation } from "./messages.js";

const call = (id: string) => ({ type: "tool_call" as const, id, name: "t", args: {} });
const result = (callId: string) => ({ type: "tool_result" as const, callId, content: "ok" });
const user = (...blocks: Message["blocks"]): Message => ({ role: "user", blocks });
const assistant = (...blocks: Message["blocks"]): Message => ({ role: "assistant", blocks });
const text = (t: string) => ({ type: "text" as const, text: t });

describe("validateConversation", () => {
  it("accepts a well-formed conversation with parallel calls", () => {
    expect(
      validateConversation([
        user(text("hi")),
        assistant(text("working"), call("a"), call("b")),
        user(result("b"), result("a")),
        assistant(text("done")),
      ]),
    ).toEqual([]);
  });

  it("accepts an empty conversation", () => {
    expect(validateConversation([])).toEqual([]);
  });

  it("reports a missing result", () => {
    const problems = validateConversation([
      user(text("hi")),
      assistant(call("a"), call("b")),
      user(result("a")),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"b"');
  });

  it("reports calls with nothing after them", () => {
    expect(validateConversation([assistant(call("a"))])).toHaveLength(1);
    expect(validateConversation([assistant(call("a")), assistant(text("x"))])).toHaveLength(1);
  });

  it("reports an orphan result", () => {
    const problems = validateConversation([
      user(text("hi")),
      assistant(text("no calls")),
      user(result("zzz")),
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("orphan");
  });

  it("reports a result placed before its call", () => {
    const problems = validateConversation([
      user(result("a")),
      assistant(call("a")),
      user(text("late")),
    ]);
    expect(problems.some((p) => p.includes("orphan"))).toBe(true);
    expect(problems.some((p) => p.includes("no tool_result"))).toBe(true);
  });

  it("reports a result that is not in the immediately following message", () => {
    const problems = validateConversation([
      assistant(call("a")),
      user(text("interruption")),
      assistant(text("hm")),
      user(result("a")),
    ]);
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });

  it("reports duplicate results and wrong roles", () => {
    expect(
      validateConversation([assistant(call("a")), user(result("a"), result("a"))]).join(),
    ).toContain("duplicate");
    expect(validateConversation([user(call("a"))])[0]).toContain("assistant");
    expect(validateConversation([assistant(result("a"))])[0]).toContain("user");
  });
});

describe("messageSchema", () => {
  it("round-trips every block type", () => {
    const message: Message = assistant(text("x"), call("a"), {
      type: "provider_data",
      provider: "p",
      data: { nested: [1, null, "s"] },
    });
    expect(messageSchema.parse(JSON.parse(JSON.stringify(message)))).toEqual(message);
    expect(messageSchema.parse(user({ ...result("a"), isError: true }))).toEqual(
      user({ ...result("a"), isError: true }),
    );
  });

  it("rejects an unknown block type", () => {
    expect(() => messageSchema.parse({ role: "user", blocks: [{ type: "nope" }] })).toThrow();
  });
});
