import { describe, expect, it, vi } from "vitest";
import { DATABASE_URL, dbSuiteName, useProject } from "./harness.js";

// The memory through the real `main`: the settings, what waits for the user, the history and the undo.

vi.setConfig({ testTimeout: 30_000 });

describe.skipIf(!DATABASE_URL)(dbSuiteName("suup memory: settings, pending, history, undo"), () => {
  const p = useProject();
  type Json = Record<string, unknown>;
  const json = async (argv: string[]) => {
    const r = await p.suup([...argv, "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  it("setup", async () => {
    await p.config({ reviewer: undefined, memory: { consolidation: { model: "model-x" } } });
    expect((await p.suup(["db", "migrate"])).code).toBe(0);
    await p.script("roteiro.json", { agent: [] });
    await p.script("outro.json", { agent: [] });
    expect((await p.suup(["bot", "create", "--name", "ajudante", "--model", "model-x"])).code).toBe(
      0,
    );
  });

  it("settings: shows the defaults, changes only what is asked, never, and refuses the wrong values in Portuguese", async () => {
    const shown = (await json(["memory", "settings"])) as Json;
    expect(shown).toMatchObject({
      consolidation: { enabled: true, idleMinutes: 5, maxTurns: 15 },
      promptLimitItems: 200,
      expiryDays: 90,
      compactionThreshold: 0.8,
      reviewer: { available: true, model: "model-x" },
    });
    const changed = (await json([
      "memory",
      "settings",
      "--max-turns",
      "20",
      "--expiry-days",
      "never",
      "--consolidation",
      "off",
      "--compaction-threshold",
      "0.9",
    ])) as Json;
    expect(changed).toMatchObject({
      consolidation: { enabled: false, idleMinutes: 5, maxTurns: 20 },
      expiryDays: null,
      compactionThreshold: 0.9,
    });
    const text = await p.suup(["memory", "settings"]);
    expect(text.stdout).toContain("desligada");
    expect(text.stdout).toContain("nunca");
    expect(text.stdout).toContain("90%");
    for (const [args, mention] of [
      [["--max-turns", "2"], "consolidation.maxTurns: deve ser um número inteiro entre 3 e 100"],
      [["--idle-minutes", "abc"], "deve ser um número"],
      [["--expiry-days", "3"], "entre 7 e 3650"],
      [["--compaction-threshold", "0.2"], "entre 0.5 e 0.95"],
      [["--consolidation", "talvez"], "on ou off"],
      [["--prompt-limit", "10"], "entre 20 e 1000"],
    ] as const) {
      const r = await p.suup(["memory", "settings", ...args]);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr, args.join(" ")).toContain(mention);
    }
    expect((await json(["memory", "settings"])) as Json).toMatchObject({
      consolidation: { maxTurns: 20 },
    });
    await p.suup([
      "memory",
      "settings",
      "--max-turns",
      "15",
      "--expiry-days",
      "90",
      "--consolidation",
      "on",
      "--compaction-threshold",
      "0.8",
    ]);
  });

  it("warns when the rules and profile pass the limit, and says nothing was lost", async () => {
    for (let i = 10; i < 31; i++) {
      await p.suup(["memory", "add", "rule", `Regra de limite ${i}`, "--bot", "ajudante"]);
    }
    const r = await p.suup(["memory", "settings", "--prompt-limit", "20"]);
    expect(r.stdout).toContain("Aviso: regras e perfil ativos passam do limite (20 memórias");
    expect(r.stdout).toContain("ajudante (21 memórias");
    const doctor = await p.suup(["doctor", "--json"]);
    expect(doctor.stdout).toContain("Limite do prompt");
    await p.suup(["memory", "settings", "--prompt-limit", "200"]);
  });

  it("pending: lists what waits, confirms one (with undo), refuses another", async () => {
    const { db } = p;
    const [bot] = await db.sql<{ id: string }[]>`select id from bots limit 1`;
    const add = async (layer: string, text: string) => {
      const [row] = await db.sql<{ id: string }[]>`
        insert into memories (layer, scope, bot_id, text, created_by, status)
        values (${layer}, ${layer === "profile" ? "shared" : "bot"}, ${layer === "profile" ? null : (bot?.id as string)}, ${text}, 'bot', 'pending')
        returning id`;
      return row?.id as string;
    };
    const a = await add("profile", "O usuário mora em Olinda.");
    const b = await add("rule", "Responda com rimas.");
    const list = (await json(["memory", "pending"])) as Json[];
    expect(list.map((m) => m.text)).toEqual(["O usuário mora em Olinda.", "Responda com rimas."]);
    expect((await p.suup(["memory", "pending"])).stdout).toContain("suup memory confirm");
    // not in the normal list
    expect(((await json(["memory", "list"])) as Json[]).map((m) => m.id)).not.toContain(a);

    const ok = await p.suup(["memory", "confirm", a.slice(0, 8)]);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect(ok.stdout).toContain("Confirmada (perfil)");
    expect(((await json(["memory", "list"])) as Json[]).map((m) => m.id)).toContain(a);
    const again = await p.suup(["memory", "confirm", a.slice(0, 8)]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("não está esperando confirmação");
    const no = await p.suup(["memory", "reject", b.slice(0, 8)]);
    expect(no.stdout).toContain("Recusada");
    expect(await json(["memory", "pending"])).toEqual([]);

    // history and undo
    const history = (await json(["memory", "history", a.slice(0, 8)])) as Json[];
    expect(history.map((h) => [h.kind, h.actor])).toEqual([["confirmed", "user"]]);
    const text = await p.suup(["memory", "history", a.slice(0, 8)]);
    expect(text.stdout).toContain("confirmada");
    const undone = await p.suup(["memory", "undo", a.slice(0, 8)]);
    expect(undone.code, undone.stdout + undone.stderr).toBe(0);
    expect(undone.stdout).toContain("Desfeito (confirmada)");
    expect(((await json(["memory", "pending"])) as Json[]).map((m) => m.id)).toEqual([a]);
    const none = await p.suup(["memory", "undo", "ffffffff"]);
    expect(none.code).toBe(1);
  });

  it("consolidations: says there is none yet", async () => {
    expect((await p.suup(["memory", "consolidations"])).stdout).toContain("Nenhuma consolidação");
  });
});
