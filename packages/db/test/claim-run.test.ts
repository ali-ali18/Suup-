import { describe, expect, it } from "vitest";
import {
  claimRun,
  createDb,
  getRun,
  migrate,
  migrationStatus,
  PgRunQueue,
  releaseLeasedRun,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { makeRun } from "./kit.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("claiming one given run"), () => {
  const ctx = useIsolatedDb();

  it("takes only the run asked for, only when queued, and leases it", async () => {
    const older = await makeRun(ctx.db);
    const target = await makeRun(ctx.db);

    const claimed = await claimRun(ctx.db, target.id, "w1");
    expect(claimed?.id).toBe(target.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.lockedBy).toBe("w1");
    expect((await getRun(ctx.db, older.id))?.status).toBe("queued");

    expect(await claimRun(ctx.db, target.id, "w2")).toBeNull(); // already running
    expect(await claimRun(ctx.db, "00000000-0000-0000-0000-000000000000", "w2")).toBeNull();

    await releaseLeasedRun(ctx.db, target.id, "w1");
    expect((await claimRun(ctx.db, target.id, "w2"))?.lockedBy).toBe("w2");
  });

  it("PgRunQueue with onlyRunId never hands out another run", async () => {
    const other = await makeRun(ctx.db);
    const mine = await makeRun(ctx.db);
    const queue = new PgRunQueue(ctx.db, { onlyRunId: mine.id });
    expect(await queue.claimNext("w1")).toEqual({ runId: mine.id });
    expect(await queue.claimNext("w1")).toBeNull();
    expect((await getRun(ctx.db, other.id))?.status).toBe("queued");
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("migrationStatus"), () => {
  const ctx = useIsolatedDb({ migrate: false });

  it("reports everything pending on an empty schema, then everything applied", async () => {
    const before = await migrationStatus(ctx.db);
    expect(before.applied).toEqual([]);
    expect(before.pending.length).toBeGreaterThan(0);

    await migrate(ctx.db);
    const after = await migrationStatus(ctx.db);
    expect(after.pending).toEqual([]);
    expect(after.applied).toEqual(before.pending);
    expect(after.unknown).toEqual([]);

    await ctx.db
      .sql`insert into schema_migrations (name, checksum) values ('9999_from_the_future.sql', 'x')`;
    expect((await migrationStatus(ctx.db)).unknown).toEqual(["9999_from_the_future.sql"]);
  });

  it("is usable through a second handle on the same schema", async () => {
    const url = DATABASE_URL as string;
    const other = createDb(url, { schema: ctx.schema });
    try {
      expect((await migrationStatus(other)).applied.length).toBeGreaterThan(0);
    } finally {
      await other.close();
    }
  });
});
