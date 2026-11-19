import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getApprovalMode, listWrittenRules, MIGRATIONS_DIR, migrate } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

// Migration 0016: nothing that already existed changes; the mode starts as auto_review; there are no
// written rules until the user writes one.
describe.skipIf(!DATABASE_URL)(dbSuiteName("migration 0016: written rules and mode"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("keeps the cards and the exact rules of before, adds the mode and an empty list of rules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suup-migrations-"));
    await cp(MIGRATIONS_DIR, dir, { recursive: true });
    const held = (await readdir(MIGRATIONS_DIR)).filter((f) => f >= "0016" && f.endsWith(".sql"));
    expect(held.length).toBeGreaterThan(0);
    for (const file of held) await rm(join(dir, file));
    await migrate(ctx.db, dir);

    const [bot] = await ctx.db.sql<{ id: string }[]>`
      insert into bots (name, model_provider, model_id) values ('b', 'p', 'm') returning id`;
    const [run] = await ctx.db.sql<{ id: string }[]>`
      insert into runs (bot_id, origin, objective) values (${bot?.id as string}, 'user', 'o') returning id`;
    await ctx.db.sql`
      insert into approvals (id, run_id, bot_id, call_id, tool, args, level, summary, source)
      values (gen_random_uuid(), ${run?.id as string}, ${bot?.id as string}, 'c1', 'send', '{}'::jsonb, 'external_irreversible', 's', 'default')`;
    await ctx.db.sql`insert into approval_rules (tool, effect) values ('shell', 'allow')`;

    expect(await migrate(ctx.db)).toEqual(held);

    const [card] = await ctx.db.sql<
      { review_reason: string | null; written_rule_id: string | null; source: string }[]
    >`select review_reason, written_rule_id, source from approvals`;
    expect(card).toEqual({ review_reason: null, written_rule_id: null, source: "default" });
    expect((await ctx.db.sql`select 1 from approval_rules`).length).toBe(1);
    expect(await getApprovalMode(ctx.db)).toBe("auto_review");
    expect(await listWrittenRules(ctx.db)).toEqual([]);
    expect(await migrate(ctx.db)).toEqual([]);
  });
});
