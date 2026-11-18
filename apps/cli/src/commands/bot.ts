import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { archiveBot, type Bot, createBot, listBots } from "@suup/db";
import { flag, list, posInt, str } from "../args.js";
import type { CommandSpec } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { formatDateTime } from "../format.js";
import { findBot } from "../lookup.js";
import { renderTable } from "../table.js";

const NAME = "bot create";

export function botJson(bot: Bot) {
  return {
    id: bot.id,
    name: bot.name,
    description: bot.description,
    personality: bot.personality,
    modelProvider: bot.modelProvider,
    modelId: bot.modelId,
    allowedTools: bot.allowedTools,
    limits: bot.limits,
    createdAt: bot.createdAt.toISOString(),
    archivedAt: bot.archivedAt?.toISOString() ?? null,
  };
}

export const botCreate: CommandSpec = {
  name: NAME,
  summary: "Cria um bot (nome, modelo, personalidade e ferramentas liberadas)",
  options: {
    name: { type: "string", value: "nome", help: "Nome do bot (obrigatório)" },
    model: {
      type: "string",
      value: "modelo",
      help: 'Id de um modelo de "models" na configuração (obrigatório)',
    },
    personality: { type: "string", value: "texto", help: "Personalidade/instruções do bot" },
    "personality-file": {
      type: "string",
      value: "arquivo",
      help: "Lê a personalidade de um arquivo",
    },
    tools: { type: "string", value: "a,b,c", help: "Ferramentas liberadas, separadas por vírgula" },
    "all-tools": { type: "boolean", help: "Libera todas as ferramentas registradas" },
    "max-turns": {
      type: "string",
      value: "N",
      help: "Limite de turnos (chamadas ao modelo) por execução",
    },
  },
  positionals: { names: [] },
  notes: [
    "As ferramentas de controle (plan, finish, escalate) existem em todo bot; aqui se escolhem as demais.",
    'Exemplo: suup bot create --name ajudante --model model-x --all-tools --personality "Seja direto."',
  ],
  async run(ctx) {
    const name = str(ctx.args, "name");
    const modelId = str(ctx.args, "model");
    if (name === undefined || name.trim() === "")
      throw new UsageError("Falta --name <nome>.", NAME);
    if (modelId === undefined) throw new UsageError("Falta --model <id do modelo>.", NAME);
    const personalityText = str(ctx.args, "personality");
    const personalityFile = str(ctx.args, "personality-file");
    if (personalityText !== undefined && personalityFile !== undefined) {
      throw new UsageError("Use --personality ou --personality-file, não os dois.", NAME);
    }
    if (str(ctx.args, "tools") !== undefined && flag(ctx.args, "all-tools")) {
      throw new UsageError("Use --tools ou --all-tools, não os dois.", NAME);
    }
    const maxTurns = posInt(ctx.args, "max-turns", NAME);

    const runtime = ctx.runtime();
    const { model, provider } = runtime.resolveModel(modelId);
    const known = runtime.tools.list().map((t) => t.name);
    const allowedTools = flag(ctx.args, "all-tools")
      ? known
      : list(ctx.args, "tools")
          .flatMap((v) => v.split(","))
          .map((t) => t.trim())
          .filter((t) => t !== "");
    const unknown = allowedTools.filter((t) => !known.includes(t));
    if (unknown.length > 0) {
      throw new UsageError(
        `Ferramenta${unknown.length > 1 ? "s" : ""} desconhecida${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Disponíveis: ${known.join(", ")}.`,
        NAME,
      );
    }
    let personality = personalityText ?? "";
    if (personalityFile !== undefined) {
      try {
        personality = await readFile(resolve(ctx.io.cwd, personalityFile), "utf8");
      } catch (error) {
        throw new CommandError(
          `Não foi possível ler ${personalityFile}: ${(error as Error).message}`,
        );
      }
    }

    const bot = await createBot(runtime.db, {
      name: name.trim(),
      personality,
      modelProvider: provider.id,
      modelId: model.id,
      allowedTools: [...new Set(allowedTools)],
      limits: maxTurns === undefined ? {} : { maxTurns },
    });
    if (ctx.json) {
      ctx.out.data(botJson(bot));
      return EXIT_OK;
    }
    ctx.out.line(`Bot criado: ${bot.name} (${bot.id})`);
    ctx.out.line(`  Modelo: ${bot.modelId} (provedor ${bot.modelProvider})`);
    ctx.out.line(
      `  Ferramentas: ${bot.allowedTools.length === 0 ? "nenhuma além de plan, finish e escalate" : bot.allowedTools.join(", ")}`,
    );
    if (bot.allowedTools.length === 0) {
      ctx.out.line(
        "  Dica: o bot não pode agir no computador; use --tools ou --all-tools para liberar ferramentas.",
      );
    }
    ctx.out.line(`Próximo passo: suup run "<objetivo>" --bot ${bot.name}`);
    return EXIT_OK;
  },
};

