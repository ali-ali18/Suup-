import { type DoctorCheck, runDoctorChecks } from "@suup/runtime";
import { flag } from "../args.js";
import type { CommandSpec, Ctx } from "../context.js";
import { EXIT_FAILED, EXIT_OK } from "../errors.js";

export type Check = DoctorCheck;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const doctorCommand: CommandSpec = {
  name: "doctor",
  summary:
    "Confere a saúde de cada componente: configuração, banco, sandbox, provedores e ferramentas",
  options: {
    live: {
      type: "boolean",
      help: "Faz uma chamada minúscula de verdade a cada modelo configurado (gasta alguns tokens)",
    },
  },
  positionals: { names: [] },
  notes: [
    "Uma linha por componente, com ok ou falha e o motivo. Código de saída 1 se algo falhou.",
  ],
  async run(ctx) {
    const checks: Check[] = [];
    try {
      const loaded = ctx.config();
      checks.push({ component: "Configuração", ok: true, detail: `válida (${loaded.path})` });
    } catch (error) {
      checks.push({ component: "Configuração", ok: false, detail: message(error) });
      return report(ctx, checks);
    }
    checks.push(...(await runDoctorChecks(ctx.runtime(), { live: flag(ctx.args, "live") })));
    return report(ctx, checks);
  },
};

function report(ctx: Ctx, checks: Check[]): number {
  const failed = checks.filter((c) => !c.ok).length;
  if (ctx.json) {
    ctx.out.data({ ok: failed === 0, checks });
  } else {
    const width = Math.max(...checks.map((c) => c.component.length));
    for (const c of checks) {
      const [first = "", ...rest] = c.detail.split("\n");
      ctx.out.line(`${c.ok ? "[ok]   " : "[falha]"} ${c.component.padEnd(width)}  ${first}`);
      for (const line of rest) ctx.out.line(`${" ".repeat(width + 10)}${line}`);
    }
    ctx.out.line("");
    ctx.out.line(
      failed === 0 ? "Tudo certo." : `${failed} componente${failed === 1 ? "" : "s"} com falha.`,
    );
  }
  return failed === 0 ? EXIT_OK : EXIT_FAILED;
}
