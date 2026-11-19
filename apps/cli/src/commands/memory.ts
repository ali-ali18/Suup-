import {
  addMemory,
  archiveMemory,
  type Bot,
  type Db,
  getMemory,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  listBots,
  listMemories,
  type Memory,
  type MemoryLayer,
  restoreMemory,
  searchMemories,
  searchMessages,
  updateMemory,
} from "@suup/db";
import { flag, posInt, str } from "../args.js";
import type { CommandSpec, Ctx } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { formatDateTime, oneLine } from "../format.js";
import { findBot } from "../lookup.js";
import { renderTable } from "../table.js";

const LAYERS = ["rule", "profile", "note", "journal"] as const;
const LAYER_PT: Record<MemoryLayer, string> = {
  rule: "regra",
  profile: "perfil",
  note: "nota",
  journal: "diário",
};
/** The layer as the person may type it: English (the code) or Portuguese (the screen). */
const LAYER_INPUT: Record<string, MemoryLayer> = {
  rule: "rule",
  regra: "rule",
  profile: "profile",
  perfil: "profile",
  note: "note",
  nota: "note",
  journal: "journal",
  diario: "journal",
  diário: "journal",
};

function layerOption(ctx: Ctx, command: string): MemoryLayer | undefined {
  const raw = str(ctx.args, "layer");
  if (raw === undefined) return undefined;
  const layer = LAYER_INPUT[raw.toLowerCase()];
  if (layer === undefined) {
    throw new UsageError(
      `Camada desconhecida: ${JSON.stringify(raw)}. Use: ${LAYERS.map((l) => `${l} (${LAYER_PT[l]})`).join(", ")}.`,
      command,
    );
  }
  return layer;
}

/** A memory by full id or unique id prefix. */
async function findMemory(db: Db, ref: string): Promise<Memory> {
  const rows = await db.sql<{ id: string }[]>`
    select id from memories where id::text like ${`${ref.toLowerCase()}%`} order by created_at limit 5`;
  if (!/^[0-9a-f][0-9a-f-]{3,35}$/i.test(ref) || rows.length === 0) {
    throw new CommandError(
      `Memória não encontrada: ${JSON.stringify(ref)}. Veja os ids com: suup memory list --all`,
    );
  }
  if (rows.length > 1) {
    throw new CommandError(
      `${JSON.stringify(ref)} corresponde a mais de uma memória (${rows.map((r) => r.id.slice(0, 12)).join(", ")}). Use mais caracteres do id.`,
    );
  }
  const memory = await getMemory(db, (rows[0] as { id: string }).id);
  if (memory === null) throw new CommandError(`Memória não encontrada: ${ref}.`);
  return memory;
}

const botNames = async (db: Db): Promise<Map<string, string>> =>
  new Map((await listBots(db, { includeArchived: true })).map((b) => [b.id, b.name]));

function memoryJson(m: Memory) {
  return {
    id: m.id,
    layer: m.layer,
    scope: m.scope,
    botId: m.botId,
    text: m.text,
    createdBy: m.createdBy,
    sourceConversationId: m.sourceConversationId,
    sourceRunId: m.sourceRunId,
    sourceMessageId: m.sourceMessageId,
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
    archivedAt: m.archivedAt?.toISOString() ?? null,
  };
}

const originOf = (m: Memory): string => {
  const by = m.createdBy === "bot" ? "criada pelo bot" : "criada por você";
  const from =
    m.sourceRunId !== null
      ? ` (execução ${m.sourceRunId.slice(0, 8)})`
      : m.sourceConversationId !== null
        ? ` (conversa ${m.sourceConversationId.slice(0, 8)})`
        : "";
  return `${by}${from}`;
};

const layerOptions = {
  layer: {
    type: "string",
    value: "camada",
    help: "rule (regra), profile (perfil), note (nota) ou journal (diário)",
  },
  bot: {
    type: "string",
    value: "bot",
    help: "Só as memórias deste bot (id, início do id ou nome)",
  },
} as const;

