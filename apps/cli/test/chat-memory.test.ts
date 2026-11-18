import { describe, expect, it } from "vitest";
import { DATABASE_URL, dbSuiteName, useProject } from "./harness.js";

// Phase 2 end to end, through the real `main`: conversations, memory and the context of a run.
// The scripted provider answers by case: a case is chosen by a token in the conversation, and a
// run that has history starts its script at the number of assistant turns already in the history.

const say = (text: string) => ({ text });
const act = (name: string, args: unknown) => ({ calls: [{ name, args }] });

describe.skipIf(!DATABASE_URL)(dbSuiteName("suup chat and memory, end to end"), () => {
  const p = useProject();

  type Json = Record<string, unknown>;
  const json = async (argv: string[]) => {
    const r = await p.suup([...argv, "--json"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };

  const runsOf = async (botName: string) =>
    (
      await p.db.sql<{ id: string }[]>`
        select r.id from runs r join bots b on b.id = r.bot_id
        where b.name = ${botName} order by r.created_at, r.id`
    ).map((r) => r.id);

  const eventsOf = (runId: string) =>
    p.db.sql<{ seq: number; type: string; payload: Json }[]>`
      select seq, type, payload from run_events where run_id = ${runId} order by seq`;

  /** What the model was sent as the system prompt in the first request of the run. */
  const systemOf = async (runId: string): Promise<string> => {
    const requests = (await eventsOf(runId)).filter(
      (e) => e.type === "model_request" && e.payload.purpose === undefined,
    );
    return (requests[0]?.payload.system as string | undefined) ?? "";
  };

  const requestsOf = async (runId: string) =>
    (await eventsOf(runId))
      .filter((e) => e.type === "model_request" && e.payload.purpose === undefined)
      .map(
        (e) =>
          e.payload as {
            system: string;
            messages: { role: string; blocks: { type: string; text?: string }[] }[];
          },
      );

  const chat = (bot: string, text: string) => p.suup(["chat", "--bot", bot, "--message", text]);

  const textOfMessage = (m: { blocks: { type: string; text?: string }[] }) =>
    m.blocks.map((b) => b.text ?? "").join("");

  const toolResults = async (runId: string) =>
    (await eventsOf(runId))
      .filter((e) => e.type === "tool_result")
      .map((e) => e.payload.content as string);

  it("first use: chat without a bot creates the main bot, and an explicit bot works afterwards", async () => {
    await p.suup(["db", "migrate"]);
    await p.script("roteiro.json", {
      cases: [
        // the second message of the conversation has one assistant turn of history
        { whenObjectiveContains: "outra vez", agent: [say("(história)"), say("De novo!")] },
        { whenObjectiveContains: "PRIMEIRO-USO", agent: [say("Olá! Eu sou o bot principal.")] },
      ],
    });
    await p.script("outro.json", { agent: [] });
    const r = await p.suup(["chat", "--message", "PRIMEIRO-USO oi"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('criei o bot principal "Principal"');
    expect(r.stdout).toContain("Principal: Olá! Eu sou o bot principal.");
    const bots = (await json(["bot", "list"])) as { name: string; allowedTools: string[] }[];
    expect(bots.map((b) => b.name)).toEqual(["Principal"]);
    expect(bots[0]?.allowedTools).toEqual(
      expect.arrayContaining(["remember", "recall", "forget", "search_conversations"]),
    );
    // Again: the same bot, not a second one.
    const again = await p.suup(["chat", "--message", "PRIMEIRO-USO outra vez"]);
    expect(again.code, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain("Principal: De novo!");
    expect(((await json(["bot", "list"])) as unknown[]).length).toBe(1);
  });

  it("without a terminal and without --message there is nothing to do (usage error)", async () => {
    const r = await p.suup(["chat", "--bot", "Principal"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--message");
  });

  describe("the phase acceptance test", () => {
    it("a fact said in one conversation is known, in another conversation, by a bot created from a description", async () => {
      await p.script("roteiro.json", {
        cases: [
          {
            whenObjectiveContains: "Marina e moro em Recife",
            agent: [
              act("remember", {
                layer: "profile",
                text: "O usuário se chama Marina e mora em Recife.",
              }),
              say("Anotado, Marina!"),
            ],
          },
          {
            whenObjectiveContains: "advogada trabalhista",
            agent: [
              act("propose_bot", {
                name: "Lúcia",
                description: "Advogada trabalhista que explica direitos com clareza.",
                personality:
                  "Você é a Lúcia, uma advogada trabalhista. Explique os direitos do usuário com clareza e peça os documentos de que precisar antes de opinar.",
              }),
            ],
          },
          { whenObjectiveContains: "Qual é o meu nome", agent: [say("Seu nome é Marina.")] },
        ],
      });
      await p.suup(["bot", "create", "--name", "ana", "--model", "model-x", "--all-tools"]);

      // Conversation 1, with bot A: the user states a fact and the bot remembers it.
      const first = await chat("ana", "Meu nome é Marina e moro em Recife.");
      expect(first.code, first.stdout + first.stderr).toBe(0);
      expect(first.stdout).toContain("ana: Anotado, Marina!");
      const memories = (await json(["memory", "list"])) as Json[];
      const fact = memories.find((m) => m.layer === "profile");
      expect(fact).toMatchObject({
        text: "O usuário se chama Marina e mora em Recife.",
        scope: "shared",
        createdBy: "bot",
      });
      const [anaRun] = await runsOf("ana");
      expect(fact?.sourceRunId).toBe(anaRun);
      expect(fact?.sourceConversationId).toBeTruthy();

      // A new bot is drafted from a description, and created after the proposal is confirmed.
      const draft = await p.suup([
        "bot",
        "draft",
        "Uma advogada trabalhista que explica direitos com clareza",
        "--model",
        "model-x",
      ]);
      expect(draft.code, draft.stdout + draft.stderr).toBe(0);
      expect(draft.stdout).toContain("Proposta de bot: Lúcia");
      expect(draft.stdout).toContain("Nada foi criado");
      expect(((await json(["bot", "list"])) as unknown[]).length).toBe(2); // Principal + ana
      const created = await p.suup([
        "bot",
        "draft",
        "Uma advogada trabalhista que explica direitos com clareza",
        "--model",
        "model-x",
        "--create",
      ]);
      expect(created.code, created.stdout + created.stderr).toBe(0);
      expect(created.stdout).toContain("Bot criado: Lúcia");

      // Conversation 2, with the new bot: its run knows the fact from the very first request.
      const second = await chat("Lúcia", "Qual é o meu nome?");
      expect(second.code, second.stdout + second.stderr).toBe(0);
      expect(second.stdout).toContain("Lúcia: Seu nome é Marina.");
      const [luciaRun] = await runsOf("Lúcia");
      const system = await systemOf(luciaRun as string);
      expect(system).toContain("## What you know about the user");
      expect(system).toContain("- O usuário se chama Marina e mora em Recife.");
      expect(system).toContain("You are Lúcia");
      expect(system).toContain("advogada trabalhista");
      const loaded = (await eventsOf(luciaRun as string)).find((e) => e.type === "context_loaded");
      expect(((loaded?.payload.profile ?? []) as Json[])[0]?.text).toBe(
        "O usuário se chama Marina e mora em Recife.",
      );
      expect(loaded?.payload.history).toEqual([]);
    });
  });

  describe("rules and notes", () => {
    it("a rule the user states appears in every later run's system prompt: for all bots (shared) or for one (bot scope)", async () => {
      await p.script("roteiro.json", {
        cases: [
          {
            whenObjectiveContains: "LEMBRE-REGRA",
            agent: [
              act("remember", { layer: "rule", text: "Nunca use gírias.", scope: "shared" }),
              act("remember", { layer: "rule", text: "Trate o usuário por chefe.", scope: "bot" }),
              say("Regras guardadas."),
            ],
          },
          { whenObjectiveContains: "SO-RESPONDA", agent: [say("Certo.")] },
        ],
      });
      await p.suup(["bot", "create", "--name", "regra-a", "--model", "model-x", "--all-tools"]);
      await p.suup(["bot", "create", "--name", "regra-b", "--model", "model-x", "--all-tools"]);
      await p.suup(["bot", "create", "--name", "regra-c", "--model", "model-x", "--all-tools"]);

      const said = await chat("regra-a", "LEMBRE-REGRA: nunca use gírias, e me chame de chefe");
      expect(said.code, said.stdout + said.stderr).toBe(0);
      expect(said.stdout).toContain("regra-a: Regras guardadas.");
      const rules = ((await json(["memory", "list", "--layer", "rule"])) as Json[]).filter(
        (r) => r.createdBy === "bot",
      );
      expect(rules.map((r) => [r.text, r.scope])).toEqual([
        ["Nunca use gírias.", "shared"],
        ["Trate o usuário por chefe.", "bot"],
      ]);
      // Audit: the bot-created rule records where it came from.
      for (const rule of rules) expect(rule.sourceRunId).toBeTruthy();

      for (const bot of ["regra-b", "regra-c"]) {
        const r = await chat(bot, "SO-RESPONDA");
        expect(r.code, r.stdout + r.stderr).toBe(0);
      }
      const system = async (bot: string) => systemOf((await runsOf(bot))[0] as string);
      const a2 = (await json(["memory", "list", "--layer", "rule", "--bot", "regra-a"])) as Json[];
      expect(a2).toHaveLength(1); // --bot shows the bot's own rule

      const forB = await system("regra-b");
      const forC = await system("regra-c");
      for (const s of [forB, forC]) {
        expect(s).toContain("## Standing rules from the user");
        expect(s).toContain("- Nunca use gírias.");
        expect(s).not.toContain("Trate o usuário por chefe.");
      }
      // The bot that owns the second rule sees it in its next run.
      await p.script("roteiro.json", {
        cases: [{ whenObjectiveContains: "OUTRA-DE-A", agent: [say("Ok.")] }],
      });
      await p.suup(["bot", "create", "--name", "regra-a2", "--model", "model-x"]);
      // (a fresh conversation would have no rule of regra-a: the rule is of that bot only)
      const forA2 = await (async () => {
        await chat("regra-a2", "OUTRA-DE-A");
        return system("regra-a2");
      })();
      expect(forA2).toContain("- Nunca use gírias.");
      expect(forA2).not.toContain("Trate o usuário por chefe.");
    });

    it("a rule typed by the user (memory add) is shared by default and is the user's, with no run as origin", async () => {
      await p.script("roteiro.json", {
        cases: [{ whenObjectiveContains: "REGRA-USUARIO", agent: [say("ok")] }],
      });
      const add = await p.suup(["memory", "add", "rule", "Termine sempre com Abraço!"]);
      expect(add.code, add.stdout + add.stderr).toBe(0);
      expect(add.stdout).toContain("para todos os bots");
      await p.suup(["bot", "create", "--name", "ouve-regra", "--model", "model-x"]);
      await chat("ouve-regra", "REGRA-USUARIO");
      const [run] = await runsOf("ouve-regra");
      expect(await systemOf(run as string)).toContain("- Termine sempre com Abraço!");
    });

    it("a bot's note is found by recall for that bot and is invisible to another bot", async () => {
      await p.script("roteiro.json", {
        cases: [
          {
            whenObjectiveContains: "NOTA-DO-A",
            agent: [
              act("remember", { layer: "note", text: "A planilha de gastos se chama gastos2026." }),
              say("Anotei."),
            ],
          },
          {
            whenObjectiveContains: "BUSCA-DO-A",
            agent: [act("recall", { query: "planilha gastos2026" }), say("Achei.")],
          },
          {
            whenObjectiveContains: "BUSCA-DO-B",
            agent: [act("recall", { query: "planilha gastos2026" }), say("Não achei.")],
          },
        ],
      });
      for (const name of ["nota-a", "nota-b"]) {
        await p.suup(["bot", "create", "--name", name, "--model", "model-x", "--all-tools"]);
      }
      expect((await chat("nota-a", "NOTA-DO-A")).code).toBe(0);
      // The search of the second turn of A's conversation: history has one assistant turn.
      await p.script("roteiro.json", {
        cases: [
          {
            whenObjectiveContains: "BUSCA-DO-A",
            agent: [
              say("(história)"),
              act("recall", { query: "planilha gastos2026" }),
              say("Achei."),
            ],
          },
          {
            whenObjectiveContains: "BUSCA-DO-B",
            agent: [act("recall", { query: "planilha gastos2026" }), say("Não achei.")],
          },
          { whenObjectiveContains: "NOTA-DO-A", agent: [say("Anotei.")] },
        ],
      });
      expect((await chat("nota-a", "BUSCA-DO-A")).code).toBe(0);
      expect((await chat("nota-b", "BUSCA-DO-B")).code).toBe(0);

      const runA = (await runsOf("nota-a"))[1] as string;
      const runB = (await runsOf("nota-b"))[0] as string;
      const foundByA = (await toolResults(runA))[0] ?? "";
      expect(foundByA).toContain("[note]");
      expect(foundByA).toContain("A planilha de gastos se chama gastos2026.");
      expect((await toolResults(runB))[0]).toContain("No memory matches");
      // The note is listed for its bot, and is not in anyone's system prompt (notes are searched).
      expect(await systemOf(runA)).not.toContain("gastos2026");
      expect(await systemOf(runB)).not.toContain("gastos2026");
    });
  });

  describe("the conversation before this run", () => {
    it("starts the request with the earlier exchange; a small budget cuts whole messages and adds a note", async () => {
      await p.script("roteiro.json", {
        cases: [
          {
            whenObjectiveContains: "TURNO-TRES",
            agent: [say("(história)"), say("Resposta três.")],
          },
          {
            whenObjectiveContains: "TURNO-DOIS",
            agent: [say("(história)"), say("Resposta dois.")],
          },
          { whenObjectiveContains: "TURNO-UM", agent: [say("Resposta um.")] },
        ],
      });
      await p.suup(["bot", "create", "--name", "hist", "--model", "model-x", "--all-tools"]);
      expect((await chat("hist", "TURNO-UM falar de jardim")).code).toBe(0);
      const two = await chat("hist", "TURNO-DOIS ainda jardim");
      expect(two.code, two.stdout + two.stderr).toBe(0);
      expect(two.stdout).toContain("hist: Resposta dois.");

      const [, secondRun] = await runsOf("hist");
      const [request] = await requestsOf(secondRun as string);
      expect(
        request?.messages.map((m) => [
          m.role,
          textOfMessage(m)
            .replace(/\[STATE REMINDER[\s\S]*$/, "")
            .trim(),
        ]),
      ).toEqual([
        ["user", "TURNO-UM falar de jardim"],
        ["assistant", "Resposta um."],
        ["user", "TURNO-DOIS ainda jardim"],
      ]);
      expect(textOfMessage(request?.messages[2] ?? { blocks: [] })).toContain("[STATE REMINDER");
      const loaded = (await eventsOf(secondRun as string)).find((e) => e.type === "context_loaded");
      expect(loaded?.payload.historyNote).toBeUndefined();

      // A budget of 40 characters keeps the newest two messages (14 + 23) and drops the rest.
      await p.config({ defaults: { maxTurns: 20, historyChars: 40 } });
      const three = await chat("hist", "TURNO-TRES por fim");
      expect(three.code, three.stdout + three.stderr).toBe(0);
      const thirdRun = (await runsOf("hist"))[2] as string;
      const [last] = await requestsOf(thirdRun);
      expect(last?.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
      const texts = (last?.messages ?? []).map(textOfMessage);
      expect(texts[0]).toContain("TURNO-DOIS ainda jardim");
      expect(texts[0]).toContain("search_conversations");
      expect(texts[0]).not.toContain("TURNO-UM");
      expect(texts[1]).toBe("Resposta dois.");
      expect(texts[2]).toContain("TURNO-TRES por fim");
      const loaded3 = (await eventsOf(thirdRun)).find((e) => e.type === "context_loaded");
      expect(loaded3?.payload.historyNote).toMatch(/2 older/);
      await p.config();
    });

    it("the system prompt, the tools and the start of the conversation do not change from one request of a run to the next", async () => {
      await p.script("roteiro.json", {
        cases: [
          {
            whenObjectiveContains: "MULTI-TURNO",
            agent: [
              act("shell", { command: "echo um" }),
              act("shell", { command: "echo dois" }),
              say("Terminei."),
            ],
          },
        ],
      });
      await p.suup(["memory", "add", "profile", "Prefere respostas curtas."]);
      await p.suup(["bot", "create", "--name", "prefixo", "--model", "model-x", "--all-tools"]);
      expect((await chat("prefixo", "MULTI-TURNO")).code).toBe(0);
      const requests = await requestsOf((await runsOf("prefixo"))[0] as string);
      expect(requests).toHaveLength(3);
      for (const [i, request] of requests.entries()) {
        expect(request.system).toBe(requests[0]?.system);
        if (i > 0) {
          const before = requests[i - 1]?.messages ?? [];
          expect(request.messages.slice(0, before.length)).toEqual(before);
        }
      }
    });
  });

  describe("forgetting", () => {
    it("a forgotten memory is no longer injected; restoring brings it back; the bot can forget with its tool", async () => {
      await p.script("roteiro.json", {
        cases: [{ whenObjectiveContains: "SO-VEJA", agent: [say("Visto.")] }],
      });
      const added = await json(["memory", "add", "profile", "O usuário odeia coentro."]);
      const id = (added as Json).id as string;
      for (const name of ["esq-1", "esq-2", "esq-3"]) {
        await p.suup(["bot", "create", "--name", name, "--model", "model-x", "--all-tools"]);
      }
      await chat("esq-1", "SO-VEJA");
      expect(await systemOf((await runsOf("esq-1"))[0] as string)).toContain("odeia coentro");

      const forgot = await p.suup(["memory", "forget", id.slice(0, 8)]);
      expect(forgot.code, forgot.stdout + forgot.stderr).toBe(0);
      expect(forgot.stdout).toContain("Esquecida");
      expect(forgot.stdout).toContain(`suup memory restore ${id.slice(0, 8)}`);
      const listed = await p.suup(["memory", "list"]);
      expect(listed.stdout).not.toContain("odeia coentro");
      expect((await p.suup(["memory", "list", "--all"])).stdout).toContain("[esquecida]");
      await chat("esq-2", "SO-VEJA");
      expect(await systemOf((await runsOf("esq-2"))[0] as string)).not.toContain("coentro");

      const restored = await p.suup(["memory", "restore", id.slice(0, 8)]);
      expect(restored.code).toBe(0);
      expect(restored.stdout).toContain("Restaurada");
      await chat("esq-3", "SO-VEJA");
      expect(await systemOf((await runsOf("esq-3"))[0] as string)).toContain("odeia coentro");

      // The bot forgets it with its tool, by id; the result says so, and it is archived (listed with --all).
      await p.script("roteiro.json", {
        cases: [
          {
            whenObjectiveContains: "ESQUECA-ISSO",
            agent: [act("forget", { id }), say("Esquecido.")],
          },
        ],
      });
      await p.suup(["bot", "create", "--name", "esq-4", "--model", "model-x", "--all-tools"]);
      expect((await chat("esq-4", "ESQUECA-ISSO")).code).toBe(0);
      expect((await toolResults((await runsOf("esq-4"))[0] as string))[0]).toContain("Forgotten");
      expect((await p.suup(["memory", "list"])).stdout).not.toContain("odeia coentro");
      expect((await p.suup(["memory", "restore", id])).code).toBe(0);
      expect((await p.suup(["memory", "list"])).stdout).toContain("odeia coentro");
    });
  });

  describe("replay", () => {
    it("a conversation run with context replays identically, from the recorded context", async () => {
      // The second turn of "hist" had history; replay it after memory has changed since.
      const run = (await runsOf("hist"))[1] as string;
      await p.suup(["memory", "add", "rule", "Uma regra nova, de depois da execução."]);
      const r = await p.suup(["replay", run]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("Resultado: IDÊNTICO");
      const j = JSON.parse((await p.suup(["replay", run, "--json"])).stdout);
      expect(j.identical).toBe(true);
      expect(JSON.stringify(j)).not.toContain("Uma regra nova");
    });
  });

  describe("chat in a terminal", () => {
    it("shows the bot's question, takes the next line as the answer, and ends on /sair", async () => {
      await p.script("roteiro.json", {
        cases: [
          {
            whenObjectiveContains: "PERGUNTE-ME",
            agent: [
              act("escalate", { question: "Qual é o número da sorte?" }),
              say("Então é o 42."),
            ],
          },
        ],
      });
      await p.suup(["bot", "create", "--name", "tty", "--model", "model-x", "--all-tools"]);
      const r = await p.suup(["chat", "--bot", "tty"], {
        tty: true,
        during: async (h) => {
          await h.waitFor("Você> ");
          h.send("PERGUNTE-ME algo");
          await h.waitFor("tty: Qual é o número da sorte?");
          await h.waitFor("Sua resposta> ");
          h.send("42");
          await h.waitFor("tty: Então é o 42.");
          await h.waitFor("Você> ");
          h.send("/sair");
        },
      });
      expect(r.code, r.stdout + r.stderr).toBe(0);
      expect(r.stdout).toContain("Conversa com tty");
      // The question appears once (as the bot's message), not also as a raw event.
      expect(r.stdout.split("Qual é o número da sorte?").length - 1).toBe(1);

      // Opening the chat again shows what was said.
      const again = await p.suup(["chat", "--bot", "tty"], {
        tty: true,
        during: async (h) => {
          await h.waitFor("Você> ");
          h.send("/sair");
        },
      });
      expect(again.stdout).toContain("── mensagens anteriores ──");
      expect(again.stdout).toContain("Você: 42");
      expect(again.stdout).toContain("tty: Então é o 42.");
    });

    it("a failed run is reported as a system message and exit 1", async () => {
      await p.script("roteiro.json", {
        cases: [
          {
            whenObjectiveContains: "VAI-FALHAR",
            agent: [{ error: { kind: "invalid_request", message: "kaput", retryable: false } }],
          },
        ],
      });
      await p.suup(["bot", "create", "--name", "falha", "--model", "model-x"]);
      const r = await chat("falha", "VAI-FALHAR");
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("Sistema: Não consegui concluir esta tarefa");
      expect(r.stdout).toContain("origem: provider");
    });

    it("--json prints the events and the bot's message as data", async () => {
      await p.script("roteiro.json", {
        cases: [{ whenObjectiveContains: "EM-JSON", agent: [say("Resposta em json.")] }],
      });
      await p.suup(["bot", "create", "--name", "jsonista", "--model", "model-x"]);
      const r = await p.suup(["chat", "--bot", "jsonista", "--message", "EM-JSON", "--json"]);
      expect(r.code, r.stdout + r.stderr).toBe(0);
      const lines = r.stdout
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Json);
      expect(lines.some((l) => l.type === "event")).toBe(true);
      const messages = lines.filter((l) => l.type === "message");
      expect(messages.map((m) => [m.author, m.text])).toEqual([
        ["user", "EM-JSON"],
        ["bot", "Resposta em json."],
      ]);
    });
  });

  describe("suup memory", () => {
    it("add, list, edit, search, with the layers in either language", async () => {
      const note = await p.suup([
        "memory",
        "add",
        "note",
        "O deploy fica em tools/deploy.sh",
        "--bot",
        "hist",
      ]);
      expect(note.code, note.stdout + note.stderr).toBe(0);
      expect((await p.suup(["memory", "add", "nota", "sem bot"])).code).toBe(2);
      expect((await p.suup(["memory", "add", "profile", "x", "--bot", "hist"])).code).toBe(2);
      expect((await p.suup(["memory", "add", "journal", "x"])).code).toBe(2);
      expect((await p.suup(["memory", "list", "--layer", "abc"])).code).toBe(2);

      const listed = (await json(["memory", "list", "--layer", "nota", "--bot", "hist"])) as Json[];
      expect(listed.map((m) => m.text)).toEqual(["O deploy fica em tools/deploy.sh"]);
      const id = listed[0]?.id as string;

      const edit = await p.suup([
        "memory",
        "edit",
        id.slice(0, 8),
        "O deploy fica em scripts/deploy.sh",
      ]);
      expect(edit.code, edit.stdout + edit.stderr).toBe(0);
      expect(edit.stdout).toContain("antes:");
      expect(edit.stdout).toContain("scripts/deploy.sh");

      const found = (await json(["memory", "search", "deploy", "--bot", "hist"])) as {
        memories: Json[];
      };
      expect(found.memories.map((m) => m.text)).toEqual(["O deploy fica em scripts/deploy.sh"]);
      // Another bot, or no bot: the note is not visible.
      const hidden = (await json(["memory", "search", "deploy", "--bot", "tty"])) as {
        memories: Json[];
      };
      expect(hidden.memories).toEqual([]);
      const text = await p.suup(["memory", "search", "deploy", "--bot", "hist"]);
      expect(text.stdout).toContain("[nota]");
      expect(text.stdout).toContain("criada por você");

      const messages = await p.suup(["memory", "search", "jardim", "--messages", "--bot", "hist"]);
      expect(messages.stdout).toContain("Conversas:");
      expect(messages.stdout).toContain("jardim");

      expect((await p.suup(["memory", "forget", "zzzz"])).code).toBe(1);
      expect((await p.suup(["memory", "search", "inexistentepalavra"])).stdout).toContain(
        "Nada encontrado",
      );
    });

    it("the journal shows what each bot did, one entry per run", async () => {
      const journal = (await json([
        "memory",
        "list",
        "--layer",
        "journal",
        "--bot",
        "hist",
      ])) as Json[];
      const runs = await runsOf("hist");
      expect(journal.map((j) => j.sourceRunId).sort()).toEqual([...runs].sort());
      expect(journal[0]?.text).toMatch(/Objetivo: "TURNO-/);
    });
  });
});
