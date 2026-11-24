import { describe, expect, it } from "vitest";
import { getWebSearchUsage, recordWebSearchUsage } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("web search usage (migration 0030)"), () => {
  const ctx = useIsolatedDb();

  it("counts the searches each engine answered, per month, and nothing else", async () => {
    await recordWebSearchUsage(ctx.db, "tavily", "2026-11");
    await recordWebSearchUsage(ctx.db, "tavily", "2026-11");
    await recordWebSearchUsage(ctx.db, "brave", "2026-11");
    await recordWebSearchUsage(ctx.db, "tavily", "2026-12");
    expect(await getWebSearchUsage(ctx.db, "2026-11")).toEqual({ tavily: 2, brave: 1 });
    expect(await getWebSearchUsage(ctx.db, "2026-12")).toEqual({ tavily: 1 });
    expect(await getWebSearchUsage(ctx.db, "2027-01")).toEqual({});
  });

  it("holds no text of a search: the table has only the engine, the month and a count", async () => {
    const columns = await ctx.db.sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = ${ctx.schema} and table_name = 'web_search_usage'
      order by column_name`;
    expect(columns.map((c) => c.column_name)).toEqual(["engine", "month", "searches"]);
  });

  it("counts concurrent searches without losing one", async () => {
    await Promise.all(
      Array.from({ length: 20 }, () => recordWebSearchUsage(ctx.db, "brave", "2026-10")),
    );
    expect(await getWebSearchUsage(ctx.db, "2026-10")).toEqual({ brave: 20 });
  });
});
