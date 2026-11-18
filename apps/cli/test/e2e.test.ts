import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, type Project, type Result, useProject } from "./harness.js";

// End to end through the real entry point (`main`): the real Postgres (one schema for this file),
// the real runtime and worker, the `scripted` provider and the `local` sandbox in a temp dir.

const RUN_ID = /Execução ([0-9a-f-]{36}) criada/;

const idOf = (r: Result): string => {
  const id = RUN_ID.exec(r.stdout)?.[1];
  if (id === undefined) throw new Error(`no run id in the output:\n${r.stdout}`);
  return id;
};

async function show(p: Project, id: string) {
  const r = await p.suup(["show", id, "--json"]);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as {
    id: string;
    botId: string;
    status: string;
    turns: number;
    failure: { origin: string; detail: string } | null;
    result: { summary: string } | null;
    plan: { status: string }[];
    question: string | null;
  };
}

async function events(p: Project, id: string, extra: string[] = []) {
  const r = await p.suup(["inspect", id, "--json", ...extra]);
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout) as { seq: number; type: string; payload: Record<string, unknown> }[];
}

const planOf = (statuses: [string, string]) => ({
  name: "plan",
  args: {
    steps: [
      { id: "s1", title: "Criar o arquivo", status: statuses[0] },
      { id: "s2", title: "Conferir o conteúdo", status: statuses[1] },
    ],
  },
});

/** plan -> write_file -> plan + shell(cat) -> plan -> finish, then the reviewer approves. */
const HAPPY_SCRIPT = {
  agent: [
    { text: "Vou planejar.", calls: [planOf(["in_progress", "pending"])] },
    {
      text: "Criando o arquivo.",
      calls: [{ name: "write_file", args: { path: "ola.txt", content: "Olá, mundo!\n" } }],
    },
    {
      calls: [planOf(["done", "in_progress"]), { name: "shell", args: { command: "cat ola.txt" } }],
    },
    { calls: [planOf(["done", "done"])] },
    {
      text: "Conferido.",
      calls: [
        {
          name: "finish",
          args: {
            summary: "Criei ola.txt e conferi o conteúdo.",
            evidence: [{ criterion: "1", evidence: "cat ola.txt imprimiu: Olá, mundo!" }],
          },
        },
      ],
    },
  ],
  review: [
    {
      calls: [{ name: "verdict", args: { verdict: "approve", notes: "A saída do cat confirma." } }],
    },
  ],
};

