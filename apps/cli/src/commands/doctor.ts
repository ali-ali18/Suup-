import { resolve } from "node:path";
import { generateAndCollect } from "@suup/core";
import { migrationStatus } from "@suup/db";
import { loadScript } from "@suup/runtime";
import { flag } from "../args.js";
import type { CommandSpec, Ctx } from "../context.js";
import { EXIT_FAILED, EXIT_OK } from "../errors.js";
import { formatDuration } from "../format.js";

export interface Check {
  component: string;
  ok: boolean;
  detail: string;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

async function guarded(component: string, fn: () => Promise<Check[] | Check>): Promise<Check[]> {
  try {
    const result = await fn();
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    return [{ component, ok: false, detail: message(error).split("\n")[0] ?? "erro" }];
  }
}

async function checkDatabase(ctx: Ctx): Promise<Check> {
  const db = ctx.runtime().db;
  await db.sql`select 1`;
  const status = await migrationStatus(db);
  if (status.pending.length > 0) {
    return {
      component: "Banco de dados",
      ok: false,
      detail: `acessível, mas com ${status.pending.length} migraç${status.pending.length === 1 ? "ão pendente" : "ões pendentes"} (${status.pending.join(", ")}); rode: suup db migrate`,
    };
  }
  return {
    component: "Banco de dados",
    ok: true,
    detail: `acessível, ${status.applied.length} migraç${status.applied.length === 1 ? "ão aplicada" : "ões aplicadas"}${status.unknown.length > 0 ? ` (atenção: o banco tem migrações que este código não conhece: ${status.unknown.join(", ")})` : ""}`,
  };
}

async function checkSandbox(ctx: Ctx): Promise<Check> {
  const { config, baseDir } = ctx.config();
  const root = await ctx.runtime().sandboxRoot();
  const result = await root.exec("true", { timeoutMs: 30_000 });
  if (result.exitCode !== 0) {
    return {
      component: "Sandbox",
      ok: false,
      detail: `o comando \`true\` terminou com código ${result.exitCode ?? "nenhum"}${result.stderr.trim() === "" ? "" : `: ${result.stderr.trim()}`}`,
    };
  }
  const sb = config.sandbox;
  return {
    component: "Sandbox",
    ok: true,
    detail:
      sb.kind === "local"
        ? `LOCAL em ${resolve(baseDir, sb.root)} — SEM isolamento (só para desenvolvimento e testes); \`true\` rodou`
        : `docker, contêiner "${sb.name}" respondeu (\`true\` rodou)`,
  };
}

async function checkProviders(ctx: Ctx, live: boolean): Promise<Check[]> {
  const runtime = ctx.runtime();
  const checks: Check[] = [];
  for (const entry of runtime.config.providers) {
    const status = runtime.keyStatus(entry.id);
    checks.push({
      component: `Provedor ${entry.id}`,
      ok: status.ok,
      detail: `${entry.kind}: ${status.reason}`,
    });
    if (entry.kind === "scripted" && status.ok) {
      try {
        const { baseDir } = ctx.config();
        const script = loadScript(resolve(baseDir, entry.scriptPath));
        checks[checks.length - 1] = {
          component: `Provedor ${entry.id}`,
          ok: true,
          detail: `scripted (NÃO é um modelo de verdade): roteiro ${entry.scriptPath} lido, ${script.agent.length} passos do agente`,
        };
      } catch (error) {
        checks[checks.length - 1] = {
          component: `Provedor ${entry.id}`,
          ok: false,
          detail: message(error),
        };
      }
    }
  }
  if (!live) return checks;
  for (const model of runtime.config.models) {
    const component = `Modelo ${model.id}`;
    const entry = runtime.config.providers.find((p) => p.id === model.provider);
    if (entry?.kind === "scripted") {
      checks.push({ component, ok: true, detail: "provedor scripted: sem chamada real" });
      continue;
    }
    if (!runtime.keyStatus(model.provider).ok) {
      checks.push({
        component,
        ok: false,
        detail: `sem chamada real: ${runtime.keyStatus(model.provider).reason}`,
      });
      continue;
    }
    const startedAt = Date.now();
    try {
      const result = await generateAndCollect(runtime.getProvider(model.provider), {
        model: model.id,
        system: "Responda com uma única palavra.",
        messages: [{ role: "user", blocks: [{ type: "text", text: "Diga: ok" }] }],
        tools: [],
        maxOutputTokens: Math.min(32, model.maxOutputTokens),
      });
      checks.push({
        component,
        ok: true,
        detail: `respondeu em ${formatDuration(Date.now() - startedAt)}; versão devolvida pelo provedor: ${result.modelVersion}`,
      });
    } catch (error) {
      checks.push({ component, ok: false, detail: `a chamada real falhou: ${message(error)}` });
    }
  }
  return checks;
}

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
    checks.push(...(await guarded("Banco de dados", () => checkDatabase(ctx))));
    checks.push(...(await guarded("Sandbox", () => checkSandbox(ctx))));
    checks.push(
      ...(await guarded("Provedores", () => checkProviders(ctx, flag(ctx.args, "live")))),
    );
    checks.push(
      ...(await guarded("Ferramentas", async () => {
        const names = ctx
          .runtime()
          .tools.list()
          .map((t) => t.name);
        return {
          component: "Ferramentas",
          ok: names.length > 0,
          detail: `${names.length} registradas: ${names.join(", ")}`,
        };
      })),
    );
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
