import { FAILURE_ORIGINS, RUN_ORIGINS, runStatusSchema } from "@suup/core";
import { describeRunStoreContract } from "@suup/core/testing/store-contract";
import { describe, expect, it } from "vitest";
import { decideApproval, getRun, PgRunStore, postInbox } from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./helpers.js";
import { makeRun, uniqueWorkerId } from "./kit.js";

describe.skipIf(!DATABASE_URL)(dbSuiteName("PgRunStore"), () => {
  const ctx = useIsolatedDb();

  describeRunStoreContract("PgRunStore", async () => {
    const worker = uniqueWorkerId();
    const { db } = ctx;
    return {
      store: new PgRunStore(db, { workerId: worker }),
      createRun: async (input) =>
        (await makeRun(db, { ...input, status: "running", leasedTo: worker })).id,
      post: async (runId, item) => (await postInbox(db, runId, item)).id,
      statusOf: async (runId) => (await getRun(db, runId))?.status ?? "failed",
      outcome: async (runId) => {
        const run = await getRun(db, runId);
        return {
          ...(run?.failureOrigin == null
            ? {}
            : { failure: { origin: run.failureOrigin, detail: run.failureDetail ?? "" } }),
          ...(run?.result == null ? {} : { result: run.result as never }),
        };
      },
      takeLease: async (runId) => {
        await db.sql`update runs set locked_by = 'someone-else', locked_at = now() where id = ${runId}`;
      },
      leased: async (runId) => (await getRun(db, runId))?.lockedBy != null,
      decideApproval: async (_runId, approvalId, decision) => {
        await decideApproval(db, approvalId, decision);
      },
    };
  });

  describe("schema and core agree", () => {
    const checkDefinition = async (name: string): Promise<string> => {
      const [row] = await ctx.db.sql<{ def: string }[]>`
        select pg_get_constraintdef(c.oid) as def
        from pg_constraint c join pg_class t on t.oid = c.conrelid
        where c.conname = ${name} and t.relnamespace = ${ctx.schema}::regnamespace`;
      return row?.def ?? "";
    };

    it("the database accepts exactly the failure origins, statuses and origins core defines", async () => {
      const failure = await checkDefinition("runs_failure_origin_check");
      for (const origin of FAILURE_ORIGINS) expect(failure, origin).toContain(`'${origin}'`);
      expect((failure.match(/'[a-z_]+'::text/g) ?? []).length).toBe(FAILURE_ORIGINS.length);

      const status = await checkDefinition("runs_status_check");
      for (const s of runStatusSchema.options) expect(status, s).toContain(`'${s}'`);
      expect((status.match(/'[a-z_]+'::text/g) ?? []).length).toBe(runStatusSchema.options.length);

      const origin = await checkDefinition("runs_origin_check");
      for (const o of RUN_ORIGINS) expect(origin, o).toContain(`'${o}'`);
      expect((origin.match(/'[a-z_]+'::text/g) ?? []).length).toBe(RUN_ORIGINS.length);
    });

    it("a run can fail with origin model, and nothing else is let in", async () => {
      const run = await makeRun(ctx.db, { status: "running" });
      await ctx.db.sql`
        update runs set status = 'failed', failure_origin = 'model' where id = ${run.id}`;
      expect((await getRun(ctx.db, run.id))?.failureOrigin).toBe("model");
      const other = await makeRun(ctx.db, { status: "running" });
      await expect(
        ctx.db
          .sql`update runs set status = 'failed', failure_origin = 'gremlins' where id = ${other.id}`,
      ).rejects.toThrow(/runs_failure_origin_check/);
    });

    it("run_inbox only takes known kinds, with text exactly for messages", async () => {
      const run = await makeRun(ctx.db);
      const insert = (kind: string, text: string | null) =>
        ctx.db.sql`insert into run_inbox (run_id, kind, text) values (${run.id}, ${kind}, ${text})`;
      await insert("user_message", "hello");
      await insert("stop", null);
      await expect(insert("shout", "hello")).rejects.toThrow(/check/);
      await expect(insert("user_message", null)).rejects.toThrow(/run_inbox_text_iff_message/);
      await expect(insert("stop", "text")).rejects.toThrow(/run_inbox_text_iff_message/);
    });
  });
});
