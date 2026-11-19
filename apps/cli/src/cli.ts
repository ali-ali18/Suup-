import { GLOBAL_OPTIONS, type OptionSpec, parseCommandArgs } from "./args.js";
import { approvalsCommand, approveCommand, denyCommand } from "./commands/approvals.js";
import { botArchive, botCreate, botDraft, botList, botShow } from "./commands/bot.js";
import { chatCommand } from "./commands/chat.js";
import {
  connectorsAdd,
  connectorsDisable,
  connectorsEnable,
  connectorsGrant,
  connectorsList,
  connectorsRemove,
  connectorsRevoke,
  connectorsSetRisk,
  connectorsTest,
  connectorsTools,
} from "./commands/connectors.js";
import { dbMigrate } from "./commands/db.js";
import { doctorCommand } from "./commands/doctor.js";
import { evalCommand, evalHistory, evalList } from "./commands/eval.js";
import { inspectCommand } from "./commands/inspect.js";
import {
  memoryAdd,
  memoryEdit,
  memoryForget,
  memoryList,
  memoryRestore,
  memorySearch,
} from "./commands/memory.js";
import { sayCommand, stopCommand } from "./commands/messages.js";
import { replayCommand } from "./commands/replay.js";
import { resendCommand } from "./commands/resend.js";
import { rulesAdd, rulesEdit, rulesList, rulesRemove } from "./commands/rules.js";
import { resumeCommand, runCommand } from "./commands/run.js";
import { runsCommand, showCommand } from "./commands/runs.js";
import { serverCommand } from "./commands/server.js";
import {
  vaultGrant,
  vaultKeyGenerate,
  vaultList,
  vaultRemove,
  vaultRevoke,
  vaultRotate,
  vaultSet,
} from "./commands/vault.js";
import { workerCommand } from "./commands/worker.js";
import { type CommandSpec, makeCtx } from "./context.js";
import { CommandError, EXIT_FAILED, EXIT_OK, EXIT_USAGE, UsageError } from "./errors.js";
import type { CliIo } from "./io.js";

export const COMMANDS: readonly CommandSpec[] = [
  dbMigrate,
  doctorCommand,
  botCreate,
  botList,
  botShow,
  botArchive,
  botDraft,
  chatCommand,
  memoryList,
  memoryAdd,
  memoryEdit,
  memoryForget,
  memoryRestore,
  memorySearch,
  approvalsCommand,
  approveCommand,
  denyCommand,
  rulesList,
  rulesAdd,
  rulesEdit,
  rulesRemove,
  vaultSet,
  vaultList,
  vaultRemove,
  vaultGrant,
  vaultRevoke,
  vaultRotate,
  vaultKeyGenerate,
  connectorsList,
  connectorsAdd,
  connectorsRemove,
  connectorsEnable,
  connectorsDisable,
  connectorsGrant,
  connectorsRevoke,
  connectorsTools,
  connectorsSetRisk,
  connectorsTest,
  runCommand,
  workerCommand,
  serverCommand,
  runsCommand,
  showCommand,
  sayCommand,
  stopCommand,
  resumeCommand,
  inspectCommand,
  replayCommand,
  resendCommand,
  evalCommand,
  evalList,
  evalHistory,
];

const GROUPS: Record<string, string> = {
  db: "Banco de dados",
  bot: "Bots",
  memory: "Memória",
  rules: "Regras de aprovação",
  vault: "Cofre de segredos",
  connectors: "Conectores MCP",
};

function usageLine(spec: CommandSpec): string {
  const positionals = spec.positionals.names.map((n) =>
    n.endsWith("?") ? `[${n.slice(0, -1)}]` : `<${n}>`,
  );
  const options = Object.entries(spec.options).map(
    ([name, o]) => `[--${name}${o.type === "string" ? ` <${o.value ?? "valor"}>` : ""}]`,
  );
  return `suup ${[spec.name, ...positionals, ...options].join(" ")}`;
}

