import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  getRule,
  listRules,
  MIGRATIONS_DIR,
  migrate,
  RuleError,
  rulesForBot,
  updateRule,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// Migration 0013: a rule that matched by prefix, substring or glob stops applying (it is disabled,
// never deleted and never widened); a rule that compared for equality keeps working.
describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0013: rules by exact equality only"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("disables rules that used starts_with, contains or glob; keeps equals; reports why", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const held = (await readdir(MIGRATIONS_DIR)).filter((f) => f >= "0013" && f.endsWith(".sql"));
    for (const file of held) await rm(join(dir, file));
    await migrate(ctx.db, dir);

    const insert = async (tool: string, matchers: unknown) => {
      const [row] = await ctx.db.sql<{ id: string }[]>`
        insert into approval_rules (tool, effect, matchers)
        values (${tool}, 'allow', ${ctx.db.sql.json(matchers as never)}) returning id`;
      return row?.id as string;
    };
    const exact = await insert("shell", [{ field: "command", op: "equals", value: "git status" }]);
    const any = await insert("web_fetch", []);
    const prefix = await insert("shell", [{ field: "command", op: "starts_with", value: "git " }]);
    const part = await insert("write_file", [{ field: "path", op: "contains", value: "notas" }]);
    const glob = await insert("shell", [
      { field: "cwd", op: "equals", value: "repo" },
      { field: "command", op: "glob", value: "rm *" },
    ]);

    expect(await migrate(ctx.db)).toEqual(held);

    // untouched: equality and "any use" (an explicit choice) still apply
    for (const id of [exact, any]) {
      expect(await getRule(ctx.db, id)).toMatchObject({ enabled: true, disabledReason: null });
    }
    // disabled, not deleted, conditions still stored, with a reason that says what they were
    for (const id of [prefix, part, glob]) {
      const rule = await getRule(ctx.db, id);
      expect(rule).toMatchObject({ enabled: false, hasRemovedConditions: true });
      expect(rule?.disabledReason).toContain("não existe mais");
    }
    expect((await getRule(ctx.db, prefix))?.disabledReason).toContain('command starts_with "git "');
    expect((await getRule(ctx.db, glob))?.disabledReason).toContain('command glob "rm *"');
    expect((await listRules(ctx.db)).length).toBe(5);

    // they no longer reach the policy: nothing is silently broadened (or narrowed)
    const applied = (await rulesForBot(ctx.db, crypto.randomUUID())).map((r) => r.id);
    expect(applied.sort()).toEqual([exact, any].sort());
  });

  it("a disabled rule is turned on only with exact conditions, never as it was", async () => {
    const [row] = await ctx.db.sql<{ id: string }[]>`
      insert into approval_rules (tool, effect, matchers, enabled, disabled_reason)
      values ('shell', 'deny', '[{"field":"command","op":"glob","value":"rm *"}]'::jsonb, false, 'x')
      returning id`;
    const id = row?.id as string;
    await expect(updateRule(ctx.db, id, { enabled: true })).rejects.toBeInstanceOf(RuleError);
    expect((await getRule(ctx.db, id))?.enabled).toBe(false);
    const fixed = await updateRule(ctx.db, id, {
      matchers: [{ field: "command", value: "rm -rf build" }],
      enabled: true,
    });
    expect(fixed).toMatchObject({
      enabled: true,
      disabledReason: null,
      hasRemovedConditions: false,
      matchers: [{ field: "command", value: "rm -rf build" }],
    });
  });
});