export const botList: CommandSpec = {
  name: "bot list",
  summary: "Lista os bots",
  options: { all: { type: "boolean", help: "Inclui os bots arquivados" } },
  positionals: { names: [] },
  async run(ctx) {
    const bots = await listBots(ctx.runtime().db, { includeArchived: flag(ctx.args, "all") });
    if (ctx.json) {
      ctx.out.data(bots.map(botJson));
      return EXIT_OK;
    }
    if (bots.length === 0) {
      ctx.out.line(
        "Nenhum bot. Crie um com: suup bot create --name <nome> --model <modelo> --all-tools",
      );
      return EXIT_OK;
    }
    ctx.out.lines(
      renderTable(
        ["ID", "NOME", "MODELO", "FERRAMENTAS", "SITUAÇÃO"],
        bots.map((b) => [
          b.id.slice(0, 8),
          b.name,
          b.modelId,
          String(b.allowedTools.length),
          b.archivedAt === null ? "ativo" : "arquivado",
        ]),
      ),
    );
    return EXIT_OK;
  },
};

export const botShow: CommandSpec = {
  name: "bot show",
  summary: "Mostra os detalhes de um bot",
  options: {},
  positionals: { names: ["bot"] },
  notes: ["<bot> é o id, o início do id ou o nome."],
  async run(ctx) {
    const bot = await findBot(ctx.runtime().db, ctx.args.positionals[0] as string);
    if (ctx.json) {
      ctx.out.data(botJson(bot));
      return EXIT_OK;
    }
    const limits = Object.entries(bot.limits)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(", ");
    ctx.out.lines([
      `Bot: ${bot.name}${bot.archivedAt === null ? "" : "  [ARQUIVADO]"}`,
      `Id: ${bot.id}`,
      `Modelo: ${bot.modelId} (provedor ${bot.modelProvider})`,
      `Ferramentas: ${bot.allowedTools.length === 0 ? "nenhuma além de plan, finish e escalate" : bot.allowedTools.join(", ")}`,
      `Limites: ${limits === "" ? "padrões da configuração" : limits}`,
      `Criado em: ${formatDateTime(bot.createdAt)}`,
      ...(bot.archivedAt === null ? [] : [`Arquivado em: ${formatDateTime(bot.archivedAt)}`]),
      "Personalidade:",
      ...(bot.personality.trim() === ""
        ? ["  (vazia)"]
        : bot.personality
            .trimEnd()
            .split("\n")
            .map((l) => `  ${l}`)),
    ]);
    return EXIT_OK;
  },
};

export const botArchive: CommandSpec = {
  name: "bot archive",
  summary: "Arquiva um bot (não aceita mais execuções novas; as antigas continuam consultáveis)",
  options: {},
  positionals: { names: ["bot"] },
  async run(ctx) {
    const db = ctx.runtime().db;
    const found = await findBot(db, ctx.args.positionals[0] as string);
    const archived = (await archiveBot(db, found.id)) as Bot;
    if (ctx.json) ctx.out.data(botJson(archived));
    else {
      ctx.out.line(
        found.archivedAt === null
          ? `Bot arquivado: ${archived.name} (${archived.id})`
          : `O bot ${archived.name} já estava arquivado.`,
      );
    }
    return EXIT_OK;
  },
};