export const memoryList: CommandSpec = {
  name: "memory list",
  summary: "Lista a memória: regras, perfil, notas dos bots e diário",
  options: {
    ...layerOptions,
    all: { type: "boolean", help: "Inclui as memórias esquecidas (arquivadas)" },
    limit: { type: "string", value: "N", help: "Quantas mostrar (padrão 100)" },
  },
  positionals: { names: [] },
  notes: [
    "Regras e perfil entram no início de toda execução; notas e diário são buscados (suup memory search).",
    "O texto completo de cada memória, a origem e o autor aparecem com --json.",
  ],
  async run(ctx) {
    const db = ctx.runtime().db;
    const layer = layerOption(ctx, "memory list");
    const botRef = str(ctx.args, "bot");
    const bot = botRef === undefined ? undefined : await findBot(db, botRef);
    const limit = posInt(ctx.args, "limit", "memory list") ?? 100;
    const memories = await listMemories(db, {
      ...(layer === undefined ? {} : { layer }),
      ...(bot === undefined ? {} : { botId: bot.id }),
      includeArchived: flag(ctx.args, "all"),
      limit,
    });
    if (ctx.json) {
      ctx.out.data(memories.map(memoryJson));
      return EXIT_OK;
    }
    if (memories.length === 0) {
      ctx.out.line(
        'Nada na memória com esse filtro. Para guardar algo: suup memory add rule "<texto>"',
      );
      return EXIT_OK;
    }
    const names = await botNames(db);
    ctx.out.lines(
      renderTable(
        ["ID", "CAMADA", "DE", "ORIGEM", "DATA", "TEXTO"],
        memories.map((m) => [
          m.id.slice(0, 8),
          `${LAYER_PT[m.layer]}${m.archivedAt === null ? "" : " [esquecida]"}`,
          m.scope === "shared" ? "todos" : (names.get(m.botId ?? "") ?? "?"),
          m.createdBy === "bot" ? "bot" : "você",
          formatDateTime(m.createdAt),
          oneLine(m.text, 90),
        ]),
      ),
    );
    return EXIT_OK;
  },
};

export const memoryAdd: CommandSpec = {
  name: "memory add",
  summary: "Guarda uma regra, um fato do perfil ou uma nota",
  options: {
    bot: {
      type: "string",
      value: "bot",
      help: "Vale só para este bot (obrigatório para nota; numa regra, sem --bot ela vale para todos)",
    },
  },
  positionals: { names: ["camada", "texto"] },
  notes: [
    "camada: rule (regra: ordem permanente), profile (perfil: fato sobre você, vale para todos) ou note (nota de um bot).",
    'Exemplos: suup memory add rule "Responda sempre em português."   ·   suup memory add profile "Moro em Recife."',
    '          suup memory add note "O deploy fica em tools/deploy.sh" --bot ajudante',
  ],
  async run(ctx) {
    const [layerRaw, text] = ctx.args.positionals as [string, string];
    const layer = LAYER_INPUT[layerRaw.toLowerCase()];
    if (layer === undefined || layer === "journal") {
      throw new UsageError(
        `Camada inválida para guardar: ${JSON.stringify(layerRaw)}. Use rule, profile ou note (o diário é escrito pelo sistema).`,
        "memory add",
      );
    }
    if (text.trim() === "") throw new UsageError("O texto está vazio.", "memory add");
    const db = ctx.runtime().db;
    const botRef = str(ctx.args, "bot");
    const bot = botRef === undefined ? undefined : await findBot(db, botRef);
    if (layer === "note" && bot === undefined) {
      throw new UsageError("Uma nota pertence a um bot: use --bot <bot>.", "memory add");
    }
    if (layer === "profile" && bot !== undefined) {
      throw new UsageError("O perfil vale para todos os bots: tire o --bot.", "memory add");
    }
    const memory = await addMemory(db, {
      layer,
      text: text.trim(),
      createdBy: "user",
      ...(bot === undefined ? {} : { botId: bot.id }),
    });
    if (ctx.json) ctx.out.data(memoryJson(memory));
    else {
      ctx.out.line(
        `Guardado (${LAYER_PT[memory.layer]}, ${memory.scope === "shared" ? "para todos os bots" : `só do bot ${(bot as Bot).name}`}): ${memory.id}`,
      );
      if (memory.layer !== "note") {
        ctx.out.line("Entra no início de toda execução a partir de agora.");
      }
    }
    return EXIT_OK;
  },
};

export const memoryEdit: CommandSpec = {
  name: "memory edit",
  summary: "Corrige o texto de uma memória (a camada e a origem não mudam)",
  options: {},
  positionals: { names: ["memória", "texto"] },
  notes: ["<memória> é o id ou o início do id (veja suup memory list)."],
  async run(ctx) {
    const [ref, text] = ctx.args.positionals as [string, string];
    if (text.trim() === "") throw new UsageError("O texto está vazio.", "memory edit");
    const db = ctx.runtime().db;
    const found = await findMemory(db, ref);
    const updated = (await updateMemory(db, found.id, text.trim())) as Memory;
    if (ctx.json) ctx.out.data(memoryJson(updated));
    else {
      ctx.out.line(`Memória ${updated.id.slice(0, 8)} corrigida.`);
      ctx.out.line(`  antes:  ${oneLine(found.text, 120)}`);
      ctx.out.line(`  agora:  ${oneLine(updated.text, 120)}`);
    }
    return EXIT_OK;
  },
};

