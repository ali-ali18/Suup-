import { describe, expect, it } from "vitest";
import { decidePolicy } from "./decide.js";
import { approvalIdFor } from "./id.js";
import { levelReviewer, levelVerdict, stricter } from "./reviewer.js";
import { type ApprovalRule, exactMatchers, matcherMatches, ruleMatches } from "./rules.js";

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
          { field: "command", op: "starts_with", value: "git push" },
          { field: "cwd", op: "equals", value: "repo" },
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
  it("compares as asked", () => {
    const args = { path: "/etc/passwd", n: 3, deep: { x: "yes" } };
    expect(matcherMatches({ field: "path", op: "equals", value: "/etc/passwd" }, args)).toBe(true);
    expect(matcherMatches({ field: "path", op: "starts_with", value: "/etc" }, args)).toBe(true);
    expect(matcherMatches({ field: "path", op: "contains", value: "passw" }, args)).toBe(true);
    expect(matcherMatches({ field: "path", op: "glob", value: "/etc/*" }, args)).toBe(true);
    expect(matcherMatches({ field: "path", op: "glob", value: "/etc/p?sswd" }, args)).toBe(true);
    expect(matcherMatches({ field: "path", op: "glob", value: "/etc" }, args)).toBe(false);
    expect(matcherMatches({ field: "n", op: "equals", value: "3" }, args)).toBe(true);
    expect(matcherMatches({ field: "deep.x", op: "equals", value: "yes" }, args)).toBe(true);
    expect(matcherMatches({ field: "missing", op: "contains", value: "" }, args)).toBe(false);
    expect(matcherMatches({ field: "deep", op: "contains", value: "x" }, args)).toBe(false);
  });

  it("a glob does not read its pattern as a regular expression", () => {
    expect(matcherMatches({ field: "a", op: "glob", value: "a.b(c)+" }, { a: "a.b(c)+" })).toBe(
      true,
    );
    expect(matcherMatches({ field: "a", op: "glob", value: "a.b" }, { a: "axb" })).toBe(false);
  });

  it("exactMatchers pins the text arguments only", () => {
    expect(exactMatchers({ to: "ana", body: "hi", retries: 2, flag: true })).toEqual([
      { field: "to", op: "equals", value: "ana" },
      { field: "body", op: "equals", value: "hi" },
    ]);
    const r = rule({
      id: "r",
      effect: "allow",
      tool: "send",
      matchers: exactMatchers({ to: "ana" }),
    });
    expect(ruleMatches(r, call("send", { to: "ana", extra: 1 }))).toBe(true);
    expect(ruleMatches(r, call("send", { to: "bob" }))).toBe(false);
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