describe.skipIf(!DATABASE_URL)(dbSuiteName("suup, end to end"), () => {
  const p = useProject();
  let botId = "";
  let happyRun = "";

  it("doctor reports a database without migrations, then db migrate fixes it", async () => {
    const before = await p.suup(["doctor"]);
    expect(before.code).toBe(1);
    expect(before.stdout).toMatch(
      /\[falha\] Banco de dados\s+acessível, mas com \d+ migrações pendentes/,
    );
    expect(before.stdout).toContain("suup db migrate");

    const migrated = await p.suup(["db", "migrate"]);
    expect(migrated.code).toBe(0);
    expect(migrated.stdout).toMatch(/\d+ migrações aplicadas/);
    expect(migrated.stdout).toContain("0001_init.sql");

    const again = await p.suup(["db", "migrate"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("já está atualizado");

    const json = await p.suup(["db", "migrate", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({ applied: [] });
  });

  it("doctor with a missing API-key variable fails that provider and says which variable", async () => {
    await p.script("roteiro.json", HAPPY_SCRIPT);
    await p.script("outro.json", { agent: [] });
    const r = await p.suup(["doctor"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/\[ok\]\s+Configuração\s+válida/);
    expect(r.stdout).toMatch(/\[ok\]\s+Banco de dados\s+acessível, \d+ migrações aplicadas/);
    expect(r.stdout).toMatch(/\[ok\]\s+Sandbox\s+LOCAL .*SEM isolamento/);
    expect(r.stdout).toMatch(/\[ok\]\s+Provedor roteiro\s+scripted/);
    expect(r.stdout).toMatch(
      /\[falha\] Provedor nuvem\s+anthropic: a variável de ambiente SUUP_TEST_MISSING_KEY não está definida/,
    );
    expect(r.stdout).toMatch(/\[ok\]\s+Ferramentas\s+7 registradas: shell/);
    expect(r.stdout).toContain("1 componente com falha");

    const json = await p.suup(["doctor", "--json"]);
    expect(json.code).toBe(1);
    const parsed = JSON.parse(json.stdout) as {
      ok: boolean;
      checks: { component: string; ok: boolean }[];
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.filter((c) => !c.ok).map((c) => c.component)).toEqual(["Provedor nuvem"]);

    // The same, once the variable is there: the provider is fine and everything passes.
    const fixed = await p.suup(["doctor"], { env: { SUUP_TEST_MISSING_KEY: "sk-test" } });
    expect(fixed.code).toBe(0);
    expect(fixed.stdout).toContain("Tudo certo.");
    expect(fixed.stdout).not.toContain("sk-test");
  });

  it("doctor --live makes no real call for scripted models and says why it skips a model without a key", async () => {
    const r = await p.suup(["doctor", "--live"]);
    expect(r.stdout).toMatch(/\[ok\]\s+Modelo model-x\s+provedor scripted: sem chamada real/);
    expect(r.stdout).toMatch(
      /\[falha\] Modelo model-k\s+sem chamada real: a variável de ambiente SUUP_TEST_MISSING_KEY/,
    );
  });

  it("bot create / list / show", async () => {
    const created = await p.suup([
      "bot",
      "create",
      "--name",
      "ajudante",
      "--model",
      "model-x",
      "--all-tools",
      "--personality",
      "Seja direto.",
      "--max-turns",
      "15",
    ]);
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("Bot criado: ajudante");
    expect(created.stdout).toContain("shell, read_file, write_file");
    const json = JSON.parse((await p.suup(["bot", "show", "ajudante", "--json"])).stdout);
    botId = json.id;
    expect(json).toMatchObject({
      name: "ajudante",
      modelId: "model-x",
      modelProvider: "roteiro",
      limits: { maxTurns: 15 },
    });

    const list = await p.suup(["bot", "list"]);
    expect(list.stdout).toContain("ajudante");
    expect(list.stdout).toContain("model-x");
    const detail = await p.suup(["bot", "show", botId.slice(0, 8)]);
    expect(detail.stdout).toContain("Personalidade:\n  Seja direto.");
    expect(detail.stdout).toContain("maxTurns=15");

    const unknownTool = await p.suup([
      "bot",
      "create",
      "--name",
      "x",
      "--model",
      "model-x",
      "--tools",
      "shell,teleport",
    ]);
    expect(unknownTool.code).toBe(2);
    expect(unknownTool.stderr).toContain("Ferramenta desconhecida: teleport");
    const unknownModel = await p.suup(["bot", "create", "--name", "x", "--model", "model-z"]);
    expect(unknownModel.code).toBe(1);
    expect(unknownModel.stderr).toContain('O modelo "model-z" não está em "models"');
    const missing = await p.suup(["bot", "show", "naoexiste"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("Bot não encontrado");
  });

  it("run: plan, write_file, shell, finish with a reviewer: the file exists and the run is done", async () => {
    const r = await p.suup([
      "run",
      "Crie o arquivo ola.txt com a frase Olá, mundo!",
      "--bot",
      "ajudante",
      "--criterion",
      "o arquivo ola.txt existe com a frase",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    happyRun = idOf(r);

    // What the user sees, live.
    expect(r.stderr).toContain("SEM isolamento");
    expect(r.stdout).toContain("Objetivo: Crie o arquivo ola.txt");
    expect(r.stdout).toContain("1. o arquivo ola.txt existe com a frase");
    expect(r.stdout).toContain("turno 1: consultando model-x");
    expect(r.stdout).toContain("| Vou planejar.");
    expect(r.stdout).toContain('→ write_file  path="ola.txt"');
    expect(r.stdout).toContain('→ shell  command="cat ola.txt"');
    expect(r.stdout).toContain("Olá, mundo!");
    expect(r.stdout).toContain("[x] Criar o arquivo");
    expect(r.stdout).toContain("revisor (model-x) conferindo");
    expect(r.stdout).toContain("Revisor aprovou: A saída do cat confirma.");
    expect(r.stdout).toContain("Conclusão aceita.");
    expect(r.stdout).toContain("concluída em");
    expect(r.stdout).toContain("Turnos: 5");
    expect(r.stdout).toMatch(/Custo: US\$ 0,0\d{3}/);

    // The effect on disk, and in the database.
    expect(await p.readBotFile(botId, "ola.txt")).toBe("Olá, mundo!\n");
    const shown = await show(p, happyRun);
    expect(shown).toMatchObject({ status: "done", turns: 5 });
    expect(shown.result?.summary).toBe("Criei ola.txt e conferi o conteúdo.");
    expect(shown.plan.map((s) => s.status)).toEqual(["done", "done"]);
  });

  it("show prints the plan, the result, usage and timings; inspect prints the raw timeline", async () => {
    const text = (await p.suup(["show", happyRun.slice(0, 8)])).stdout;
    expect(text).toContain("Situação: concluída (done)");
    expect(text).toContain("Bot: ajudante");
    expect(text).toContain("[x] Conferir o conteúdo");
    expect(text).toContain("Resultado:\n  Criei ola.txt e conferi o conteúdo.");
    expect(text).toContain("Uso: 5 turnos");
    expect(text).toContain("Tempos:");
    expect(text).toContain("versão servida: scripted-1");

    const timeline = (await p.suup(["inspect", happyRun])).stdout;
    expect(timeline).toContain("run_started");
    expect(timeline).toContain("model_request");
    expect(timeline).toContain("tool_call");
    expect(timeline).toContain('a2_2 shell command="cat ola.txt"');
    expect(timeline).toContain("status_changed");
    expect(timeline).toContain("running → done");

    const filtered = (await p.suup(["inspect", happyRun, "--type", "tool_call,tool_result"]))
      .stdout;
    expect(filtered).not.toContain("model_request");
    expect(filtered).toContain("write_file");

    const range = await events(p, happyRun, ["--from", "4", "--to", "6"]);
    expect(range.map((e) => e.seq)).toEqual([4, 5, 6]);

    const full = (await p.suup(["inspect", happyRun, "--type", "tool_result", "--full"])).stdout;
    expect(full).toContain('"outcome": "ok"');
    expect(full).toContain("Created ola.txt");
  });

  it("inspect --request shows exactly what the model saw on that turn", async () => {
    const requests = (await events(p, happyRun, ["--type", "model_request"])).filter(
      (e) => !e.payload.purpose,
    );
    expect(requests).toHaveLength(5);
    const third = requests[2];
    const r = await p.suup(["inspect", happyRun, "--request", String(third?.seq)]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("turno 3 do agente");
    expect(r.stdout).toContain("=== SISTEMA ===");
    expect(r.stdout).toContain("You are ajudante");
    expect(r.stdout).toContain("Seja direto.");
    expect(r.stdout).toContain("=== MENSAGENS (5) ===");
    expect(r.stdout).toContain("→ chamada write_file (id a1_1)");
    expect(r.stdout).toContain("← resultado da chamada a1_1");
    expect(r.stdout).toContain("Created ola.txt (13 bytes).");
    expect(r.stdout).toContain("[STATE REMINDER");
    expect(r.stdout).toContain("=== FERRAMENTAS (10) ===");
    expect(r.stdout).toContain("- shell:");
    expect(r.stdout).toContain("=== RESPOSTA GRAVADA");
    expect(r.stdout).toContain("chamada plan");

    const notRequest = await p.suup(["inspect", happyRun, "--request", "1"]);
    expect(notRequest.code).toBe(1);
    expect(notRequest.stderr).toContain('O evento 1 é "run_started", não um model_request');
    expect(notRequest.stderr).toContain(`seq ${requests[0]?.seq}`);
    const json = JSON.parse(
      (await p.suup(["inspect", happyRun, "--request", String(third?.seq), "--json"])).stdout,
    );
    expect(json.request.messages).toHaveLength(5);
    expect(json.response.stopReason).toBe("tool_calls");
  });

  it("replay of the finished run is identical", async () => {
    const r = await p.suup(["replay", happyRun]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Resultado: IDÊNTICO");
    expect(r.stdout).toContain("gravada concluída, reexecutada concluída");
    expect(r.stdout).toContain("O loop atual reproduz a execução");
    const json = JSON.parse((await p.suup(["replay", happyRun, "--json"])).stdout);
    expect(json).toMatchObject({ identical: true, firstDivergence: null, requestDiffs: [] });
  });

  it("replay reports a divergence when the harness would decide differently (exit 1)", async () => {
    // The bot's turn limit is lowered after the fact: the current code would stop the run at turn 2.
    await p.db.sql`update bots set limits = '{"maxTurns": 2}' where id = ${botId}`;
    try {
      const r = await p.suup(["replay", happyRun]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("Resultado: DIFERENTE");
      expect(r.stdout).toContain("Primeira divergência");
      expect(r.stdout).toContain("gravado:");
      expect(r.stdout).toContain("reexecutado:");
      expect(r.stdout).toMatch(/O comportamento do harness mudou no evento \d+/);
    } finally {
      await p.db.sql`update bots set limits = '{"maxTurns": 15}' where id = ${botId}`;
    }
  });

  it("resend --times 3 sends the recorded request again, without touching the run", async () => {
    const requests = (await events(p, happyRun, ["--type", "model_request"])).filter(
      (e) => !e.payload.purpose,
    );
    const seq = String(requests[2]?.seq);
    const before = (await events(p, happyRun)).length;

    const r = await p.suup(["resend", happyRun, "--seq", seq, "--times", "3"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("3 vezes para model-x");
    expect(r.stdout).toContain("Tentativa 1/3");
    expect(r.stdout).toContain("Tentativa 3/3");
    expect(r.stdout).toContain("versão do modelo: scripted-1");
    expect(r.stdout).toContain('chamada: shell {"command":"cat ola.txt"}');
    expect(r.stdout).toContain("Resumo: 3 tentativas, 1 desfecho distinto");
    expect(r.stdout).toContain("3× chamou plan + shell");
    expect(r.stdout).toContain("repetido em 3 de 3");
    expect(r.stdout).toContain("errou sempre");

    expect((await events(p, happyRun)).length).toBe(before);
    expect((await show(p, happyRun)).turns).toBe(5);

    const saved = /Resultados salvos em (.+\.json)/.exec(r.stdout)?.[1];
    expect(saved).toContain(join(p.dir, ".suup", "diagnostics"));
    const doc = JSON.parse(await readFile(saved as string, "utf8"));
    expect(doc).toMatchObject({ runId: happyRun, requestSeq: Number(seq), times: 3 });
    expect(doc.attempts).toHaveLength(3);
    expect(doc.summary.distinct).toHaveLength(1);
  });

  it("resend --model sends the same request to another configured model", async () => {
    // model-y's script gives another answer for the turn with two assistant messages before it.
    await p.script("outro.json", { agent: [{}, {}, { text: "Eu só responderia com texto." }] });
    const requests = (await events(p, happyRun, ["--type", "model_request"])).filter(
      (e) => !e.payload.purpose,
    );
    const r = await p.suup([
      "resend",
      happyRun,
      "--seq",
      String(requests[2]?.seq),
      "--times",
      "2",
      "--model",
      "model-y",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("2 vezes para model-y (o original usou model-x)");
    expect(r.stdout).toContain("2× respondeu só com texto");
    expect(r.stdout).toContain("Desfecho gravado na execução: chamou plan + shell");
    expect(r.stdout).toContain("repetido em 0 de 2");
    expect(r.stdout).toContain("Com model-y");

    const json = await p.suup([
      "resend",
      happyRun,
      "--seq",
      String(requests[2]?.seq),
      "--model",
      "model-y",
      "--json",
    ]);
    const lines = json.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "attempt", ok: true });
    expect(lines.at(-1)).toMatchObject({ type: "summary", attempts: 1 });
    await p.script("outro.json", { agent: [] });
  });

  it("resend refuses what it cannot send", async () => {
    const notRequest = await p.suup(["resend", happyRun, "--seq", "1"]);
    expect(notRequest.code).toBe(1);
    expect(notRequest.stderr).toContain("não um model_request");
    const nowhere = await p.suup(["resend", happyRun, "--seq", "9999"]);
    expect(nowhere.code).toBe(1);
    expect(nowhere.stderr).toContain("não tem o evento seq 9999");
    const unknownModel = await p.suup(["resend", happyRun, "--seq", "2", "--model", "model-z"]);
    expect(unknownModel.code).toBe(1);
    expect(unknownModel.stderr).toContain('O modelo "model-z" não está em "models"');
  });

  it("a run that escalates is answered through stdin (a terminal)", async () => {
    await p.script("roteiro.json", {
      agent: [
        { calls: [{ name: "escalate", args: { question: "Qual é o número da sorte?" } }] },
        { text: "O número da sorte é 42." },
      ],
    });
    const r = await p.suup(["run", "Descubra o número da sorte", "--bot", "ajudante"], {
      tty: true,
      during: async (h) => {
        await h.waitFor("Sua resposta> ");
        h.send("42");
      },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("? O bot precisa de você:");
    expect(r.stdout).toContain("Qual é o número da sorte?");
    expect(r.stdout).toContain("Sua resposta> ");
    expect(r.stdout).toContain("resposta recebida:");
    expect(r.stdout).toContain("42");
    expect(r.stdout).toContain("● retomada");
    expect(r.stdout).toContain("O número da sorte é 42.");
    const shown = await show(p, idOf(r));
    expect(shown.status).toBe("done");
    expect(shown.result?.summary).toBe("O número da sorte é 42.");
  });

  it("without a terminal, an escalation leaves the run waiting (exit 0) and says how to answer; say + resume finish it", async () => {
    await p.script("roteiro.json", {
      agent: [
        { calls: [{ name: "escalate", args: { question: "Qual cor?" } }] },
        { text: "Escolhi a cor que você disse." },
      ],
    });
    const r = await p.suup(["run", "Escolha uma cor", "--bot", "ajudante"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const id = idOf(r);
    expect(r.stdout).toContain("Qual cor?");
    expect(r.stdout).toContain("aguardando você");
    expect(r.stdout).toContain(`suup say ${id.slice(0, 8)} "<sua resposta>"`);
    expect(r.stdout).toContain("suup resume");
    expect(r.stdout).not.toContain("Sua resposta>");
    const waiting = await show(p, id);
    expect(waiting.status).toBe("waiting_user");
    expect(waiting.question).toBe("Qual cor?");

    // resume without an answer and without a terminal: still waiting, same instructions.
    const still = await p.suup(["resume", id]);
    expect(still.code).toBe(0);
    expect(still.stdout).toContain("Qual cor?");
    expect(still.stdout).toContain("continua aguardando a sua resposta");

    const said = await p.suup(["say", id, "azul"]);
    expect(said.code).toBe(0);
    expect(said.stdout).toContain("Resposta registrada");
    expect(said.stdout).toContain("voltou para a fila");
    expect((await show(p, id)).status).toBe("queued");

    const resumed = await p.suup(["resume", id]);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain("Retomando a execução");
    expect(resumed.stdout).toContain("resposta recebida:");
    expect(resumed.stdout).toContain("azul");
    expect(resumed.stdout).toContain("Escolhi a cor que você disse.");
    expect((await show(p, id)).status).toBe("done");

    // a finished run takes no more messages or resumes
    const late = await p.suup(["say", id, "tarde demais"]);
    expect(late.code).toBe(1);
    expect(late.stderr).toContain("já terminou");
    expect((await p.suup(["resume", id])).code).toBe(1);
    expect((await p.suup(["stop", id])).code).toBe(1);
  });

  it("a soft stop (Ctrl+C once) pauses at the next safe point, keeps the run resumable, and resume finishes it", async () => {
    await p.script("roteiro.json", {
      agent: [
        { calls: [{ name: "write_file", args: { path: "a.txt", content: "um" } }] },
        { delayMs: 700, calls: [{ name: "write_file", args: { path: "b.txt", content: "dois" } }] },
        { delayMs: 50, calls: [{ name: "write_file", args: { path: "c.txt", content: "três" } }] },
        { text: "Os três arquivos foram criados." },
      ],
    });
    const r = await p.suup(["run", "Crie três arquivos", "--bot", "ajudante"], {
      during: async (h) => {
        await h.waitFor("turno 2: consultando"); // the model call of turn 2 is in flight (it takes 700 ms)
        h.interrupt();
      },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const id = idOf(r);
    expect(r.stdout).toContain("pausando no próximo ponto seguro");
    expect(r.stdout).toContain("Execução pausada");
    expect(r.stdout).toContain(`suup resume ${id.slice(0, 8)}`);

    // Turn 2 was finished (its tool ran), turn 3 was not started.
    expect(r.stdout).toContain('path="b.txt"');
    expect(r.stdout).not.toContain("turno 3");
    expect(await p.readBotFile(botId, "b.txt")).toBe("dois");
    await expect(p.readBotFile(botId, "c.txt")).rejects.toThrow();
    const paused = await show(p, id);
    expect(paused.status).toBe("queued");
    const kinds = (await events(p, id)).map((e) => e.type);
    expect(kinds.filter((t) => t === "model_request")).toHaveLength(2);
    expect(kinds).not.toContain("model_error");
    expect(kinds.at(-1)).toBe("tool_result");

    const resumed = await p.suup(["resume", id]);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain("Retomando a execução");
    expect(resumed.stdout).toContain("turno 3: consultando");
    expect(resumed.stdout).toContain("Os três arquivos foram criados.");
    expect(await p.readBotFile(botId, "c.txt")).toBe("três");
    expect((await show(p, id)).status).toBe("done");
  });

  it("Ctrl+C twice aborts at once, leaves the run resumable, and stop + resume cancels it", async () => {
    await p.script("roteiro.json", { agent: [{ delayMs: 30_000, text: "nunca" }] });
    const started = Date.now();
    const r = await p.suup(["run", "Algo demorado", "--bot", "ajudante"], {
      during: async (h) => {
        await h.waitFor("turno 1: consultando");
        h.interrupt();
        await h.waitFor("pausando no próximo ponto seguro");
        h.interrupt();
      },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Abortando agora");
    expect(r.stdout).toContain("Execução pausada");
    const id = idOf(r);
    expect((await show(p, id)).status).toBe("queued");
    expect(
      (await events(p, id)).some((e) => e.type === "model_error" && e.payload.kind === "aborted"),
    ).toBe(true);

    const stop = await p.suup(["stop", id]);
    expect(stop.code).toBe(0);
    expect(stop.stdout).toContain("Pedido de parada registrado");
    const cancelled = await p.suup(["resume", id]);
    expect(cancelled.code).toBe(1);
    expect(cancelled.stdout).toContain("Cancelada a pedido do usuário");
    expect((await show(p, id)).status).toBe("cancelled");
  });

  it("a line typed while the run works reaches the bot as a user message at the next safe point", async () => {
    await p.script("roteiro.json", {
      agent: [
        { delayMs: 500, calls: [{ name: "shell", args: { command: "echo trabalhando" } }] },
        { text: "Anotei o seu recado." },
      ],
    });
    const r = await p.suup(["run", "Trabalhe um pouco", "--bot", "ajudante"], {
      tty: true,
      during: async (h) => {
        await h.waitFor("turno 1: consultando");
        h.send("não esqueça das aspas");
      },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("mensagem enviada");
    expect(r.stdout).toContain("sua mensagem chegou ao bot: não esqueça das aspas");
    const id = idOf(r);
    const delivered = await events(p, id, ["--type", "user_message"]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload.text).toBe("não esqueça das aspas");
    // delivered after the tool of turn 1, before the model call of turn 2
    const all = (await events(p, id)).map((e) => e.type);
    expect(all.indexOf("user_message")).toBeGreaterThan(all.indexOf("tool_result"));
    expect(all.indexOf("user_message")).toBeLessThan(all.lastIndexOf("model_request"));
  });

  it("a provider failure keeps its origin: exit 1, the origin in the live view and, prominent, in show", async () => {
    await p.suup(["bot", "create", "--name", "semchave", "--model", "model-k"]);
    const r = await p.suup(["run", "Qualquer coisa", "--bot", "semchave"]);
    expect(r.code).toBe(1);
    const id = idOf(r);
    expect(r.stdout).toContain("Falhou [origem: provider]");
    expect(r.stdout).toContain("auth:");
    expect(r.stdout).toContain("SUUP_TEST_MISSING_KEY");
    expect(r.stdout).toContain("falhou em");

    const shown = (await p.suup(["show", id])).stdout;
    expect(shown).toContain(">>> FALHOU — ORIGEM: PROVIDER");
    expect(shown).toContain("o provedor do modelo falhou");
    expect(shown).toContain("Detalhe: auth:");
    expect(shown).toContain("Erros do provedor (1)");
    const json = await show(p, id);
    expect(json.failure).toMatchObject({ origin: "provider" });
    expect(json.failure?.detail).toContain("SUUP_TEST_MISSING_KEY");
  });

  it("a limit failure keeps its origin too", async () => {
    await p.script("roteiro.json", {
      agent: [
        { calls: [{ name: "shell", args: { command: "echo 1" } }] },
        { calls: [{ name: "shell", args: { command: "echo 2" } }] },
        { text: "nunca chega" },
      ],
    });
    await p.suup([
      "bot",
      "create",
      "--name",
      "curto",
      "--model",
      "model-x",
      "--all-tools",
      "--max-turns",
      "2",
    ]);
    const r = await p.suup(["run", "Dois turnos só", "--bot", "curto"]);
    expect(r.code).toBe(1);
    const shown = (await p.suup(["show", idOf(r)])).stdout;
    expect(shown).toContain("ORIGEM: LIMIT");
    expect(shown).toContain("turn limit reached");
  });

  it("an archived bot cannot start runs, and disappears from the default list", async () => {
    const archived = await p.suup(["bot", "archive", "curto"]);
    expect(archived.code).toBe(0);
    expect(archived.stdout).toContain("Bot arquivado: curto");
    expect((await p.suup(["bot", "archive", "curto"])).stdout).toContain("já estava arquivado");
    const r = await p.suup(["run", "De novo", "--bot", "curto"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('O bot "curto"');
    expect(r.stderr).toContain("arquivado");
    expect(r.stdout).not.toContain("criada");
    expect((await p.suup(["bot", "list"])).stdout).not.toContain("curto");
    const all = await p.suup(["bot", "list", "--all"]);
    expect(all.stdout).toContain("curto");
    expect(all.stdout).toContain("arquivado");
  });

  it("runs lists and filters by bot, status and limit", async () => {
    const all = JSON.parse((await p.suup(["runs", "--json", "--limit", "100"])).stdout) as {
      id: string;
      status: string;
      botId: string;
    }[];
    expect(all.length).toBeGreaterThanOrEqual(8);

    const failed = JSON.parse(
      (await p.suup(["runs", "--status", "failed", "--json"])).stdout,
    ) as typeof all;
    expect(failed.length).toBe(2);
    expect(new Set(failed.map((r) => r.status))).toEqual(new Set(["failed"]));

    const cancelled = JSON.parse(
      (await p.suup(["runs", "--status", "cancelled", "--json"])).stdout,
    ) as typeof all;
    expect(cancelled).toHaveLength(1);

    const ofHelper = JSON.parse(
      (await p.suup(["runs", "--bot", "ajudante", "--json", "--limit", "100"])).stdout,
    ) as typeof all;
    expect(ofHelper.every((r) => r.botId === botId)).toBe(true);
    expect(ofHelper.length).toBeGreaterThan(0);
    expect(ofHelper.length).toBeLessThan(all.length);

    const one = JSON.parse((await p.suup(["runs", "--limit", "1", "--json"])).stdout) as typeof all;
    expect(one).toHaveLength(1);
    expect(one[0]?.id).toBe(all[0]?.id); // newest first

    const table = (await p.suup(["runs", "--status", "failed"])).stdout;
    expect(table).toContain("SITUAÇÃO");
    expect(table).toContain("falhou");
    expect(table).toContain("semchave");
    const none = await p.suup(["runs", "--bot", "ajudante", "--status", "waiting_approval"]);
    expect(none.stdout).toContain("Nenhuma execução encontrada.");
  });

  it("run --detach only creates the run; a standalone worker processes it and stops on Ctrl+C", async () => {
    await p.script("roteiro.json", { agent: [{ text: "Feito pelo worker." }] });
    const detached = await p.suup(["run", "Faça algo", "--bot", "ajudante", "--detach", "--json"]);
    expect(detached.code).toBe(0);
    const { id } = JSON.parse(detached.stdout) as { id: string };
    expect((await show(p, id)).status).toBe("queued");
    const human = await p.suup(["run", "Faça algo", "--bot", "ajudante", "--detach"]);
    expect(human.stdout).toContain("Um worker precisa processá-la: suup worker");

    const w = await p.suup(["worker"], {
      during: async (h) => {
        await h.waitFor("Worker ");
        await h.waitFor(`Execução ${id.slice(0, 8)}: concluída`);
        h.interrupt();
      },
    });
    expect(w.code, w.stdout + w.stderr).toBe(0);
    expect(w.stdout).toContain("Parando:");
    expect(w.stdout).toContain("Worker parado.");
    const shown = await show(p, id);
    expect(shown.status).toBe("done");
    expect(shown.result?.summary).toBe("Feito pelo worker.");
    // the second detached run was taken by the same worker
    expect((await p.suup(["runs", "--status", "queued"])).stdout).toContain("Nenhuma execução");
  });

  it("run --json streams the events as JSON lines, then the result", async () => {
    await p.script("roteiro.json", { agent: [{ text: "Olá em JSON." }] });
    const r = await p.suup(["run", "Diga olá", "--bot", "ajudante", "--json"]);
    expect(r.code).toBe(0);
    const lines = r.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; eventType?: string });
    expect(lines.filter((l) => l.type === "event").map((l) => l.eventType)).toContain(
      "run_started",
    );
    expect(lines.at(-1)).toMatchObject({ type: "result", status: "done", turns: 1 });
  });
});
