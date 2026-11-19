import { describe, expect, it } from "vitest";
import {
  appendRunEvent,
  createBot,
  createWrittenRule,
  deleteWrittenRule,
  getApproval,
  getApprovalMode,
  getWrittenRule,
  listWrittenRules,
  setApprovalMode,
  updateWrittenRule,
  WrittenRuleError,
  writtenRulesForBot,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { makeRun } from "./kit.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("written rules and the approval mode"), () => {
  const ctx = useIsolatedDb();

  it("keeps the text the user wrote, trimmed, and nothing else about it", async () => {
    const rule = await createWrittenRule(ctx.db, {
      kind: "allow",
      text: "  Permitir sem perguntar: e-mails para minha equipe em acme.com\n",
    });
    expect(rule).toMatchObject({
      kind: "allow",
      text: "Permitir sem perguntar: e-mails para minha equipe em acme.com",
      botId: null,
      enabled: true,
    });
    expect(await getWrittenRule(ctx.db, rule.id)).toEqual(rule);
  });

  it("bounds the text (1 to 500 characters) and the kind", async () => {
    await expect(createWrittenRule(ctx.db, { kind: "allow", text: "   " })).rejects.toThrow();
    await expect(
      createWrittenRule(ctx.db, { kind: "allow", text: "x".repeat(501) }),
    ).rejects.toThrow();
    await expect(
      createWrittenRule(ctx.db, { kind: "talvez" as never, text: "ok" }),
    ).rejects.toThrow();
    const exact = await createWrittenRule(ctx.db, { kind: "ask", text: "y".repeat(500) });
    expect(exact.text).toHaveLength(500);
    await deleteWrittenRule(ctx.db, exact.id);
  });

  it("the database itself refuses a text that was not trimmed or is too long", async () => {
    await expect(
      ctx.db.sql`insert into written_rules (kind, text) values ('allow', ' x')`,
    ).rejects.toThrow(/written_rules_text_check/);
    await expect(
      ctx.db.sql`insert into written_rules (kind, text) values ('allow', ${"z".repeat(501)})`,
    ).rejects.toThrow(/written_rules_text_check/);
  });

  it("applies to one bot or to all, and only enabled rules reach the reviewer", async () => {
    const a = await createBot(ctx.db, { name: "A", modelProvider: "fake", modelId: "m" });
    const b = await createBot(ctx.db, { name: "B", modelProvider: "fake", modelId: "m" });
    const forAll = await createWrittenRule(ctx.db, { kind: "ask", text: "gastar dinheiro" });
    const forA = await createWrittenRule(ctx.db, {
      kind: "never",
      text: "apagar notas",
      botId: a.id,
    });
    const off = await createWrittenRule(ctx.db, {
      kind: "allow",
      text: "desligada",
      botId: a.id,
      enabled: false,
    });

    const idsFor = async (botId: string) =>
      (await writtenRulesForBot(ctx.db, botId)).map((r) => r.id);
    expect(await idsFor(a.id)).toEqual(expect.arrayContaining([forAll.id, forA.id]));
    expect(await idsFor(a.id)).not.toContain(off.id);
    expect(await idsFor(b.id)).toContain(forAll.id);
    expect(await idsFor(b.id)).not.toContain(forA.id);
    // the listing, unlike what the reviewer reads, shows the disabled one too
    expect((await listWrittenRules(ctx.db, { botId: a.id })).map((r) => r.id)).toContain(off.id);
    // the reviewer reads kind, text and scope only
    expect((await writtenRulesForBot(ctx.db, a.id)).find((r) => r.id === forA.id)).toEqual({
      id: forA.id,
      kind: "never",
      text: "apagar notas",
      botId: a.id,
    });
  });

  it("edits kind, text and the switch; deleting a bot deletes its rules", async () => {
    const bot = await createBot(ctx.db, { name: "C", modelProvider: "fake", modelId: "m" });
    const rule = await createWrittenRule(ctx.db, { kind: "ask", text: "um", botId: bot.id });
    const edited = await updateWrittenRule(ctx.db, rule.id, {
      kind: "never",
      text: " dois ",
      enabled: false,
    });
    expect(edited).toMatchObject({ kind: "never", text: "dois", enabled: false });
    expect(edited?.updatedAt.getTime()).toBeGreaterThanOrEqual(rule.updatedAt.getTime());
    expect(await updateWrittenRule(ctx.db, crypto.randomUUID(), { text: "x" })).toBeNull();
    await ctx.db.sql`delete from bots where id = ${bot.id}`;
    expect(await getWrittenRule(ctx.db, rule.id)).toBeNull();
  });

  it("refuses more rules than the review prompt can carry", async () => {
    const [row] = await ctx.db.sql<{ n: number }[]>`select count(*)::int as n from written_rules`;
    const n = row?.n ?? 0;
    await ctx.db.sql`
      insert into written_rules (kind, text)
      select 'ask', 'regra ' || g from generate_series(1, ${100 - n}) g`;
    await expect(
      createWrittenRule(ctx.db, { kind: "ask", text: "mais uma" }),
    ).rejects.toBeInstanceOf(WrittenRuleError);
    await ctx.db.sql`delete from written_rules`;
  });

  it("the mode starts as auto_review, is stored in the database and only takes two values", async () => {
    expect(await getApprovalMode(ctx.db)).toBe("auto_review");
    expect(await setApprovalMode(ctx.db, "ask_all")).toBe("ask_all");
    expect(await getApprovalMode(ctx.db)).toBe("ask_all");
    await expect(setApprovalMode(ctx.db, "tudo" as never)).rejects.toThrow();
    await expect(ctx.db.sql`update approval_settings set mode = 'tudo'`).rejects.toThrow();
    await expect(
      ctx.db.sql`insert into approval_settings (singleton) values (false)`,
    ).rejects.toThrow();
    await setApprovalMode(ctx.db, "auto_review");
  });

  it("a card keeps why the reviewer sent it to the user, and the rule it cited", async () => {
    const run = await makeRun(ctx.db, { status: "running", leasedTo: "w1" });
    const rule = await createWrittenRule(ctx.db, { kind: "ask", text: "gastar dinheiro" });
    const approvalId = crypto.randomUUID();
    await appendRunEvent(
      ctx.db,
      run.id,
      "approval_requested",
      {
        approvalId,
        callId: "c1",
        tool: "send",
        args: {},
        level: "external_irreversible",
        summary: "s",
        secrets: [],
        source: "reviewer",
        reason: "Gasta dinheiro.",
        writtenRuleId: rule.id,
      },
      { leaseHolder: "w1" },
    );
    expect(await getApproval(ctx.db, approvalId)).toMatchObject({
      source: "reviewer",
      reviewReason: "Gasta dinheiro.",
      writtenRuleId: rule.id,
    });
    // the rule may go away; the card still says why
    await deleteWrittenRule(ctx.db, rule.id);
    expect(await getApproval(ctx.db, approvalId)).toMatchObject({
      reviewReason: "Gasta dinheiro.",
      writtenRuleId: rule.id,
    });
  });
});
