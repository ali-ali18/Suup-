import { parseArgs } from "node:util";
import { UsageError } from "./errors.js";

export interface OptionSpec {
  type: "string" | "boolean";
  multiple?: boolean;
  /** Name of the value in the help (`--bot <bot>`). */
  value?: string;
  help: string;
}

export const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  config: {
    type: "string",
    value: "arquivo",
    help: "Arquivo de configuração (padrão: SUUP_CONFIG ou ./suup.config.json)",
  },
  json: { type: "boolean", help: "Saída legível por máquina (JSON)" },
  help: { type: "boolean", help: "Mostra esta ajuda" },
};

export interface ParsedArgs {
  positionals: string[];
  values: Record<string, string | boolean | (string | boolean)[] | undefined>;
}

export interface PositionalSpec {
  /** Names for the help, in order, e.g. ["runId"]. A name ending in `?` is optional. */
  names: string[];
}

/** Parses the arguments of one command. Throws `UsageError` (in Portuguese). */
export function parseCommandArgs(
  command: string,
  args: readonly string[],
  options: Record<string, OptionSpec>,
  positionals: PositionalSpec,
): ParsedArgs {
  const all = { ...GLOBAL_OPTIONS, ...options };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...args],
      allowPositionals: true,
      strict: true,
      options: Object.fromEntries(
        Object.entries(all).map(([name, spec]) => [
          name,
          { type: spec.type, ...(spec.multiple === true ? { multiple: true } : {}) },
        ]),
      ),
    });
  } catch (error) {
    throw new UsageError(translateParseError(error), command);
  }
  const required = positionals.names.filter((n) => !n.endsWith("?")).length;
  const max = positionals.names.length;
  if (parsed.positionals.length < required) {
    const missing = positionals.names.slice(parsed.positionals.length, required);
    throw new UsageError(`Falta o argumento ${missing.map((n) => `<${n}>`).join(" ")}.`, command);
  }
  if (parsed.positionals.length > max) {
    // The vault commands never repeat what was typed: it may be the value of a secret.
    throw new UsageError(
      command.startsWith("vault ")
        ? "Argumento a mais. O valor de um segredo não vai na linha de comando (ficaria no histórico do shell): passe-o pela entrada padrão ou digite-o no prompt."
        : `Argumento a mais: ${JSON.stringify(parsed.positionals[max])}. Se o texto tem espaços, coloque-o entre aspas.`,
      command,
    );
  }
  return {
    positionals: parsed.positionals,
    values: parsed.values as ParsedArgs["values"],
  };
}

function translateParseError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string }).code;
  const flag = /'(--?[\w-]+)/.exec(message)?.[1] ?? "";
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") return `Opção desconhecida: ${flag}.`;
  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    if (/ambiguous/i.test(message)) {
      return `A opção ${flag} precisa de um valor (um valor que começa com hífen se escreve ${flag}=-valor).`;
    }
    return /argument missing|requires an argument/i.test(message) ||
      /must be specified with a value/i.test(message)
      ? `A opção ${flag} precisa de um valor.`
      : `Uso inválido da opção ${flag}: ${message}`;
  }
  return message;
}

export function str(args: ParsedArgs, name: string): string | undefined {
  const v = args.values[name];
  return typeof v === "string" ? v : undefined;
}

export function flag(args: ParsedArgs, name: string): boolean {
  return args.values[name] === true;
}

export function list(args: ParsedArgs, name: string): string[] {
  const v = args.values[name];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  return typeof v === "string" ? [v] : [];
}

/** A positive integer option, or `undefined` when absent. */
export function posInt(args: ParsedArgs, name: string, command: string): number | undefined {
  const raw = str(args, name);
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new UsageError(
      `--${name} precisa de um número inteiro positivo (recebido ${JSON.stringify(raw)}).`,
      command,
    );
  }
  return Number(raw);
}
