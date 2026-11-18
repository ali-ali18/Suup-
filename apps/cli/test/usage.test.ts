import { describe, expect, it } from "vitest";
import { COMMANDS, commandHelp, generalHelp } from "../src/index.js";
import { runCli, tempDir } from "./harness.js";

describe("exit codes and usage errors", () => {
  it("help and --help exit 0 and speak Portuguese", async () => {
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const r = await runCli(argv);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Uso: suup");
      expect(r.stdout).toContain("Comandos:");
      expect(r.stdout).toContain("Códigos de saída");
    }
  });

  it("no arguments is a usage error that prints the help on stderr", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("Comandos:");
  });

  it("an unknown command exits 2 and points to the help", async () => {
    const r = await runCli(["frobnicate"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Comando desconhecido: "frobnicate"');
    expect(r.stderr).toContain("suup help");
  });

  it("an unknown option exits 2", async () => {
    const r = await runCli(["runs", "--nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Opção desconhecida: --nope");
    expect(r.stderr).toContain("suup runs --help");
  });

  it("an option that needs a value, without it, exits 2", async () => {
    const r = await runCli(["runs", "--limit"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("A opção --limit precisa de um valor");
  });

  it("missing and extra positional arguments exit 2", async () => {
    const missing = await runCli(["show"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Falta o argumento <execução>");
    const extra = await runCli(["show", "a", "b"]);
    expect(extra.code).toBe(2);
    expect(extra.stderr).toContain("Argumento a mais");
    const run = await runCli(["run", "two", "words", "--bot", "x"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("entre aspas");
  });

  it("checks arguments before touching the configuration or the database", async () => {
    // No configuration file exists in this directory: these must fail as usage errors, not as 1.
    const dir = await tempDir();
    const cases: [string[], string][] = [
      [["bot", "create", "--model", "m"], "Falta --name"],
      [["bot", "create", "--name", "a"], "Falta --model"],
      [
        [
          "bot",
          "create",
          "--name",
          "a",
          "--model",
          "m",
          "--personality",
          "x",
          "--personality-file",
          "f",
        ],
        "não os dois",
      ],
      [
        ["bot", "create", "--name", "a", "--model", "m", "--tools", "shell", "--all-tools"],
        "não os dois",
      ],
      [
        ["bot", "create", "--name", "a", "--model", "m", "--max-turns", "abc"],
        "número inteiro positivo",
      ],
      [["run", "x"], "Falta --bot"],
      [["run", " ", "--bot", "b"], "objetivo está vazio"],
      [["resend", "abc"], "Falta --seq"],
      [["resend", "abc", "--seq", "3", "--times", "101"], "no máximo 100"],
      [["resend", "abc", "--seq", "3", "--times", "0"], "inteiro positivo"],
      [["runs", "--limit", "abc"], "inteiro positivo"],
      [["runs", "--limit", "-3"], "precisa de um valor"],
      [["runs", "--status", "nope"], "Status inválido"],
      [["inspect", "abc", "--type", "nope"], "Tipo de evento desconhecido"],
      [["inspect", "abc", "--from", "x"], "número inteiro"],
      [["say", "abc", "  "], "mensagem está vazia"],
    ];
    for (const [argv, expected] of cases) {
      const r = await runCli(argv, { cwd: dir });
      expect(r.code, argv.join(" ")).toBe(2);
      expect(r.stderr, argv.join(" ")).toContain(expected);
    }
  });

  it("a missing configuration file is a command failure (1) that says what to do", async () => {
    const dir = await tempDir();
    const r = await runCli(["runs"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Arquivo de configuração não encontrado");
    expect(r.stderr).toContain("--config");
  });

  it("an invalid configuration is reported with its issues (1)", async () => {
    const dir = await tempDir();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(`${dir}/suup.config.json`, JSON.stringify({ providers: [] }));
    const r = await runCli(["bot", "list"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Configuração inválida");
    expect(r.stderr).toContain("providers: configure pelo menos um provedor");
  });

  it("--json makes errors machine-readable on stderr", async () => {
    const dir = await tempDir();
    const usage = await runCli(["--json", "runs", "--nope"], { cwd: dir });
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stderr)).toMatchObject({ usage: true });
    const failed = await runCli(["runs", "--json"], { cwd: dir });
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stderr).error).toContain("Arquivo de configuração");
  });

  it("accepts global flags before the command, and the pnpm separator", async () => {
    const dir = await tempDir();
    const r = await runCli(["--", "--config", "nowhere.json", "runs"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("nowhere.json");
  });

  it("a command group alone is a usage error; with --help it lists the subcommands", async () => {
    const bare = await runCli(["bot"]);
    expect(bare.code).toBe(2);
    expect(bare.stderr).toContain("bot create");
    const help = await runCli(["bot", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("bot archive");
  });
});

describe("help texts", () => {
  it("every command has --help with usage, options and global options, in Portuguese", async () => {
    for (const spec of COMMANDS) {
      const r = await runCli([...spec.name.split(" "), "--help"]);
      expect(r.code, spec.name).toBe(0);
      expect(r.stdout).toContain(`Uso: suup ${spec.name}`);
      expect(r.stdout).toContain(spec.summary);
      expect(r.stdout).toContain("--config <arquivo>");
      expect(r.stdout).toContain("--json");
    }
  });

  it("`help <command>` is the same as `<command> --help`", async () => {
    const a = await runCli(["help", "inspect"]);
    const b = await runCli(["inspect", "--help"]);
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain("--request <seq>");
  });

  it("the general help lists every command", () => {
    const text = generalHelp().join("\n");
    for (const spec of COMMANDS) expect(text).toContain(spec.name);
  });

  it("the commands of the brief all exist", () => {
    const names = COMMANDS.map((c) => c.name);
    for (const expected of [
      "db migrate",
      "doctor",
      "bot create",
      "bot list",
      "bot show",
      "bot archive",
      "run",
      "worker",
      "runs",
      "show",
      "say",
      "stop",
      "resume",
      "inspect",
      "replay",
      "resend",
    ]) {
      expect(names).toContain(expected);
    }
    expect(commandHelp(COMMANDS[0] as (typeof COMMANDS)[number]).length).toBeGreaterThan(3);
  });

  it("an unknown command in help is a usage error", async () => {
    const r = await runCli(["help", "nope"]);
    expect(r.code).toBe(2);
  });
});
