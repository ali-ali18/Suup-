import { resolve } from "node:path";
import { createRuntime, type LoadedConfig, loadConfig, type Runtime } from "@suup/runtime";
import type { OptionSpec, ParsedArgs, PositionalSpec } from "./args.js";
import { flag, str } from "./args.js";
import type { CliIo } from "./io.js";

/** Writes what the command prints. In `--json` mode only data goes to stdout. */
export class Output {
  /** Scrubs what is about to be printed of known secret values (set once a runtime exists). */
  scrub: (text: string) => string = (text) => text;

  constructor(
    readonly io: CliIo,
    readonly json: boolean,
  ) {}

  /** A line for the person (not printed in `--json` mode, where stdout carries data only). */
  line(text = ""): void {
    if (!this.json) this.io.stdout.write(`${this.scrub(text)}\n`);
  }

  lines(texts: readonly string[]): void {
    for (const text of texts) this.line(text);
  }

  /** Text without a trailing newline (a prompt). */
  raw(text: string): void {
    if (!this.json) this.io.stdout.write(this.scrub(text));
  }

  /** Data for machines: one JSON document (pretty) on stdout. */
  data(value: unknown): void {
    this.io.stdout.write(`${this.scrub(JSON.stringify(value, null, 2))}\n`);
  }

  /** One JSON document on one line (streams). */
  ndjson(value: unknown): void {
    this.io.stdout.write(`${this.scrub(JSON.stringify(value))}\n`);
  }

  /** A diagnostic for the person, on stderr. */
  err(text: string): void {
    this.io.stderr.write(`${this.scrub(text)}\n`);
  }

  warn(text: string): void {
    this.err(`AVISO: ${text}`);
  }
}

export interface Ctx {
  io: CliIo;
  out: Output;
  json: boolean;
  command: string;
  args: ParsedArgs;
  /** Reads the configuration (throws `ConfigError`). */
  config(): LoadedConfig;
  /** The runtime for this invocation; closed when the command ends. */
  runtime(): Runtime;
  /**
   * Loads the vault's values so that everything this command prints is scrubbed of them. Call it
   * before printing run events, messages or anything else a secret could have got into. Does
   * nothing (and never fails) when there is no usable vault.
   */
  primeRedaction(): Promise<void>;
}

export interface CommandSpec {
  /** "bot create" */
  name: string;
  summary: string;
  options: Record<string, OptionSpec>;
  positionals: PositionalSpec;
  /** Free text for `--help`: examples, notes. */
  notes?: string[];
  run(ctx: Ctx): Promise<number>;
}

export function makeCtx(
  io: CliIo,
  command: string,
  args: ParsedArgs,
  closers: (() => Promise<void>)[],
): Ctx {
  const json = flag(args, "json");
  let loaded: LoadedConfig | undefined;
  let runtime: Runtime | undefined;
  const out = new Output(io, json);
  const config = (): LoadedConfig => {
    loaded ??= loadConfig({ path: str(args, "config"), env: io.env, cwd: io.cwd });
    return loaded;
  };
  return {
    io,
    out,
    json,
    command,
    args,
    config,
    runtime() {
      if (runtime === undefined) {
        const { config: cfg, baseDir } = config();
        runtime = createRuntime(cfg, {
          env: io.env,
          baseDir,
          // What only the logs need (the app keeps stderr in its log files).
          log: (message) => out.err(message),
        });
        const made = runtime;
        out.scrub = (text) => made.redactor.redact(text);
        closers.push(() => made.close());
      }
      return runtime;
    },
    async primeRedaction() {
      try {
        // Without a vault in the configuration there is nothing to scrub (and no reason to open
        // the database just for this).
        if (config().config.vault === undefined) return;
        await this.runtime().vault.refresh();
      } catch {
        // No database or no key: there is nothing the vault could have put anywhere.
      }
    },
  };
}

/** Prints the warning about the machine without isolation, when that is what the config uses. */
export function warnIfLocalSandbox(ctx: Ctx): void {
  const { config, baseDir } = ctx.config();
  if (config.sandbox.kind === "local") {
    ctx.out.warn(
      `sandbox LOCAL em uso (${resolve(baseDir, config.sandbox.root)}): os comandos dos bots rodam diretamente neste computador, SEM isolamento. Use só com tarefas e dados em que você confia; para uso real, configure o sandbox "docker".`,
    );
  }
}
