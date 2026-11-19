import { describe, expect, it } from "vitest";
import { decidePolicy } from "./decide.js";
import { approvalIdFor } from "./id.js";
import { levelReviewer, levelVerdict, stricter } from "./reviewer.js";
import {
  type ApprovalRule,
  argMatcherSchema,
  matcherMatches,
  recipientMatchers,
  ruleMatches,
} from "./rules.js";

const call = (tool: string, args: Record<string, unknown> = {}, botId = "bot-1") => ({
  botId,
  tool,
  args: args as never,
});

const rule = (over: Partial<ApprovalRule> & Pick<ApprovalRule, "id" | "effect">): ApprovalRule => ({
  botId: null,
  tool: "*",
  matchers: [],
  ...over,
});

describe("decidePolicy: the three filters in order", () => {
  it("without rules the level decides: read and reversible write pass, the rest asks", () => {
    expect(decidePolicy({ call: call("t"), level: "read", rules: [] })).toEqual({
      outcome: "allow",
      source: "default",
    });
    expect(decidePolicy({ call: call("t"), level: "write_reversible", rules: [] }).outcome).toBe(
      "allow",
    );
    expect(decidePolicy({ call: call("t"), level: "external_irreversible", rules: [] })).toEqual({
      outcome: "ask",
      source: "default",
    });
  });

  it("a rule that allows lets an irreversible call through", () => {
    const rules = [rule({ id: "r1", effect: "allow", tool: "send" })];
    expect(decidePolicy({ call: call("send"), level: "external_irreversible", rules })).toEqual({
      outcome: "allow",
      source: "rule",
      ruleId: "r1",
    });
  });

  it("a rule that denies stops even a plain read, and wins over an allow rule", () => {
    const rules = [
      rule({ id: "allow", effect: "allow", tool: "send" }),
      rule({ id: "deny", effect: "deny", tool: "send", note: "never" }),
    ];
    const out = decidePolicy({ call: call("send"), level: "read", rules });
    expect(out).toMatchObject({ outcome: "deny", source: "rule", ruleId: "deny" });
    expect(out.reason).toContain("never");
  });

  it("rules are scoped by bot and by tool", () => {
    const rules = [rule({ id: "r", effect: "allow", tool: "send", botId: "bot-2" })];
    expect(
      decidePolicy({ call: call("send", {}, "bot-1"), level: "external_irreversible", rules })
        .outcome,
    ).toBe("ask");
    expect(
      decidePolicy({ call: call("send", {}, "bot-2"), level: "external_irreversible", rules })
        .outcome,
    ).toBe("allow");
    expect(
      decidePolicy({ call: call("other", {}, "bot-2"), level: "external_irreversible", rules })
        .outcome,
    ).toBe("ask");
  });

  it("argument matchers must all hold", () => {
    const rules = [
      rule({
        id: "r",
        effect: "allow",
        tool: "shell",
        matchers: [
          { field: "command", value: "git push origin x" },
          { field: "cwd", value: "repo" },
        ],
      }),
    ];
    const level = "external_irreversible" as const;
    expect(
      decidePolicy({
        call: call("shell", { command: "git push origin x", cwd: "repo" }),
        level,
        rules,
      }).outcome,
    ).toBe("allow");
    expect(
      decidePolicy({
        call: call("shell", { command: "git push origin x", cwd: "other" }),
        level,
        rules,
      }).outcome,
    ).toBe("ask");
    expect(
      decidePolicy({ call: call("shell", { command: "git push origin x" }), level, rules }).outcome,
    ).toBe("ask");
  });

  it("a bot rule is preferred over a global one when both allow", () => {
    const rules = [
      rule({ id: "global", effect: "allow" }),
      rule({ id: "mine", effect: "allow", botId: "bot-1" }),
    ];
    expect(decidePolicy({ call: call("t"), level: "external_irreversible", rules }).ruleId).toBe(
      "mine",
    );
  });

  it("the reviewer can tighten but never loosen", () => {
    expect(
      decidePolicy({
        call: call("t"),
        level: "read",
        rules: [],
        review: { verdict: "sensitive" },
      }),
    ).toEqual({ outcome: "ask", source: "reviewer" });
    const blocked = decidePolicy({
      call: call("t"),
      level: "write_reversible",
      rules: [],
      review: { verdict: "blocked", reason: "looks like an exfiltration" },
    });
    expect(blocked).toMatchObject({ outcome: "deny", source: "reviewer" });
    expect(blocked.reason).toContain("exfiltration");
    // A reviewer saying "safe" does not wave an irreversible action through.
    expect(
      decidePolicy({
        call: call("t"),
        level: "external_irreversible",
        rules: [],
        review: { verdict: "safe" },
      }),
    ).toEqual({ outcome: "ask", source: "default" });
  });

  it("user rules come before the reviewer", () => {
    const rules = [rule({ id: "r", effect: "allow" })];
    expect(
      decidePolicy({ call: call("t"), level: "read", rules, review: { verdict: "blocked" } }),
    ).toMatchObject({ outcome: "allow", source: "rule" });
  });
});

