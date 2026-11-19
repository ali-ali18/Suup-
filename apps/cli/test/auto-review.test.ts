import { describe, expect, it, vi } from "vitest";
import { DATABASE_URL, dbSuiteName, type Result, useProject } from "./harness.js";

// Auto-review through the real `main`: the mode, the rules the user writes, and a run whose model
// reviewer (scripted) lets a call run or refuses it by a written rule.

vi.setConfig({ testTimeout: 30_000 });

const NEVER_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const review = (decision: string, ruleId: string | null, reason: string) => ({
  calls: [{ name: "review_call", args: { decision, ruleId, reason } }],
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("suup approvals mode and written rules"), () => {
  const p = useProject();
  type Json = Record<string, unknown>;
  const json = async (argv: string[]) => {
    const r = await p.suup([...argv, "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };
  const idOf = (r: Result): string => {
    const id = /Execução ([0-9a-f-]{36}) criada/.exec(r.stdout)?.[1];
    if (id === undefined) throw new Error(`no run id:\n${r.stdout}`);
    return id;
  };
  const eventsOf = (runId: string) =>
    p.db.sql<{ seq: number; type: string; payload: Json }[]>`
      select seq, type, payload from run_events where run_id = ${runId} order by seq`;

  it("setup: migrate, a bot that may use shell, scripts", async () => {
    await p.config({
      reviewer: undefined,
      approvals: { levels: { shell: "write_reversible" }, autoReview: { model: "model-x" } },
    });
    await p.suup(["db", "migrate"]);
    await p.script("roteiro.json", {
      cases: [
        {
          whenObjectiveContains: "CASE-RUN",
          agent: [{ calls: [{ name: "shell", args: { command: "echo rodou" } }] }, { text: "Ok." }],
          autoReview: [review("run", null, "Dentro do pedido.")],
        },
        {
          whenObjectiveContains: "CASE-BLOCK",
          agent: [{ calls: [{ name: "shell", args: { command: "echo nao" } }] }, { text: "Ok." }],
          autoReview: [review("block", NEVER_ID, "A regra proíbe.")],
        },
      ],
    });
    await p.script("outro.json", { agent: [] });
    for (const name of ["corre", "bloqueia"]) {
      const r = await p.suup([
        "bot",
        "create",
        "--name",
        name,
        "--model",
        "model-x",
        "--tools",
        "shell",
      ]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
    }
  });

  it("approvals mode: shows Auto-review, changes it, refuses a mode that does not exist", async () => {
    expect(await json(["approvals", "mode"])).toEqual({
      mode: "auto_review",
      reviewer: { available: true, model: "model-x", reason: null },
    });
    const shown = await p.suup(["approvals", "mode"]);
    expect(shown.stdout).toContain("Auto-review");
    expect(shown.stdout).toContain("Revisor: model-x");

    expect(((await json(["approvals", "mode", "ask-all"])) as Json).mode).toBe("ask_all");
    expect((await p.suup(["approvals", "mode"])).stdout).toContain("Perguntar tudo");
    expect(((await json(["approvals", "mode"])) as Json).mode).toBe("ask_all");

    const bad = await p.suup(["approvals", "mode", "tudo"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("auto-review ou ask-all");
    expect(((await json(["approvals", "mode"])) as Json).mode).toBe("ask_all");

    await json(["approvals", "mode", "auto-review"]);
  });

  it("approvals stale: shows 60 minutes, changes it, refuses what is not a whole number from 5 to 10080", async () => {
    expect(await json(["approvals", "stale"])).toEqual({ staleAfterMinutes: 60 });
    expect((await p.suup(["approvals", "stale"])).stdout).toContain("mais de 60 minutos");
    expect(await json(["approvals", "stale", "360"])).toEqual({ staleAfterMinutes: 360 });
    expect(await json(["approvals", "stale"])).toEqual({ staleAfterMinutes: 360 });
    for (const bad of ["4", "10081", "1.5", "uma hora"]) {
      const r = await p.suup(["approvals", "stale", bad]);
      expect(r.code, bad).toBe(2);
      expect(r.stderr).toContain("de 5 a 10080");
    }
    expect(await json(["approvals", "stale"])).toEqual({ staleAfterMinutes: 360 });
    await json(["approvals", "stale", "60"]);
  });

  it("approvals mode: says so when there is no reviewer model", async () => {
    await p.config({ reviewer: undefined, approvals: { levels: { shell: "write_reversible" } } });
    const r = await p.suup(["approvals", "mode"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("o revisor não está disponível");
    expect(r.stdout).toContain("Nenhum modelo de revisão");
    expect(
      ((await json(["approvals", "mode"])) as { reviewer: { available: boolean } }).reviewer,
    ).toMatchObject({ available: false, model: null });
    await p.config({
      reviewer: undefined,
      approvals: { levels: { shell: "write_reversible" }, autoReview: { model: "model-x" } },
    });
  });

  it("rules written: add, list, edit, switch off, remove; the text is bounded", async () => {
    const added = (await json([
      "rules",
      "written",
      "add",
      "--kind",
      "allow",
      "--text",
      "  E-mails para minha equipe em acme.com ",
    ])) as Json;
    expect(added).toMatchObject({
      kind: "allow",
      text: "E-mails para minha equipe em acme.com",
      botId: null,
      enabled: true,
    });
    const id = String(added.id);

    const listed = await p.suup(["rules", "written", "list"]);
    expect(listed.stdout).toContain(id.slice(0, 8));
    expect(listed.stdout).toContain("permitir");
    expect(listed.stdout).toContain("E-mails para minha equipe em acme.com");

    const edited = (await json([
      "rules",
      "written",
      "edit",
      id.slice(0, 8),
      "--kind",
      "never",
      "--text",
      "Apagar a pasta notas",
      "--disable",
    ])) as Json;
    expect(edited).toMatchObject({ kind: "never", text: "Apagar a pasta notas", enabled: false });
    expect((await p.suup(["rules", "written", "list"])).stdout).toContain("(desativada)");

    const forBot = await p.suup([
      "rules",
      "written",
      "add",
      "--kind",
      "ask",
      "--text",
      "gastar dinheiro",
      "--bot",
      "corre",
    ]);
    expect(forBot.code, forBot.stderr).toBe(0);
    const names = (await json(["rules", "written", "list", "--bot", "bloqueia"])) as Json[];
    expect(names.map((r) => r.id)).toEqual([id]);

    for (const argv of [
      ["rules", "written", "add", "--kind", "allow", "--text", "   "],
      ["rules", "written", "add", "--kind", "allow", "--text", "x".repeat(501)],
    ]) {
      const r = await p.suup(argv);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("entre 1 e 500 caracteres");
    }
    expect(
      (await p.suup(["rules", "written", "add", "--kind", "talvez", "--text", "a"])).code,
    ).toBe(2);
    expect((await p.suup(["rules", "written", "add", "--text", "a"])).code).toBe(2);
    expect((await p.suup(["rules", "written", "edit", id.slice(0, 8)])).code).toBe(2);

    expect((await p.suup(["rules", "written", "rm", id.slice(0, 8)])).code).toBe(0);
    expect((await p.suup(["rules", "written", "rm", id.slice(0, 8)])).code).toBe(1);
    // the exact rules are a different list
    expect(((await json(["rules", "list"])) as Json[]).length).toBe(0);
    await p.db.sql`delete from written_rules`;
  });

  it("a run: the reviewer lets a call run, and the run shows the review", async () => {
    const r = await p.suup(["run", "CASE-RUN faça", "--bot", "corre"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const runId = idOf(r);
    const events = await eventsOf(runId);
    expect(events.find((e) => e.type === "approval_review")?.payload).toMatchObject({
      decision: "run",
      outcome: "allow",
      model: "model-x",
    });
    const inspected = await p.suup(["inspect", runId]);
    expect(inspected.stdout).toContain("approval_review");
  });

  it("a run: a block by a rule the user wrote refuses the call and is shown as such", async () => {
    await p.db.sql`
      insert into written_rules (id, kind, text) values (${NEVER_ID}, 'never', 'rodar echo nao')`;
    const r = await p.suup(["run", "CASE-BLOCK faça", "--bot", "bloqueia"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const runId = idOf(r);
    expect(r.stdout).toContain('Bloqueado pela regra "rodar echo nao"');
    const events = await eventsOf(runId);
    expect(events.find((e) => e.type === "policy_checked")?.payload).toMatchObject({
      outcome: "deny",
      writtenRuleId: NEVER_ID,
    });
    expect(events.some((e) => e.type === "approval_requested")).toBe(false);
    const cards = (await json(["approvals", "--all"])) as Json[];
    expect(cards).toEqual([]);
  });
});