function optionRows(options: Record<string, OptionSpec>): string[] {
  const rows = Object.entries(options).map(
    ([name, o]) =>
      [`--${name}${o.type === "string" ? ` <${o.value ?? "valor"}>` : ""}`, o.help] as const,
  );
  const width = Math.max(0, ...rows.map(([left]) => left.length));
  return rows.map(([left, help]) => `  ${left.padEnd(width)}  ${help}`);
}

export function generalHelp(): string[] {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    "suup — harness de bots: cria bots, roda execuções e ajuda a entender o que deu errado.",
    "",
    "Uso: suup [--config <arquivo>] [--json] <comando> [opções]",
    "",
    "Comandos:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    `  ${"help".padEnd(width)}  Mostra esta ajuda (ou a de um comando: suup help <comando>)`,
    "",
    "Opções globais (valem em todos os comandos):",
    ...optionRows(GLOBAL_OPTIONS),
    "",
    "Códigos de saída: 0 deu certo, 1 o comando falhou, 2 uso incorreto da linha de comando.",
    "Ajuda de um comando: suup <comando> --help   ·   configuração: docs/CONFIGURACAO.md   ·   diagnóstico: docs/DIAGNOSTICO.md",
  ];
}

export function commandHelp(spec: CommandSpec): string[] {
  return [
    `Uso: ${usageLine(spec)}`,
    "",
    spec.summary,
    ...(Object.keys(spec.options).length === 0 ? [] : ["", "Opções:", ...optionRows(spec.options)]),
    "",
    "Opções globais:",
    ...optionRows(GLOBAL_OPTIONS),
    ...(spec.notes === undefined ? [] : ["", ...spec.notes]),
  ];
}

function groupHelp(group: string): string[] {
  const inGroup = COMMANDS.filter((c) => c.name.startsWith(`${group} `));
  const width = Math.max(...inGroup.map((c) => c.name.length));
  return [
    `${GROUPS[group] ?? group}: subcomandos de "suup ${group}":`,
    "",
    ...inGroup.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    "",
    `Ajuda de um deles: suup ${group} <subcomando> --help`,
  ];
}

/** Finds the command named by the leading words, and the index where its arguments start. */
function resolveCommand(
  words: readonly string[],
): { spec: CommandSpec; consumed: number } | { group: string } | undefined {
  const [first, second, third] = words;
  if (first === undefined) return undefined;
  const three =
    second === undefined || third === undefined
      ? undefined
      : COMMANDS.find((c) => c.name === `${first} ${second} ${third}`);
  if (three !== undefined) return { spec: three, consumed: 3 };
  const two =
    second === undefined ? undefined : COMMANDS.find((c) => c.name === `${first} ${second}`);
  if (two !== undefined) return { spec: two, consumed: 2 };
  const one = COMMANDS.find((c) => c.name === first);
  if (one !== undefined) return { spec: one, consumed: 1 };
  if (first in GROUPS) return { group: first };
  return undefined;
}

function friendlyError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "ECONNRESET") {
    return `Não foi possível conectar ao banco de dados (${message}). Confira DATABASE_URL e se o Postgres está no ar (docker compose up -d --wait).`;
  }
  if (code === "28P01" || code === "28000")
    return `O banco recusou a autenticação (${message}). Confira usuário e senha em DATABASE_URL.`;
  if (code === "3D000") return `O banco de dados da DATABASE_URL não existe (${message}).`;
  if (code === "42P01") return `${message}. As tabelas não existem: rode suup db migrate.`;
  return message;
}

/**
 * The entry point. Returns the exit code: 0 ok, 1 the command failed, 2 usage error. Everything
 * it prints goes through `io`, so tests call it directly.
 */
