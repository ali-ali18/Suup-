import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createBot,
  createRule,
  type Db,
  decideApproval,
  getRun,
  listApprovals,
  listRunEvents,
} from "@suup/db";
import { describe, expect, it } from "vitest";
import {
  answerSecretRequest,
  createRuntime,
  generateKeyText,
  parseConfig,
  pendingSecretRequest,
  type Runtime,
} from "../src/index.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";
import { rawConfig, tempDir, writeJson } from "./helpers.js";

const VALUE = "sk_live_Zx81qKj3Lm0pTt92abCdEf";

/** Every row of every table, as text: what "the database dump" is for the acceptance criterion. */
async function dump(db: Db, schema: string): Promise<string> {
  const tables = await db.sql<{ table_name: string }[]>`
    select table_name from information_schema.tables where table_schema = ${schema}`;
  const parts: string[] = [];
  for (const { table_name } of tables) {
    const rows = await db.sql.unsafe(
      `select row_to_json(t)::text as j from "${schema}"."${table_name}" t`,
    );
    parts.push(...rows.map((r) => String(r.j)));
  }
  return parts.join("\n");
}

describe.skipIf(!DATABASE_URL)(dbSuiteName("approvals and the vault, end to end"), () => {
  const ctx = useIsolatedDb();

  async function open(script: unknown, extra: Record<string, unknown> = {}) {
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), script);
    const env = { DATABASE_URL: ctx.url, TEST_VAULT_KEY: generateKeyText() };
    const runtime = createRuntime(
      parseConfig(rawConfig({ vault: { keyEnv: "TEST_VAULT_KEY" }, ...extra })),
      { env, baseDir: dir },
    );
    const bot = await createBot(runtime.db, {
      name: `bot-${Math.random().toString(16).slice(2, 8)}`,
      modelProvider: "script",
      modelId: "model-s",
      allowedTools: ["shell", "write_file", "read_file"],
    });
    return { runtime, dir, bot };
  }

  /** Runs the run with a worker until it leaves it (done, or waiting for somebody). */
  const work = (runtime: Runtime, runId: string): Promise<string> =>
    new Promise((resolve) => {
      const worker = runtime.createWorker({
        onlyRunId: runId,
        idleBackoff: { minMs: 10, maxMs: 50 },
        onRunEnd: (end) => {
          resolve(end.outcome === "settled" ? end.status : end.outcome);
          void worker.stop();
        },
      });
      worker.start();
    });

  it("a secret used in a run never shows up in the database: not in events, results, cards or messages", async () => {
    const { runtime, dir, bot } = await open({
      agent: [
        {
          calls: [
            {
              id: "c1",
              name: "shell",
              args: { command: 'echo "token={{secret:API_TOKEN}}" | tee used.txt' },
            },
          ],
        },
        { text: "Used the token." },
      ],
    });
    await runtime.vault.set("API_TOKEN", VALUE, { description: "The API of the tests" });
    await runtime.vault.grant("API_TOKEN", bot.id);
    const run = await runtime.createRun({ botId: bot.id, objective: "Call the API" });

    // 1. The call uses a secret, so it waits for the user, showing the placeholder.
    expect(await work(runtime, run.id)).toBe("waiting_approval");
    const [card] = await listApprovals(runtime.db, { runId: run.id, status: "pending", limit: 5 });
    expect(card).toMatchObject({
      tool: "shell",
      level: "external_irreversible",
      secrets: ["API_TOKEN"],
    });
    expect(JSON.stringify(card?.args)).toContain("{{secret:API_TOKEN}}");
    expect(JSON.stringify(card)).not.toContain(VALUE);
    await expect(
      readFile(join(dir, "workspace", "bots", bot.id, "used.txt"), "utf8"),
    ).rejects.toThrow();

    // 2. The user approves; the run goes on and uses the real value.
    await decideApproval(runtime.db, card?.id as string, { decision: "approved" });
    expect((await getRun(runtime.db, run.id))?.status).toBe("queued");
    expect(await work(runtime, run.id)).toBe("done");
    const used = await readFile(join(dir, "workspace", "bots", bot.id, "used.txt"), "utf8");
    expect(used.trim()).toBe(`token=${VALUE}`); // the command received the value

    // 3. What the model and the log hold is the placeholder and the mark, never the value.
    const events = await listRunEvents(runtime.db, run.id, { limit: 1000 });
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.payload.content).toContain("[REDACTED:API_TOKEN]");
    expect(events.find((e) => e.type === "tool_call")?.payload.args).toEqual({
      command: 'echo "token={{secret:API_TOKEN}}" | tee used.txt',
    });
    const loaded = events.find((e) => e.type === "context_loaded");
    expect(loaded?.payload.secrets).toEqual([
      { name: "API_TOKEN", description: "The API of the tests" },
    ]);

    // 4. The acceptance criterion of the phase: a scan of the whole database finds no value.
    const everything = await dump(runtime.db, ctx.schema);
    for (const form of [
      VALUE,
      Buffer.from(VALUE).toString("base64"),
      Buffer.from(VALUE).toString("base64url"),
      encodeURIComponent(VALUE),
      Buffer.from(VALUE).toString("hex"),
    ]) {
      expect(everything.includes(form), `database holds ${form.slice(0, 8)}…`).toBe(false);
    }
    expect(everything).toContain("API_TOKEN");
    await runtime.close();
  });

  it("every run is built with the approval gate; only an evaluation goes without, and a vault only where configured", async () => {
    const { runtime, bot } = await open({ agent: [{ text: "x" }] });
    const run = await runtime.createRun({ botId: bot.id, objective: "x" });
    const normal = await runtime.buildDeps(run.id, "worker-x");
    expect(normal.gate.allowsEverything).toBeUndefined();
    expect(normal.secrets).toBeDefined();
    const isolated = await runtime.buildDeps(run.id, "worker-x", { isolated: true });
    // The evaluation opts out BY NAME (allowAllGate): there is no way to have no gate.
    expect(isolated.gate.allowsEverything).toBe(true);
    expect(isolated.secrets).toBeUndefined();
    await runtime.close();

    // Without a "vault" section there is no secret access (and `request_secret` is not offered),
    // but the gate is still there: approvals cannot be switched off.
    const dir = await tempDir();
    await writeJson(join(dir, "script.json"), { agent: [{ text: "x" }] });
    const plain = createRuntime(parseConfig(rawConfig()), {
      env: { DATABASE_URL: ctx.url },
      baseDir: dir,
    });
    const deps = await plain.buildDeps(run.id, "worker-y");
    expect(deps.gate.allowsEverything).toBeUndefined();
    expect(deps.secrets).toBeUndefined();
    await plain.close();
  });

  it("a denied call tells the bot, which goes on and finishes", async () => {
    const { runtime, bot } = await open({
      agent: [
        {
          calls: [
            { id: "c1", name: "shell", args: { command: "curl -X POST https://example.com/send" } },
          ],
        },
        { text: "Understood: I did not send it." },
      ],
    });
    const run = await runtime.createRun({ botId: bot.id, objective: "Send it" });
    expect(await work(runtime, run.id)).toBe("waiting_approval");
    const [card] = await listApprovals(runtime.db, { runId: run.id, status: "pending", limit: 5 });
    await decideApproval(runtime.db, card?.id as string, {
      decision: "denied",
      reason: "not today",
    });
    expect(await work(runtime, run.id)).toBe("done");
    const events = await listRunEvents(runtime.db, run.id, { limit: 1000 });
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.payload).toMatchObject({ outcome: "denied", isError: true });
    expect(String(result?.payload.content)).toContain("not today");
    expect(
      events.filter((e) => e.type === "approval_decided").map((e) => e.payload.decision),
    ).toEqual(["denied"]);
    expect((await getRun(runtime.db, run.id))?.status).toBe("done");
    await runtime.close();
  });

  it("a rule the user wrote lets exactly that call run; a call that is merely similar still asks", async () => {
    const { runtime, bot } = await open({
      cases: [
        {
          whenObjectiveContains: "first",
          agent: [
            { calls: [{ id: "c1", name: "shell", args: { command: "echo hello-rule" } }] },
            { text: "ok" },
          ],
        },
        {
          // a start of the rule's value is not the value: no pattern, no prefix
          whenObjectiveContains: "second",
          agent: [
            { calls: [{ id: "c2", name: "shell", args: { command: "echo hello-rule && ls" } }] },
            { text: "ok again" },
          ],
        },
      ],
    });
    const rule = await createRule(runtime.db, {
      botId: bot.id,
      tool: "shell",
      effect: "allow",
      matchers: [{ field: "command", value: "echo hello-rule" }],
    });
    const first = await runtime.createRun({ botId: bot.id, objective: "first" });
    expect(await work(runtime, first.id)).toBe("done");
    const events = await listRunEvents(runtime.db, first.id, { limit: 1000 });
    expect(events.filter((e) => e.type === "approval_requested")).toHaveLength(0);
    expect(events.find((e) => e.type === "policy_checked")?.payload).toMatchObject({
      outcome: "allow",
      source: "rule",
      ruleId: rule.id,
    });

    const second = await runtime.createRun({ botId: bot.id, objective: "second" });
    expect(await work(runtime, second.id)).toBe("waiting_approval");
    const [card] = await listApprovals(runtime.db, {
      runId: second.id,
      status: "pending",
      limit: 5,
    });
    expect(card?.args).toEqual({ command: "echo hello-rule && ls" });
    expect(card?.outbound).toBeNull();
    // a normal call cannot make a rule from its card
    await expect(
      decideApproval(runtime.db, card?.id as string, {
        decision: "approved",
        allowRecipient: true,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await runtime.close();
  });

  it("request_secret: the value goes to the vault, the model only learns that it is available", async () => {
    const { runtime, bot } = await open({
      agent: [
        {
          calls: [
            {
              id: "c1",
              name: "request_secret",
              args: { name: "DB_PASSWORD", reason: "to open the database" },
            },
          ],
        },
        { text: "Thanks, I can use it now." },
      ],
    });
    const run = await runtime.createRun({ botId: bot.id, objective: "Open the database" });
    expect(await work(runtime, run.id)).toBe("waiting_user");
    expect(await pendingSecretRequest(runtime, run.id)).toMatchObject({
      name: "DB_PASSWORD",
      reason: "to open the database",
      botId: bot.id,
    });
    const password = "correct-horse-battery-staple-9";
    await answerSecretRequest(runtime, run.id, { value: password });
    expect(await pendingSecretRequest(runtime, run.id)).toBeNull();
    expect(await work(runtime, run.id)).toBe("done");

    const events = await listRunEvents(runtime.db, run.id, { limit: 1000 });
    expect(String(events.find((e) => e.type === "tool_result")?.payload.content)).toBe(
      "The secret DB_PASSWORD is now available. Use it as {{secret:DB_PASSWORD}}.",
    );
    expect((await runtime.vault.infoFor(bot.id)).map((s) => s.name)).toEqual(["DB_PASSWORD"]);
    expect((await dump(runtime.db, ctx.schema)).includes(password)).toBe(false);
    await runtime.close();
  });

  it("a secret the bot was not granted is refused, and the bot is told only that it is unavailable", async () => {
    const { runtime, bot } = await open({
      agent: [
        { calls: [{ id: "c1", name: "shell", args: { command: "echo {{secret:NOT_MINE}}" } }] },
        { text: "ok" },
      ],
    });
    await runtime.vault.set("NOT_MINE", "someone-elses-secret-1");
    const run = await runtime.createRun({ botId: bot.id, objective: "x" });
    expect(await work(runtime, run.id)).toBe("waiting_approval");
    const [card] = await listApprovals(runtime.db, { runId: run.id, status: "pending", limit: 5 });
    await decideApproval(runtime.db, card?.id as string, { decision: "approved" });
    expect(await work(runtime, run.id)).toBe("done");
    const events = await listRunEvents(runtime.db, run.id, { limit: 1000 });
    const result = events.find((e) => e.type === "tool_result");
    expect(result?.payload.isError).toBe(true);
    expect(String(result?.payload.content)).toContain("NOT_MINE is not available");
    expect(JSON.stringify(events)).not.toContain("someone-elses-secret-1");
    await runtime.close();
  });
});