export const memoryForget: CommandSpec = {
  name: "memory forget",
  summary: "Esquece uma memória (ela é arquivada: some das execuções, e dá para restaurar)",
  options: {},
  positionals: { names: ["memória"] },
  async run(ctx) {
    const db = ctx.runtime().db;
    const found = await findMemory(db, ctx.args.positionals[0] as string);
    const archived = (await archiveMemory(db, found.id)) as Memory;
    if (ctx.json) ctx.out.data(memoryJson(archived));
    else if (found.archivedAt !== null)
      ctx.out.line(`A memória ${found.id.slice(0, 8)} já estava esquecida.`);
    else {
      ctx.out.line(`Esquecida: ${oneLine(found.text, 100)}`);
      ctx.out.line(`Para desfazer: suup memory restore ${found.id.slice(0, 8)}`);
    }
    return EXIT_OK;
  },
};

export const memoryRestore: CommandSpec = {
  name: "memory restore",
  summary: "Traz de volta uma memória esquecida",
  options: {},
  positionals: { names: ["memória"] },
  async run(ctx) {
    const db = ctx.runtime().db;
    const found = await findMemory(db, ctx.args.positionals[0] as string);
    const restored = (await restoreMemory(db, found.id)) as Memory;
    if (ctx.json) ctx.out.data(memoryJson(restored));
    else if (found.archivedAt === null)
      ctx.out.line(`A memória ${found.id.slice(0, 8)} não estava esquecida.`);
    else ctx.out.line(`Restaurada: ${oneLine(found.text, 100)}`);
    return EXIT_OK;
  },
};

const plain = (text: string): string =>
  text.replaceAll(HIGHLIGHT_START, "").replaceAll(HIGHLIGHT_END, "");

export const memorySearch: CommandSpec = {
  name: "memory search",
  summary: "Busca na memória (e, com --messages, nas conversas antigas) por palavras",
  options: {
    ...layerOptions,
    messages: { type: "boolean", help: "Busca também no texto das mensagens das conversas" },
    limit: { type: "string", value: "N", help: "Quantos resultados (padrão 10)" },
  },
  positionals: { names: ["consulta"] },
  notes: [
    "É a mesma busca que o bot faz com recall e search_conversations. Com --bot, mostra o que ESSE bot enxerga",
    "(as memórias compartilhadas e as dele); sem --bot, só as compartilhadas.",
  ],
  async run(ctx) {
    const query = ctx.args.positionals[0] as string;
    const db = ctx.runtime().db;
    const layer = layerOption(ctx, "memory search");
    const botRef = str(ctx.args, "bot");
    const bot = botRef === undefined ? undefined : await findBot(db, botRef);
    const limit = posInt(ctx.args, "limit", "memory search") ?? 10;
    const hits = await searchMemories(db, {
      query,
      ...(bot === undefined ? {} : { botId: bot.id }),
      ...(layer === undefined ? {} : { layers: [layer] }),
      limit,
    });
    const messageHits = flag(ctx.args, "messages")
      ? await searchMessages(db, { query, ...(bot === undefined ? {} : { botId: bot.id }), limit })
      : [];
    if (ctx.json) {
      ctx.out.data({
        memories: hits.map((h) => ({
          ...memoryJson(h.memory),
          excerpt: plain(h.excerpt),
          rank: h.rank,
        })),
        messages: messageHits.map((h) => ({
          id: h.message.id,
          conversationId: h.message.conversationId,
          author: h.message.authorKind,
          text: h.message.text,
          excerpt: plain(h.excerpt),
          createdAt: h.message.createdAt.toISOString(),
        })),
      });
      return EXIT_OK;
    }
    if (hits.length === 0 && messageHits.length === 0) {
      ctx.out.line(`Nada encontrado para ${JSON.stringify(query)}.`);
      if (bot === undefined) {
        ctx.out.line(
          "Sem --bot só as memórias compartilhadas são buscadas; notas e diário são de cada bot: tente --bot <bot>.",
        );
      }
      return EXIT_OK;
    }
    if (hits.length > 0) {
      ctx.out.line("Memória:");
      for (const h of hits) {
        ctx.out.line(
          `  ${h.memory.id.slice(0, 8)}  [${LAYER_PT[h.memory.layer]}] ${oneLine(plain(h.excerpt), 110)}   · ${originOf(h.memory)}`,
        );
      }
    }
    if (messageHits.length > 0) {
      ctx.out.line("Conversas:");
      const who = { user: "você", bot: "bot", system: "sistema" } as const;
      for (const h of messageHits) {
        ctx.out.line(
          `  ${formatDateTime(h.message.createdAt)}  ${who[h.message.authorKind]}: ${oneLine(plain(h.excerpt), 110)}`,
        );
      }
    }
    return EXIT_OK;
  },
};
