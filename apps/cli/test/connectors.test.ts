import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeServerCommand } from "@suup/connectors/testing";
import { generateKeyText } from "@suup/runtime";
import { describe, expect, it, vi } from "vitest";
import { DATABASE_URL, dbSuiteName, type Result, useProject } from "./harness.js";

// Connectors through the real `main`: `suup connectors ...` with the real runtime, the scripted
// provider, the vault and the fake MCP server as a child process.

vi.setConfig({ testTimeout: 60_000 });

const VALUE = "cli_conn_9f8e7d6c5b4a3210";
const KEY = generateKeyText();
const call = (name: string, args: unknown) => ({ calls: [{ name, args }] });

describe.skipIf(!DATABASE_URL)(dbSuiteName("suup connectors, end to end"), () => {
  const p = useProject();
  const withVault = { env: { CLI_TEST_VAULT_KEY: KEY } };
  const server = fakeServerCommand();
  const log = () => join(p.dir, "connector-calls.log");
  const calls = (): string[] => {
    try {
      return readFileSync(log(), "utf8").trim().split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const idOf = (r: Result): string => {
    const id = /Execução ([0-9a-f-]{36}) criada/.exec(r.stdout)?.[1];
    if (id === undefined) throw new Error(`no run id:\n${r.stdout}`);
    return id;
  };
  const ok = async (argv: string[], options = withVault): Promise<Result> => {
    const r = await p.suup(argv, options);
    expect(r.code, `${argv.join(" ")}\n${r.stdout}${r.stderr}`).toBe(0);
    return r;
  };

  it("setup: migrate, a secret, a bot, a script", async () => {
    // These tests script direct calls of the fake server's 17 tools: the tool search is off here (it has its own tests).
    await p.config({
      approvals: {},
      vault: { keyEnv: "CLI_TEST_VAULT_KEY" },
      toolSearch: { minTools: 1000, minDefinitionTokens: 1_000_000 },
    });
    await p.suup(["db", "migrate"]);
    await ok(["vault", "set", "FAKE_API", "--description", "token do servidor de teste"], {
      ...withVault,
      input: `${VALUE}\n`,
    } as never);
    await ok([
      "bot",
      "create",
      "--name",
      "conectado",
      "--model",
      "model-x",
      "--tools",
      "read_file",
    ]);
    await p.script("roteiro.json", {
      cases: [
        {
          whenObjectiveContains: "CASE-CONN",
          agent: [
            call("conn_fake__needs_secret", {}),
            call("conn_fake__write_thing", { name: "nota", body: "oi" }),
            { text: "Feito." },
          ],
        },
        {
          whenObjectiveContains: "CASE-MAIL",
          agent: [
            call("conn_fake__send_email", {
              to: "ana@exemplo.com",
              subject: "Oi",
              body: "Tudo bem?",
            }),
            { text: "Enviei." },
          ],
        },
      ],
    });
    await p.script("outro.json", { agent: [] });
  });

  it("add: a program with a secret in its environment, one tool marked as a read, and a bot", async () => {
    const r = await ok([
      "connectors",
      "add",
      "fake",
      "--command",
      server.command,
      ...server.args.map((a) => `--arg=${a}`),
      "--env",
      `FAKE_LOG=${log()}`,
      "--env-secret",
      "FAKE_TOKEN=FAKE_API",
      "--read",
      "needs_secret",
      "--bot",
      "conectado",
      "--description",
      "servidor de teste",
    ]);
    expect(r.stdout).toContain("Conector fake adicionado");
    // The honest warning about where it runs.
    expect(r.stderr).toContain("fora da máquina isolada dos bots");
    expect(r.stdout).toContain("suup connectors test fake");

    const listed = await ok(["connectors", "list"]);
    expect(listed.stdout).toContain("fake");
    expect(listed.stdout).toContain("processo no host");
    expect(listed.stdout).toContain("conectado");
    expect(listed.stdout).toContain("(ainda não listadas)");
    const json = JSON.parse((await ok(["connectors", "list", "--json"])).stdout) as {
      name: string;
      secretNames: string[];
      transport: { env: Record<string, unknown> };
    }[];
    expect(json[0]?.secretNames).toEqual(["FAKE_API"]);
    expect(json[0]?.transport.env.FAKE_TOKEN).toEqual({ secret: "FAKE_API" });
    expect(JSON.stringify(json)).not.toContain(VALUE);
  });

  it("add: refuses what is unsafe or unclear, with a message that says why", async () => {
    const both = await p.suup(
      ["connectors", "add", "x", "--command", "a", "--url", "https://x.example"],
      withVault,
    );
    expect(both.code).toBe(2);
    expect(both.stderr).toContain("um dos dois");
    const neither = await p.suup(["connectors", "add", "x"], withVault);
    expect(neither.code).toBe(2);
    const shell = await p.suup(
      ["connectors", "add", "x", "--command", "bash", "--arg=-c", "--arg=echo hi"],
      withVault,
    );
    expect(shell.code).toBe(1);
    expect(shell.stderr).toContain("interpolação");
    const noTls = await p.suup(
      ["connectors", "add", "x", "--url", "http://example.com/mcp"],
      withVault,
    );
    expect(noTls.code).toBe(1);
    expect(noTls.stderr).toContain("https");
    const missing = await p.suup(
      ["connectors", "add", "x", "--url", "https://example.com/mcp", "--bearer", "NOT_THERE"],
      withVault,
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("NOT_THERE");
    expect(missing.stderr).toContain("suup vault set NOT_THERE");
    const dup = await p.suup(["connectors", "add", "fake", "--command", server.command], withVault);
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("Já existe");
    const badSecret = await p.suup(
      ["connectors", "add", "x", "--url", "https://example.com/mcp", "--bearer", "lower"],
      withVault,
    );
    expect(badSecret.code).toBe(2);
  });

  it("test and tools: start the server from scratch and show each tool with its risk and why", async () => {
    const tested = await ok(["connectors", "test", "fake"]);
    expect(tested.stdout).toContain("fake-server 1.2.3");
    expect(tested.stdout).toContain("conn_fake__needs_secret");
    expect(tested.stdout).toContain("leitura");
    expect(tested.stdout).toContain("definido por você");
    expect(tested.stdout).toContain("conn_fake__write_thing");
    expect(tested.stdout).toContain("externa/irreversível (pergunta)");
    expect(tested.stdout).toContain("não: ");

    const tools = await ok(["connectors", "tools", "fake"]);
    expect(tools.stdout).toContain("suup connectors set-risk");
    const json = JSON.parse((await ok(["connectors", "tools", "fake", "--json"])).stdout) as {
      tool: string;
      risk: string;
      available: boolean;
    }[];
    expect(json.find((t) => t.tool === "write_thing")).toMatchObject({
      risk: "external_irreversible",
      available: true,
    });
    expect(json.find((t) => t.tool === "recursive")?.available).toBe(false);
    expect((await ok(["connectors", "list"])).stdout).not.toContain("(ainda não listadas)");
  });

  it("a bot uses it: the read runs, the write stops at a card, approve, resume, replay", async () => {
    const r = await ok(["run", "CASE-CONN faça", "--bot", "conectado"]);
    const runId = idOf(r);
    expect(r.stdout).toContain("espera a sua aprovação");
    expect(r.stdout).toContain("Conector fake → write_thing");
    expect(calls()).toEqual([]);
    const cards = JSON.parse((await ok(["approvals", "--json"])).stdout) as {
      id: string;
      runId: string;
      tool: string;
    }[];
    const card = cards.find((c) => c.runId === runId);
    expect(card?.tool).toBe("conn_fake__write_thing");
    await ok(["approve", (card?.id ?? "").slice(0, 8)]);
    await ok(["resume", runId]);
    expect(calls()).toEqual(['write_thing {"name":"nota","body":"oi"}']);

    const summary = await ok(["show", runId]);
    expect(summary.stdout).toContain("Definições de ferramentas por pedido:");
    expect(summary.stdout).toContain("modo direct");
    const shown = await ok(["inspect", runId, "--json"]);
    expect(shown.stdout).toContain("[REDACTED:FAKE_API]");
    expect(shown.stdout).not.toContain(VALUE);
    const replayed = await ok(["replay", runId]);
    expect(replayed.stdout).toContain("IDÊNTICO");
  });

  it("set-outbound: only the user marks a tool as a message to another person; its card then allows the recipient", async () => {
    const unmarked = JSON.parse((await ok(["connectors", "tools", "fake", "--json"])).stdout) as {
      tool: string;
      outbound?: unknown;
    }[];
    expect(unmarked.find((t) => t.tool === "send_email")?.outbound).toBeUndefined();
    expect(
      (await p.suup(["connectors", "set-outbound", "fake", "send_email"], withVault)).code,
    ).toBe(2);
    expect(
      (
        await p.suup(
          ["connectors", "set-outbound", "fake", "send_email", "--to", "to", "--none"],
          withVault,
        )
      ).code,
    ).toBe(2);
    const marked = await ok(["connectors", "set-outbound", "fake", "send_email", "--to", "to"]);
    expect(marked.stdout).toContain("mensagem a outra pessoa");
    const tools = await ok(["connectors", "tools", "fake"]);
    expect(tools.stdout).toContain("a outra pessoa (to)");

    const first = await ok(["run", "CASE-MAIL primeiro", "--bot", "conectado"]);
    expect(first.stdout).toContain("espera a sua aprovação");
    expect(first.stdout).toContain("suup approve");
    expect(first.stdout).toContain("--allow-recipient");
    const cards = JSON.parse((await ok(["approvals", "--json"])).stdout) as {
      id: string;
      runId: string;
      outbound: { kind: string; recipientFields: string[] } | null;
    }[];
    const card = cards.find((c) => c.runId === idOf(first));
    expect(card?.outbound).toEqual({ kind: "message", recipientFields: ["to"] });
    const approved = await ok(["approve", (card?.id ?? "").slice(0, 8), "--allow-recipient"]);
    expect(approved.stdout).toContain("Regra criada");
    await ok(["resume", idOf(first)]);
    expect(calls().filter((c) => c.startsWith("send_email")).length).toBe(1);

    const rules = JSON.parse((await ok(["rules", "list", "--json"])).stdout) as {
      id: string;
      tool: string;
      createdBy: string;
      matchers: unknown[];
    }[];
    const made = rules.find((r) => r.tool === "conn_fake__send_email");
    expect(made).toMatchObject({
      createdBy: "approval",
      matchers: [{ field: "to", value: "ana@exemplo.com" }],
    });
    // The same recipient now goes without a card.
    const again = await ok(["run", "CASE-MAIL segundo", "--bot", "conectado"]);
    expect(again.stdout).not.toContain("espera a sua aprovação");
    expect(calls().filter((c) => c.startsWith("send_email")).length).toBe(2);

    await ok(["rules", "rm", (made?.id ?? "").slice(0, 8)]);
    expect(
      (await ok(["connectors", "set-outbound", "fake", "send_email", "--none"])).stdout,
    ).toContain("não é mais");
  });

  it("grant by tool (--tools, --read-only, --all), review of a changed definition, and doctor", async () => {
    const tweak = join(p.dir, "cli-tweak.txt");
    await ok([
      "connectors",
      "add",
      "pins",
      "--command",
      server.command,
      ...server.args.map((a) => `--arg=${a}`),
      "--env",
      `FAKE_TWEAK=${tweak}`,
      "--env-secret",
      "FAKE_TOKEN=FAKE_API",
      "--read",
      "echo",
    ]);
    // A grant needs a choice: exactly one of --tools, --all, --read-only.
    const none = await p.suup(["connectors", "grant", "pins", "--bot", "conectado"], withVault);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("exatamente uma destas opções");
    const two = await p.suup(
      ["connectors", "grant", "pins", "--bot", "conectado", "--all", "--tools", "echo"],
      withVault,
    );
    expect(two.code).toBe(2);

    const some = await ok([
      "connectors",
      "grant",
      "pins",
      "--bot",
      "conectado",
      "--tools",
      "echo,typed",
    ]);
    expect(some.stdout).toContain("só estas ferramentas do conector pins: echo, typed");
    expect((await ok(["connectors", "list"])).stdout).toContain("conectado (2 ferramenta(s))");
    const bad = await p.suup(
      ["connectors", "grant", "pins", "--bot", "conectado", "--tools", "echo,nao_existe"],
      withVault,
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stderr + bad.stdout).toContain("nao_existe");

    // --read-only fixes the list of the tools marked as reads right now.
    const reads = await ok(["connectors", "grant", "pins", "--bot", "conectado", "--read-only"]);
    expect(reads.stdout).toContain("só estas ferramentas do conector pins:");
    expect(reads.stdout).toContain("echo");
    expect(reads.stdout).not.toContain("write_thing");

    await ok(["connectors", "grant", "pins", "--bot", "conectado", "--all"]);
    expect((await ok(["connectors", "list"])).stdout).toContain("conectado (todas)");

    // The doctor says what the bot carries per request.
    const before = await p.suup(["doctor"], withVault);
    expect(before.stdout).toContain("Ferramentas do bot conectado");
    expect(before.stdout).toMatch(/embutidas e de controle, \d+ de conectores concedidas/);

    // The server changes a definition: it is off until reviewed, doctor warns, review shows both.
    expect((await ok(["connectors", "review", "pins"])).stdout).toContain("Nenhuma ferramenta");
    writeFileSync(tweak, "NOVA DESCRIÇÃO do servidor.");
    await ok(["connectors", "test", "pins"]);
    const shown = await ok(["connectors", "review", "pins"]);
    expect(shown.stdout).toContain("echo: a definição MUDOU depois de aprovada");
    expect(shown.stdout).toContain("Returns the text it was given.");
    expect(shown.stdout).toContain("NOVA DESCRIÇÃO do servidor.");
    expect((await ok(["connectors", "tools", "pins"])).stdout).toContain(
      "MUDOU: desligada até revisar",
    );
    const warned = await p.suup(["doctor"], withVault);
    expect(warned.stdout).toContain("esperando revisão e desligadas para todos os bots");
    expect(warned.code).toBe(1);

    // Approving needs the fingerprint that was shown.
    const blind = await p.suup(["connectors", "review", "pins", "--approve", "echo"], withVault);
    expect(blind.code).toBe(2);
    const fingerprint = /--fingerprint ([0-9a-f]{12})/.exec(shown.stdout)?.[1] ?? "";
    expect(fingerprint).toHaveLength(12);
    const wrong = await p.suup(
      ["connectors", "review", "pins", "--approve", "echo", "--fingerprint", "deadbeefdead"],
      withVault,
    );
    expect(wrong.code).toBe(2);
    expect(
      (
        await ok([
          "connectors",
          "review",
          "pins",
          "--approve",
          "echo",
          "--fingerprint",
          fingerprint,
        ])
      ).stdout,
    ).toContain("Definição aprovada");
    expect((await ok(["connectors", "review", "pins"])).stdout).toContain("Nenhuma ferramenta");
    await ok(["connectors", "rm", "pins"]);
  });

  it("set-risk, disable, enable, revoke, grant and rm", async () => {
    const risks = async () =>
      new Map(
        (
          JSON.parse((await ok(["connectors", "tools", "fake", "--json"])).stdout) as {
            tool: string;
            risk: string;
            riskBasis: string;
          }[]
        ).map((t) => [t.tool, t]),
      );
    expect((await risks()).get("typed")).toMatchObject({ risk: "external_irreversible" });
    const marked = await ok(["connectors", "set-risk", "fake", "typed", "read"]);
    expect(marked.stdout).toContain("typed: leitura");
    expect((await risks()).get("typed")).toMatchObject({ risk: "read", riskBasis: "user" });
    // The server says this one is destructive: marking it as a read does not make it run unasked.
    await ok(["connectors", "set-risk", "fake", "contradicted", "read"]);
    expect((await risks()).get("contradicted")).toMatchObject({
      risk: "external_irreversible",
      riskBasis: "tightened_by_hint",
    });
    // Back to the default.
    await ok(["connectors", "set-risk", "fake", "typed", "default"]);
    expect((await risks()).get("typed")).toMatchObject({ risk: "external_irreversible" });
    const bad = await p.suup(["connectors", "set-risk", "fake", "typed", "free"], withVault);
    expect(bad.code).toBe(2);

    expect((await ok(["connectors", "disable", "fake"])).stdout).toContain("desligado");
    expect((await ok(["connectors", "list"])).stdout).toContain("desligado");
    expect((await ok(["connectors", "enable", "fake"])).stdout).toContain("ligado");
    expect((await ok(["connectors", "revoke", "fake", "--bot", "conectado"])).stdout).toContain(
      "não vê mais",
    );
    expect(
      (await ok(["connectors", "grant", "fake", "--bot", "conectado", "--all"])).stdout,
    ).toContain("pode usar");
    const noBot = await p.suup(["connectors", "grant", "fake"], withVault);
    expect(noBot.code).toBe(2);

    const doctor = await p.suup(["doctor"], withVault);
    expect(doctor.stdout).toContain("Conector fake");

    expect((await ok(["connectors", "rm", "fake"])).stdout).toContain("removido");
    const gone = await p.suup(["connectors", "tools", "fake"], withVault);
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain("Conector não encontrado");
    expect((await ok(["connectors", "list"])).stdout).toContain("Nenhum conector");
  });

  it("test names the connector when the program does not exist", async () => {
    await ok(["connectors", "add", "ghost", "--command", "/nonexistent/binary"]);
    const r = await p.suup(["connectors", "test", "ghost"], withVault);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('Conector "ghost"');
    expect(r.stdout).toContain("FALHOU");
    const doctor = await p.suup(["doctor"], withVault);
    expect(doctor.stdout).toContain("Conector ghost");
    expect(doctor.code).toBe(1);
  });
});