export async function main(rawArgv: readonly string[], io: CliIo): Promise<number> {
  // `pnpm suup -- <args>` hands over the separator too.
  const argv = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  const stdoutLines = (lines: readonly string[]) => io.stdout.write(`${lines.join("\n")}\n`);
  const closers: (() => Promise<void>)[] = [];
  let json = false;
  // What is printed for a failure is scrubbed of the vault's values like everything else.
  let scrub = (text: string): string => text;
  try {
    // Global flags may come before the command word: `suup --json runs`.
    let i = 0;
    while (i < argv.length) {
      const a = argv[i] as string;
      if (a === "--config") i += 2;
      else if (a.startsWith("-")) i += 1;
      else break;
    }
    const words = argv.slice(i);
    const wantsHelp = argv.includes("--help") || argv.includes("-h");
    json = argv.includes("--json");

    if (words[0] === "help") {
      const target = resolveCommand(words.slice(1));
      if (target === undefined && words.length > 1)
        throw new UsageError(`Comando desconhecido: ${JSON.stringify(words.slice(1).join(" "))}.`);
      stdoutLines(
        target === undefined
          ? generalHelp()
          : "group" in target
            ? groupHelp(target.group)
            : commandHelp(target.spec),
      );
      return EXIT_OK;
    }
    if (words.length === 0) {
      if (wantsHelp) {
        stdoutLines(generalHelp());
        return EXIT_OK;
      }
      io.stderr.write(`${generalHelp().join("\n")}\n`);
      return EXIT_USAGE;
    }
    const target = resolveCommand(words);
    if (target === undefined) {
      throw new UsageError(
        `Comando desconhecido: ${JSON.stringify(words[0])}. Veja os comandos com: suup help`,
      );
    }
    if ("group" in target) {
      if (wantsHelp) {
        stdoutLines(groupHelp(target.group));
        return EXIT_OK;
      }
      io.stderr.write(`${groupHelp(target.group).join("\n")}\n`);
      return EXIT_USAGE;
    }
    const { spec, consumed } = target;
    if (wantsHelp) {
      stdoutLines(commandHelp(spec));
      return EXIT_OK;
    }
    const args = parseCommandArgs(
      spec.name,
      [...argv.slice(0, i), ...words.slice(consumed)],
      spec.options,
      spec.positionals,
    );
    const ctx = makeCtx(io, spec.name, args, closers);
    scrub = (text) => ctx.out.scrub(text);
    // Whatever the command prints is scrubbed of the vault's values (when there is a vault).
    await ctx.primeRedaction();
    return await spec.run(ctx);
  } catch (error) {
    return reportError(io, error, json, scrub);
  } finally {
    for (const close of closers) {
      try {
        await close();
      } catch {
        // closing is best effort
      }
    }
  }
}

function reportError(
  rawIo: CliIo,
  error: unknown,
  json: boolean,
  scrub: (text: string) => string,
): number {
  const io: CliIo = {
    ...rawIo,
    stderr: { write: (chunk: string) => rawIo.stderr.write(scrub(chunk)) },
  };
  if (error instanceof UsageError) {
    if (json) io.stderr.write(`${JSON.stringify({ error: error.message, usage: true })}\n`);
    else {
      io.stderr.write(`suup: ${error.message}\n`);
      io.stderr.write(
        `Ajuda: suup ${error.command === undefined ? "help" : `${error.command} --help`}\n`,
      );
    }
    return EXIT_USAGE;
  }
  const text =
    error instanceof CommandError || isKnown(error)
      ? (error as Error).message
      : friendlyError(error);
  if (json) io.stderr.write(`${JSON.stringify({ error: text })}\n`);
  else io.stderr.write(`suup: ${text}\n`);
  if (io.env.SUUP_DEBUG !== undefined && error instanceof Error && error.stack !== undefined) {
    io.stderr.write(`${error.stack}\n`);
  }
  return EXIT_FAILED;
}

function isKnown(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "ConfigError" || name === "RuntimeError" || name === "CommandError";
}
