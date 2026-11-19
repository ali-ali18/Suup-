import { generateKeyText } from "@suup/runtime";
import { describe, expect, it, vi } from "vitest";
import { DATABASE_URL, dbSuiteName, type Result, useProject } from "./harness.js";

// Phase 3 through the real `main`: the approval cards, the rules and the vault from the terminal,
// with the real runtime and worker, the scripted provider and the local sandbox. The project's
// configuration does NOT let shell run freely here: on the local machine it asks.

vi.setConfig({ testTimeout: 30_000 });

const VALUE = "cli_live_9f8e7d6c5b4a3210";
const KEY = generateKeyText();
const call = (name: string, args: unknown) => ({ calls: [{ name, args }] });

describe.skipIf(!DATABASE_URL)(dbSuiteName("suup approvals, rules and vault, end to end"), () => {
  const p = useProject();
  /** The start of an id, as a person types it. */
  const prefix = (id: string | undefined, length: number): string => (id ?? "").slice(0, length);
  const withVault = { env: { CLI_TEST_VAULT_KEY: KEY } };

  type Json = Record<string, unknown>;
  const json = async (argv: string[], options = withVault) => {
    const r = await p.suup([...argv, "--json"], options);
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
  const statusOf = async (runId: string) =>
    (await p.db.sql<{ status: string }[]>`select status from runs where id = ${runId}`)[0]?.status;

  it("setup: migrate, a bot that may use shell, scripts", async () => {
    await p.config({ approvals: {}, vault: { keyEnv: "CLI_TEST_VAULT_KEY" } });
    await p.suup(["db", "migrate"]);
    await p.script("roteiro.json", {
      cases: [
        {
          whenObjectiveContains: "CASE-ONE",
          agent: [{ ...call("shell", { command: "echo primeiro" }) }, { text: "Fiz o primeiro." }],
        },
        {
          whenObjectiveContains: "CASE-TWO",
          agent: [
            { ...call("shell", { command: "echo segundo" }) },
            { text: "Entendi a negativa." },
          ],
        },
        {
          whenObjectiveContains: "CASE-SECRET",
          agent: [
            { ...call("shell", { command: 'echo "k={{secret:CLI_TOKEN}}"' }) },
            { text: "Usei o segredo." },
          ],
        },
        {
          whenObjectiveContains: "CASE-ASK",
          agent: [
            { ...call("request_secret", { name: "ASKED_SECRET", reason: "teste da CLI" }) },
            { text: "Já tenho o segredo." },
          ],
        },
        {
          whenObjectiveContains: "CASE-CHAT",
          agent: [{ ...call("shell", { command: "echo no-chat" }) }, { text: "Terminei no chat." }],
        },
      ],
    });
    await p.script("outro.json", { agent: [] });
    // One bot per chat scenario: the scripted provider reads the conversation's history to decide
    // where in its script it is.
    for (const name of ["aprova", "chat-sim", "chat-nao", "chat-mudo"]) {
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

  it("run stops at the card, shows it, and says how to answer", async () => {
    const r = await p.suup(["run", "CASE-ONE faça", "--bot", "aprova"], withVault);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const runId = idOf(r);
    expect(r.stdout).toContain("espera a sua aprovação");
    expect(r.stdout).toContain("echo primeiro");
    expect(r.stdout).toContain("externa ou irreversível");
    expect(r.stdout).toContain("conteúdo exato que será executado");
    expect(r.stdout).toContain(`suup approve ${runId.slice(0, 0)}`);
    expect(await statusOf(runId)).toBe("waiting_approval");

    // The list: human and --json.
    const listed = await p.suup(["approvals"], withVault);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("aprova");
    expect(listed.stdout).toContain("pendente");
    const cards = (await json(["approvals"])) as {
      id: string;
      runId: string;
      args: Json;
      status: string;
    }[];
    const card = cards.find((c) => c.runId === runId);
    expect(card).toMatchObject({ status: "pending", args: { command: "echo primeiro" } });
    const shown = await p.suup(["approvals", "--show"], withVault);
    expect(shown.stdout).toContain('"command": "echo primeiro"');

    // Approve by the prefix of its id; the run is queued again, and `resume` finishes it.
    const approved = await p.suup(["approve", prefix(card?.id, 8)], withVault);
    expect(approved.code, approved.stdout + approved.stderr).toBe(0);
    expect(approved.stdout).toContain("Aprovada");
    expect(await statusOf(runId)).toBe("queued");
    const resumed = await p.suup(["resume", runId], withVault);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(await statusOf(runId)).toBe("done");
    const result = (await eventsOf(runId)).find((e) => e.type === "tool_result");
    expect(String(result?.payload.content)).toContain("primeiro");

    // The recorded run, with its card and its decision, replays to the same log.
    const replayed = await p.suup(["replay", runId], withVault);
    expect(replayed.code, replayed.stdout + replayed.stderr).toBe(0);
    expect(replayed.stdout).toContain("IDÊNTICO");

    // Decided once; the pending list is empty again; --all remembers.
    const again = await p.suup(["approve", prefix(card?.id, 8)], withVault);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("já foi resolvida");
    expect((await p.suup(["approvals"], withVault)).stdout).toContain("Nenhuma aprovação pendente");
    expect((await p.suup(["approvals", "--all"], withVault)).stdout).toContain("aprovada");
  });

  it("deny gives the bot a result with the reason, and the run still finishes", async () => {
    const r = await p.suup(["run", "CASE-TWO faça", "--bot", "aprova"], withVault);
    const runId = idOf(r);
    const [card] = (await json(["approvals"])) as { id: string; runId: string }[];
    expect(card?.runId).toBe(runId);
    const denied = await p.suup(["deny", prefix(card?.id, 6), "--reason", "não agora"], withVault);
    expect(denied.code, denied.stdout + denied.stderr).toBe(0);
    expect(denied.stdout).toContain("Negada");
    expect(denied.stdout).toContain("não agora");
    const resumed = await p.suup(["resume", runId], withVault);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(await statusOf(runId)).toBe("done");
    const result = (await eventsOf(runId)).find((e) => e.type === "tool_result");
    expect(result?.payload).toMatchObject({ outcome: "denied", isError: true });
    expect(String(result?.payload.content)).toContain("não agora");
    const shown = await p.suup(["show", runId], withVault);
    expect(shown.stdout).toContain("Entendi a negativa");
  });

  it("approve --always makes a rule that the rules commands list, edit and remove", async () => {
    const run = idOf(await p.suup(["run", "CASE-ONE de novo", "--bot", "aprova"], withVault));
    const [card] = (await json(["approvals"])) as { id: string }[];
    const approved = await p.suup(["approve", prefix(card?.id, 8), "--always"], withVault);
    expect(approved.code, approved.stdout + approved.stderr).toBe(0);
    expect(approved.stdout).toContain("Regra criada");
    await p.suup(["resume", run], withVault);
    expect(await statusOf(run)).toBe("done");

    const rules = (await json(["rules", "list"])) as {
      id: string;
      effect: string;
      createdBy: string;
      matchers: Json[];
    }[];
    const made = rules.find((r) => r.createdBy === "approval");
    expect(made).toMatchObject({
      effect: "allow",
      matchers: [{ field: "command", op: "equals", value: "echo primeiro" }],
    });
    expect((await p.suup(["rules", "list"], withVault)).stdout).toContain("de um cartão");

    // The next equal call runs without a card (a new run, another objective, same command).
    const next = idOf(await p.suup(["run", "CASE-ONE terceira", "--bot", "aprova"], withVault));
    expect(await statusOf(next)).toBe("done");
    expect((await eventsOf(next)).some((e) => e.type === "approval_requested")).toBe(false);

    const edited = await p.suup(
      ["rules", "edit", prefix(made?.id, 8), "--effect", "deny", "--note", "mudei de ideia"],
      withVault,
    );
    expect(edited.code, edited.stdout + edited.stderr).toBe(0);
    const denyRun = idOf(await p.suup(["run", "CASE-ONE quarta", "--bot", "aprova"], withVault));
    const result = (await eventsOf(denyRun)).find((e) => e.type === "tool_result");
    expect(result?.payload.outcome).toBe("denied");
    expect(String(result?.payload.content)).toContain("mudei de ideia");

    expect((await p.suup(["rules", "rm", prefix(made?.id, 8)], withVault)).code).toBe(0);
    expect(
      ((await json(["rules", "list"])) as { id: string }[]).some((r) => r.id === made?.id),
    ).toBe(false);
  });

  it("rules add validates its arguments", async () => {
    const ok = await p.suup(
      [
        "rules",
        "add",
        "--tool",
        "shell",
        "--effect",
        "allow",
        "--bot",
        "aprova",
        "--match",
        "command^=git status",
        "--match",
        "cwd=repo",
        "--note",
        "git ok",
      ],
      withVault,
    );
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    const [rule] = (
      (await json(["rules", "list", "--bot", "aprova"])) as { note: string; matchers: Json[] }[]
    ).filter((r) => r.note === "git ok");
    expect(rule?.matchers).toEqual([
      { field: "command", op: "starts_with", value: "git status" },
      { field: "cwd", op: "equals", value: "repo" },
    ]);
    for (const bad of [
      ["rules", "add", "--tool", "shell"],
      ["rules", "add", "--tool", "shell", "--effect", "maybe"],
      ["rules", "add", "--tool", "shell", "--effect", "allow", "--match", "no-operator"],
    ]) {
      const r = await p.suup(bad, withVault);
      expect(r.code, bad.join(" ")).toBe(2);
    }
  });

  it("chat asks inline: s approves, and the bot's answer follows", async () => {
    const r = await p.suup(["chat", "--bot", "chat-sim"], {
      ...withVault,
      tty: true,
      during: async (h) => {
        await h.waitFor("Você> ");
        h.send("CASE-CHAT por favor");
        await h.waitFor("Aprovar?");
        h.send("s");
        await h.waitFor("chat-sim: Terminei no chat.");
        h.send("/sair");
      },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("quer fazer isto e espera a sua decisão");
    expect(r.stdout).toContain("echo no-chat");
    expect(r.stdout).toContain("Aprovada.");
  });

  it("chat inline: n <reason> denies, and the bot goes on without it", async () => {
    const r = await p.suup(["chat", "--bot", "chat-nao"], {
      ...withVault,
      tty: true,
      during: async (h) => {
        await h.waitFor("Você> ");
        h.send("CASE-TWO por favor");
        await h.waitFor("Aprovar?");
        h.send("n é arriscado");
        await h.waitFor("chat-nao: Entendi a negativa.");
        h.send("/sair");
      },
    });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("Negada");
    const [last] = await p.db.sql<{ id: string }[]>`
      select r.id from runs r where r.objective like 'CASE-TWO por favor%' order by r.created_at desc limit 1`;
    const result = (await eventsOf(last?.id as string)).find((e) => e.type === "tool_result");
    expect(String(result?.payload.content)).toContain("é arriscado");
  });

  it("chat without a terminal prints the card and says how to answer, and the run waits", async () => {
    const r = await p.suup(
      ["chat", "--bot", "aprova", "--message", "CASE-CHAT sem terminal"],
      withVault,
    );
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("echo no-chat");
    expect(r.stdout).toContain("suup approve");
    const cards = (await json(["approvals"])) as { id: string }[];
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) await p.suup(["deny", c.id.slice(0, 8)], withVault);
  });

  describe("the vault", () => {
    it("generates a key, and refuses to work without one", async () => {
      const generated = await p.suup(["vault", "key", "generate"]);
      expect(generated.code).toBe(0);
      expect(generated.stdout.trim()).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(generated.stderr).toContain("única vez");
      expect((await json(["vault", "key", "generate"])) as { key: string }).toHaveProperty("key");

      const missing = await p.suup(["vault", "set", "CLI_TOKEN"], { input: VALUE });
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("CLI_TEST_VAULT_KEY");
      expect(missing.stderr).toContain("suup vault key generate");
    });

    it("sets from stdin (never from argv), lists names only, grants and revokes", async () => {
      // The value on the command line is refused: it would be in the shell history.
      const argv = await p.suup(["vault", "set", "CLI_TOKEN", VALUE], withVault);
      expect(argv.code).toBe(2);
      expect(argv.stderr).toContain("Argumento a mais");
      expect(argv.stderr).not.toContain(VALUE);

      const set = await p.suup(
        ["vault", "set", "CLI_TOKEN", "--description", "token da CLI"]
          .slice(0, 3)
          .concat(["--description", "token da CLI", "--bot", "aprova"]),
        {
          ...withVault,
          input: `${VALUE}\n`,
        },
      );
      expect(set.code, set.stdout + set.stderr).toBe(0);
      expect(set.stdout).toContain("CLI_TOKEN");
      expect(set.stdout + set.stderr).not.toContain(VALUE);

      const listed = await p.suup(["vault", "list"], withVault);
      expect(listed.stdout).toContain("CLI_TOKEN");
      expect(listed.stdout).toContain("aprova");
      expect(listed.stdout).toContain("token da CLI");
      expect(
        listed.stdout + (await p.suup(["vault", "list", "--json"], withVault)).stdout,
      ).not.toContain(VALUE);

      expect(
        (await p.suup(["vault", "revoke", "CLI_TOKEN", "--bot", "aprova"], withVault)).stdout,
      ).toContain("não pode mais");
      expect((await p.suup(["vault", "list"], withVault)).stdout).toContain("(nenhum)");
      expect(
        (await p.suup(["vault", "grant", "CLI_TOKEN", "--bot", "aprova"], withVault)).stdout,
      ).toContain("pode usar");
      const missing = await p.suup(["vault", "grant", "NO_SUCH", "--bot", "aprova"], withVault);
      expect(missing.code).toBe(1);
      expect(missing.stderr).toContain("não encontrado");
    });

    it("reads a hidden prompt on a terminal, and an empty value is refused", async () => {
      const typed = await p.suup(["vault", "set", "TYPED_SECRET"], {
        ...withVault,
        tty: true,
        during: async (h) => {
          await h.waitFor("não aparece");
          h.send("typed-secret-value-123");
        },
      });
      expect(typed.code, typed.stdout + typed.stderr).toBe(0);
      expect(typed.stdout).not.toContain("typed-secret-value-123");
      const empty = await p.suup(["vault", "set", "EMPTY_SECRET"], { ...withVault, input: "\n" });
      expect(empty.code).toBe(2);
      const bad = await p.suup(["vault", "set", "lower"], { ...withVault, input: "abcdefgh1" });
      expect(bad.code).toBe(2);
      const short = await p.suup(["vault", "set", "SHORT_ONE"], { ...withVault, input: "short" });
      expect(short.code).toBe(1);
      expect(short.stderr).toContain("pelo menos 8");
    });

    it("a run that uses the secret asks, and nothing the CLI prints holds the value", async () => {
      const r = await p.suup(["run", "CASE-SECRET use", "--bot", "aprova"], withVault);
      const runId = idOf(r);
      expect(r.stdout).toContain("{{secret:CLI_TOKEN}}");
      expect(r.stdout).toContain("usa segredos: CLI_TOKEN");
      const [card] = (await json(["approvals"])) as { id: string }[];
      await p.suup(["approve", prefix(card?.id, 8)], withVault);
      const resumed = await p.suup(["resume", runId], withVault);
      expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
      expect(await statusOf(runId)).toBe("done");

      const outputs = [
        resumed.stdout,
        (await p.suup(["show", runId], withVault)).stdout,
        (await p.suup(["inspect", runId], withVault)).stdout,
        (await p.suup(["inspect", runId, "--json"], withVault)).stdout,
        (await p.suup(["replay", runId], withVault)).stdout,
      ];
      for (const out of outputs) expect(out).not.toContain(VALUE);
      expect(outputs[3]).toContain("[REDACTED:CLI_TOKEN]");
      const [dump] = await p.db.sql<{ all: string }[]>`
        select string_agg(payload::text, ' ') as "all" from run_events where run_id = ${runId}`;
      expect(dump?.all).not.toContain(VALUE);
    });

    it("scrubs text that was written before the secret was known, as it prints it", async () => {
      await p.suup(
        ["memory", "add", "rule", `A chave antiga era later-known-secret-5678`],
        withVault,
      );
      expect((await p.suup(["memory", "list"], withVault)).stdout).toContain(
        "later-known-secret-5678",
      );
      await p.suup(["vault", "set", "LATER_KNOWN"], {
        ...withVault,
        input: "later-known-secret-5678",
      });
      const after = await p.suup(["memory", "list"], withVault);
      expect(after.stdout).not.toContain("later-known-secret-5678");
      expect(after.stdout).toContain("[REDACTED:LATER_KNOWN]");
    });

    it("answers a request_secret with --run: the value goes to the vault, the bot is told it is available", async () => {
      const r = await p.suup(["run", "CASE-ASK pedido", "--bot", "aprova"], withVault);
      const runId = idOf(r);
      expect(await statusOf(runId)).toBe("waiting_user");
      expect(r.stdout).toContain("ASKED_SECRET");
      const wrong = await p.suup(["vault", "set", "OTHER_NAME", "--run", runId.slice(0, 8)], {
        ...withVault,
        input: "some-value-123456",
      });
      expect(wrong.code).toBe(1);
      expect(wrong.stderr).toContain("ASKED_SECRET");
      const answered = await p.suup(["vault", "set", "ASKED_SECRET", "--run", runId.slice(0, 8)], {
        ...withVault,
        input: "asked-secret-value-777",
      });
      expect(answered.code, answered.stdout + answered.stderr).toBe(0);
      expect(answered.stdout).not.toContain("asked-secret-value-777");
      const resumed = await p.suup(["resume", runId], withVault);
      expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
      expect(await statusOf(runId)).toBe("done");
      const result = (await eventsOf(runId)).find((e) => e.type === "tool_result");
      expect(result?.payload.content).toBe(
        "The secret ASKED_SECRET is now available. Use it as {{secret:ASKED_SECRET}}.",
      );
    });

    it("rotates to a new key through the previous-key setting, and removes a secret", async () => {
      const newKey = generateKeyText();
      await p.config({
        approvals: {},
        vault: { keyEnv: "CLI_TEST_VAULT_KEY", previousKeyEnvs: ["CLI_TEST_VAULT_KEY_OLD"] },
      });
      const during = { env: { CLI_TEST_VAULT_KEY: newKey, CLI_TEST_VAULT_KEY_OLD: KEY } };
      const doctor = await p.suup(["doctor"], during);
      expect(doctor.stdout).toContain("Cofre");
      expect(doctor.stdout).toContain("ainda na chave antiga");
      const rotated = await p.suup(["vault", "rotate"], during);
      expect(rotated.code, rotated.stdout + rotated.stderr).toBe(0);
      expect(rotated.stdout).toMatch(/Recifrados: [1-9]/);
      expect((await p.suup(["vault", "rotate"], during)).stdout).toContain("Recifrados: 0");
      // The new key alone is enough now.
      const alone = { env: { CLI_TEST_VAULT_KEY: newKey } };
      expect((await p.suup(["doctor"], alone)).stdout).toContain("legíveis");
      const removed = await p.suup(["vault", "rm", "CLI_TOKEN"], alone);
      expect(removed.code).toBe(0);
      expect((await p.suup(["vault", "rm", "CLI_TOKEN"], alone)).code).toBe(1);
      await p.config({ approvals: {}, vault: { keyEnv: "CLI_TEST_VAULT_KEY" } });
    });
  });

  it("the help lists the new commands", async () => {
    const help = await p.suup(["help"]);
    for (const word of [
      "approvals",
      "approve",
      "deny",
      "rules list",
      "vault set",
      "vault key generate",
    ]) {
      expect(help.stdout, word).toContain(word);
    }
    expect((await p.suup(["vault"])).stderr).toContain("vault set");
    expect((await p.suup(["rules"])).stderr).toContain("rules add");
  });
});
