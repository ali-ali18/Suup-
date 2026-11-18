import { migrate } from "@suup/db";
import type { CommandSpec } from "../context.js";
import { EXIT_OK } from "../errors.js";

export const dbMigrate: CommandSpec = {
  name: "db migrate",
  summary: "Aplica as migrações pendentes no banco de dados",
  options: {},
  positionals: { names: [] },
  notes: [
    'Usa DATABASE_URL do ambiente (que vale mais) ou "databaseUrl" do arquivo de configuração.',
    "É seguro rodar de novo: sem migrações pendentes, nada acontece.",
  ],
  async run(ctx) {
    const applied = await migrate(ctx.runtime().db);
    if (ctx.json) ctx.out.data({ applied });
    else if (applied.length === 0)
      ctx.out.line("O banco já está atualizado: nenhuma migração pendente.");
    else {
      ctx.out.line(
        `${applied.length} migraç${applied.length === 1 ? "ão aplicada" : "ões aplicadas"}:`,
      );
      for (const name of applied) ctx.out.line(`  - ${name}`);
    }
    return EXIT_OK;
  },
};