describe("rules", () => {
  it("compare by exact equality of the named argument, and nothing else", () => {
    const args = { path: "/etc/passwd", n: 3, flag: true, deep: { x: "yes" } };
    expect(matcherMatches({ field: "path", value: "/etc/passwd" }, args)).toBe(true);
    expect(matcherMatches({ field: "n", value: "3" }, args)).toBe(true);
    expect(matcherMatches({ field: "flag", value: "true" }, args)).toBe(true);
    expect(matcherMatches({ field: "deep.x", value: "yes" }, args)).toBe(true);
    // a start, a part, a pattern or a different case is not the same value
    expect(matcherMatches({ field: "path", value: "/etc" }, args)).toBe(false);
    expect(matcherMatches({ field: "path", value: "passw" }, args)).toBe(false);
    expect(matcherMatches({ field: "path", value: "/etc/*" }, args)).toBe(false);
    expect(matcherMatches({ field: "path", value: "/etc/p?sswd" }, args)).toBe(false);
    expect(matcherMatches({ field: "path", value: ".*" }, args)).toBe(false);
    expect(matcherMatches({ field: "path", value: "/ETC/passwd" }, args)).toBe(false);
    expect(matcherMatches({ field: "missing", value: "" }, args)).toBe(false);
    expect(matcherMatches({ field: "deep", value: "x" }, args)).toBe(false);
  });

  it("a pattern written as the value only matches itself", () => {
    expect(matcherMatches({ field: "a", value: "a.b(c)+" }, { a: "a.b(c)+" })).toBe(true);
    expect(matcherMatches({ field: "a", value: "a.b" }, { a: "axb" })).toBe(false);
    expect(matcherMatches({ field: "a", value: "git *" }, { a: "git status" })).toBe(false);
  });

  it("a matcher has no operator: the removed ones are refused, not ignored", () => {
    expect(argMatcherSchema.safeParse({ field: "a", value: "b" }).success).toBe(true);
    for (const op of ["equals", "starts_with", "contains", "glob", "regex"]) {
      expect(argMatcherSchema.safeParse({ field: "a", op, value: "b" }).success).toBe(false);
    }
  });

  it("a rule without matchers means any use of the tool (an explicit choice)", () => {
    const r = rule({ id: "r", effect: "allow", tool: "send" });
    expect(ruleMatches(r, call("send", { to: "anyone" }))).toBe(true);
    expect(ruleMatches(r, call("other"))).toBe(false);
  });

  it("recipientMatchers pins exactly the recipient fields, as text", () => {
    expect(
      recipientMatchers({ to: "ana@x.com", subject: "hi", body: "b" }, { recipientFields: ["to"] }),
    ).toEqual([{ field: "to", value: "ana@x.com" }]);
    expect(
      recipientMatchers({ to: "a@x.com", cc: "b@x.com" }, { recipientFields: ["to", "cc"] }),
    ).toEqual([
      { field: "to", value: "a@x.com" },
      { field: "cc", value: "b@x.com" },
    ]);
    const r = rule({
      id: "r",
      effect: "allow",
      tool: "send",
      matchers: recipientMatchers({ to: "ana@x.com" }, { recipientFields: ["to"] }) ?? [],
    });
    expect(ruleMatches(r, call("send", { to: "ana@x.com", subject: "other" }))).toBe(true);
    expect(ruleMatches(r, call("send", { to: "bob@x.com" }))).toBe(false);
  });

  it("recipientMatchers says null when the recipient cannot be said exactly", () => {
    expect(recipientMatchers({ to: ["a@x.com"] }, { recipientFields: ["to"] })).toBeNull();
    expect(recipientMatchers({ cc: "a@x.com" }, { recipientFields: ["to"] })).toBeNull();
    expect(recipientMatchers({ to: "  " }, { recipientFields: ["to"] })).toBeNull();
    expect(recipientMatchers({ to: "a@x.com" }, { recipientFields: [] })).toBeNull();
    expect(recipientMatchers({ to: "a@x.com" }, { recipientFields: ["to", "cc"] })).toBeNull();
  });
});

describe("reviewer and ids", () => {
  it("the default reviewer only maps the level", async () => {
    for (const level of ["read", "write_reversible", "external_irreversible"] as const) {
      expect(
        await levelReviewer.review({ botId: "b", tool: "t", args: {}, level, summary: "s" }),
      ).toEqual(levelVerdict(level));
    }
    expect(stricter({ verdict: "sensitive" }, { verdict: "safe" }).verdict).toBe("sensitive");
    expect(stricter({ verdict: "safe" }, { verdict: "blocked" }).verdict).toBe("blocked");
  });

  it("the approval id is stable, unique per call and shaped like a UUID", () => {
    const a = approvalIdFor("run-1", "call-1");
    expect(a).toBe(approvalIdFor("run-1", "call-1"));
    expect(a).not.toBe(approvalIdFor("run-1", "call-2"));
    expect(a).not.toBe(approvalIdFor("run-2", "call-1"));
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
