import { type UpdateMemorySettingsBody, updateMemorySettingsBodySchema } from "@suup/api";
import {
  confirmMemory,
  type Db,
  getMemory,
  getMemorySettings,
  latestMemoryReviews,
  listBots,
  listConsolidations,
  listMemories,
  listMemoryRevisions,
  type Memory,
  type MemoryRevision,
  memoryPromptUsage,
  RevisionError,
  rejectMemory,
  undoMemoryRevision,
  updateMemorySettings,
} from "@suup/db";
import { posInt, str } from "../args.js";
import type { CommandSpec, Ctx } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { formatDateTime, oneLine } from "../format.js";
import { findBot, isIdPrefix } from "../lookup.js";
import { renderTable } from "../table.js";

const LAYER_PT = { rule: "regra", profile: "perfil", note: "nota", journal: "diário" } as const;
const ACTOR_PT = {
  user: "você",
  bot: "o bot",
  consolidation: "a consolidação",
  expiry: "a expiração",
} as const;
const KIND_PT = {
  created: "criada",
  edited: "editada",
  confirmed: "confirmada",
  rejected: "recusada",
  archived: "esquecida",
  restored: "restaurada",
  promoted: "promovida a perfil",
  undone: "desfeita",
} as const;

async function findMemoryRef(db: Db, ref: string): Promise<Memory> {
  const rows = await db.sql<{ id: string }[]>`
    select id from memories where id::text like ${`${ref.toLowerCase()}%`} order by created_at limit 5`;
  if (!isIdPrefix(ref) || rows.length === 0) {
    throw new CommandError(
      `Memória não encontrada: ${JSON.stringify(ref)}. Veja os ids com: suup memory pending  ou  suup memory list --all`,
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

export const memoryPending: CommandSpec = {
  name: "memory pending",
  summary: "Lista o que espera a sua confirmação (regras e fatos propostos por um bot)",
  options: {
    bot: { type: "string", value: "bot", help: "Só as propostas deste bot" },
  },
  positionals: { names: [] },
  notes: [
    "Uma regra ou um fato sobre você que um bot (ou a consolidação em segundo plano) propõe NÃO vale até você confirmar: nada disso entra no prompt antes.",
    "Confirme com: suup memory confirm <id>    Recuse com: suup memory reject <id>",
  ],
  async run(ctx) {
    const db = ctx.runtime().db;
    const botRef = str(ctx.args, "bot");
    const bot = botRef === undefined ? undefined : await findBot(db, botRef);
    const items = await listMemories(db, {
      status: "pending",
      limit: 500,
      ...(bot === undefined ? {} : { botId: bot.id }),
    });
    const reviews = await latestMemoryReviews(
      db,
      items.map((m) => m.id),
    );
    if (ctx.json) {
      ctx.out.data(
        items.map((m) => ({
          id: m.id,
          layer: m.layer,
          scope: m.scope,
          botId: m.botId,
          text: m.text,
          summary: m.summary,
          createdBy: m.createdBy,
          supersedesId: m.supersedesId,
          sourceConversationId: m.sourceConversationId,
          sourceRunId: m.sourceRunId,
          sourceMessageId: m.sourceMessageId,
          createdAt: m.createdAt.toISOString(),
          review: reviews.get(m.id) ?? null,
        })),
      );
      return EXIT_OK;
    }
    if (items.length === 0) {
      ctx.out.line("Nada espera a sua confirmação.");
      return EXIT_OK;
    }
    const names = await botNames(db);
    ctx.out.lines(
      renderTable(
        ["ID", "CAMADA", "DE", "DATA", "TEXTO"],
        items.map((m) => [
          m.id.slice(0, 8),
          `${LAYER_PT[m.layer]}${m.supersedesId === null ? "" : " (troca outra)"}`,
          m.scope === "shared" ? "todos" : (names.get(m.botId ?? "") ?? "?"),
          formatDateTime(m.createdAt),
          `${oneLine(m.text, 80)}${reviews.has(m.id) ? ` [revisão: ${oneLine(reviews.get(m.id)?.reason ?? "", 60)}]` : ""}`,
        ]),
      ),
    );
    ctx.out.line("");
    ctx.out.line("Confirme com: suup memory confirm <id>    Recuse com: suup memory reject <id>");
    return EXIT_OK;
  },
};

function decide(kind: "confirm" | "reject"): CommandSpec {
  const confirm = kind === "confirm";
  return {
    name: `memory ${kind}`,
    summary: confirm
      ? "Confirma uma memória pendente: ela passa a valer (regra e perfil entram nos prompts)"
      : "Recusa uma memória pendente: ela não vale e não é proposta de novo",
    options: {},
    positionals: { names: ["memória"] },
    async run(ctx: Ctx) {
      const db = ctx.runtime().db;
      const found = await findMemoryRef(db, ctx.args.positionals[0] as string);
      if (found.status !== "pending") {
        throw new CommandError(
          `A memória ${found.id.slice(0, 8)} não está esperando confirmação (estado: ${found.status}).`,
        );
      }
      const memory = (
        confirm ? await confirmMemory(db, found.id) : await rejectMemory(db, found.id)
      ) as Memory;
      if (ctx.json) {
        ctx.out.data({ id: memory.id, status: memory.status, text: memory.text });
        return EXIT_OK;
      }
      ctx.out.line(
        confirm
          ? `Confirmada (${LAYER_PT[memory.layer]}): ${oneLine(memory.text, 100)}`
          : `Recusada: ${oneLine(memory.text, 100)}`,
      );
      if (confirm && memory.supersedesId !== null) {
        ctx.out.line(`Ela trocou a memória ${memory.supersedesId.slice(0, 8)}, que foi esquecida.`);
      }
      if (confirm)
        ctx.out.line(
          "Vale a partir da próxima execução. Para desfazer: suup memory undo " +
            memory.id.slice(0, 8),
        );
      return EXIT_OK;
    },
  };
}
export const memoryConfirm = decide("confirm");
export const memoryReject = decide("reject");

const revisionJson = (r: MemoryRevision) => ({
  id: r.id,
  memoryId: r.memoryId,
  kind: r.kind,
  actor: r.actor,
  prev: r.prev,
  next: r.next,
  originRunId: r.originRunId,
  originConversationId: r.originConversationId,
  originMessageId: r.originMessageId,
  originConsolidationId: r.originConsolidationId,
  createdAt: r.createdAt.toISOString(),
});

export const memoryHistory: CommandSpec = {
  name: "memory history",
  summary: "Mostra o histórico de mudanças de uma memória: quem mudou, de onde, e o que mudou",
  options: {},
  positionals: { names: ["memória"] },
  async run(ctx) {
    const db = ctx.runtime().db;
    const found = await findMemoryRef(db, ctx.args.positionals[0] as string);
    const revisions = await listMemoryRevisions(db, found.id);
    if (ctx.json) {
      ctx.out.data(revisions.map(revisionJson));
      return EXIT_OK;
    }
    ctx.out.line(
      `Memória ${found.id.slice(0, 8)} (${LAYER_PT[found.layer]}): ${oneLine(found.text, 100)}`,
    );
    ctx.out.lines(
      renderTable(
        ["MUDANÇA", "QUANDO", "QUEM", "ORIGEM", "ANTES", "DEPOIS"],
        revisions.map((r) => [
          r.id.slice(0, 8),
          formatDateTime(r.createdAt),
          ACTOR_PT[r.actor],
          r.originConsolidationId !== null
            ? `consolidação ${r.originConsolidationId.slice(0, 8)}`
            : r.originRunId !== null
              ? `execução ${r.originRunId.slice(0, 8)}`
              : "—",
          r.prev === null ? "—" : oneLine(r.prev.text, 40),
          `${KIND_PT[r.kind]}: ${oneLine(r.next.text, 40)}`,
        ]),
      ),
    );
    if (revisions[0] !== undefined) {
      ctx.out.line("");
      ctx.out.line(`Para desfazer a última mudança: suup memory undo ${found.id.slice(0, 8)}`);
    }
    return EXIT_OK;
  },
};

export const memoryUndo: CommandSpec = {
  name: "memory undo",
  summary: "Desfaz a última mudança de uma memória (ou a mudança dada em --revision)",
  options: {
    revision: {
      type: "string",
      value: "mudança",
      help: "O id (ou o início) da mudança, de suup memory history. Só a mais recente pode ser desfeita",
    },
  },
  positionals: { names: ["memória"] },
  notes: [
    "Desfazer devolve a memória ao estado de antes da mudança (texto, camada, esquecida ou não). O próprio desfazer entra no histórico, então desfazer de novo refaz.",
  ],
  async run(ctx) {
    const db = ctx.runtime().db;
    const found = await findMemoryRef(db, ctx.args.positionals[0] as string);
    const revisions = await listMemoryRevisions(db, found.id, 1000);
    const wanted = str(ctx.args, "revision");
    const revision =
      wanted === undefined
        ? revisions[0]
        : revisions.filter((r) => r.id.startsWith(wanted.toLowerCase()))[0];
    if (revision === undefined) {
      throw new CommandError(
        wanted === undefined
          ? "Esta memória não tem mudanças para desfazer."
          : `Mudança não encontrada nesta memória: ${wanted}. Veja: suup memory history ${found.id.slice(0, 8)}`,
      );
    }
    let memory: Memory;
    try {
      memory = await undoMemoryRevision(db, revision.id);
    } catch (error) {
      if (error instanceof RevisionError) throw new CommandError(error.message);
      throw error;
    }
    if (ctx.json) {
      ctx.out.data({
        id: memory.id,
        status: memory.status,
        layer: memory.layer,
        text: memory.text,
        archivedAt: memory.archivedAt?.toISOString() ?? null,
      });
      return EXIT_OK;
    }
    ctx.out.line(`Desfeito (${KIND_PT[revision.kind]}): ${oneLine(memory.text, 100)}`);
    return EXIT_OK;
  },
};

export const memoryConsolidations: CommandSpec = {
  name: "memory consolidations",
  summary:
    "Lista as consolidações em segundo plano: o que o modelo propôs, o que ficou e o que foi descartado",
  options: {
    limit: { type: "string", value: "N", help: "Quantas mostrar (padrão 20)" },
  },
  positionals: { names: [] },
  async run(ctx) {
    const db = ctx.runtime().db;
    const rows = await listConsolidations(db, {
      limit: posInt(ctx.args, "limit", "memory consolidations") ?? 20,
    });
    if (ctx.json) {
      ctx.out.data(
        rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          startedAt: r.startedAt?.toISOString() ?? null,
          finishedAt: r.finishedAt?.toISOString() ?? null,
          leaseExpiresAt: r.leaseExpiresAt?.toISOString() ?? null,
        })),
      );
      return EXIT_OK;
    }
    if (rows.length === 0) {
      ctx.out.line("Nenhuma consolidação ainda.");
      return EXIT_OK;
    }
    const count = (v: unknown) => (Array.isArray(v) ? v.length : 0);
    ctx.out.lines(
      renderTable(
        [
          "ID",
          "QUANDO",
          "MOTIVO",
          "ESTADO",
          "TURNOS",
          "PROPOSTAS",
          "FICARAM",
          "DESCARTADAS",
          "CUSTO",
        ],
        rows.map((r) => [
          r.id.slice(0, 8),
          formatDateTime(r.createdAt),
          r.reason,
          r.status === "failed" ? `falhou (${oneLine(r.error ?? "", 30)})` : r.status,
          String(r.userTurns ?? "—"),
          String(count(r.proposed)),
          String(count(r.kept)),
          String(count(r.dropped)),
          r.costUsd === null ? "—" : `US$ ${r.costUsd.toFixed(5)}`,
        ]),
      ),
    );
    return EXIT_OK;
  },
};

/** A whole number or a plain decimal as typed; `undefined` for anything else (no guessing). */
function numberOf(text: string): number | undefined {
  if (text.trim() === "") return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

export const memorySettings: CommandSpec = {
  name: "memory settings",
  summary:
    "Mostra ou muda as configurações da memória (consolidação, limite do prompt, expiração, compactação)",
  options: {
    consolidation: {
      type: "string",
      value: "on|off",
      help: "Liga ou desliga a consolidação em segundo plano",
    },
    "idle-minutes": {
      type: "string",
      value: "min",
      help: "Minutos de silêncio de uma conversa para consolidá-la (1 a 120)",
    },
    "max-turns": {
      type: "string",
      value: "N",
      help: "Mensagens suas acumuladas que disparam a consolidação (3 a 100)",
    },
    "prompt-limit": {
      type: "string",
      value: "memórias",
      help: "Quantas memórias (regras e perfil ativos) entram em todo prompt (20 a 1000; padrão 200)",
    },
    "expiry-days": {
      type: "string",
      value: "dias|never",
      help: "Dias sem uso para arquivar notas e diário (7 a 3650) ou never",
    },
    "compaction-threshold": {
      type: "string",
      value: "0,5-0,95",
      help: "Parte da janela de contexto em que o histórico é compactado",
    },
  },
  positionals: { names: [] },
  notes: [
    "Sem opções, mostra os valores de agora. Cada opção muda só o seu valor; o que o app mostra na tela de configuração é isto.",
    "O modelo da consolidação vem do arquivo de configuração (memory.consolidation.model, senão o do auto-review).",
    "Exemplo: suup memory settings --max-turns 20 --expiry-days never",
  ],
  async run(ctx) {
    const db = ctx.runtime().db;
    const patch: UpdateMemorySettingsBody = {};
    const consolidation: NonNullable<UpdateMemorySettingsBody["consolidation"]> = {};
    const bad = (option: string, expected: string): never => {
      throw new UsageError(`--${option}: ${expected}`, "memory settings");
    };
    const number = (option: string, expected: string): number | undefined => {
      const raw = str(ctx.args, option);
      if (raw === undefined) return undefined;
      return numberOf(raw) ?? bad(option, expected);
    };
    const switchRaw = str(ctx.args, "consolidation");
    if (switchRaw !== undefined) {
      if (switchRaw === "on") consolidation.enabled = true;
      else if (switchRaw === "off") consolidation.enabled = false;
      else bad("consolidation", "use on ou off.");
    }
    const idle = number("idle-minutes", "deve ser um número.");
    if (idle !== undefined) consolidation.idleMinutes = idle;
    const turns = number("max-turns", "deve ser um número.");
    if (turns !== undefined) consolidation.maxTurns = turns;
    if (Object.keys(consolidation).length > 0) patch.consolidation = consolidation;
    const limit = number("prompt-limit", "deve ser um número.");
    if (limit !== undefined) patch.promptLimitItems = limit;
    const expiryRaw = str(ctx.args, "expiry-days");
    if (expiryRaw !== undefined) {
      patch.expiryDays =
        expiryRaw === "never"
          ? null
          : (numberOf(expiryRaw) ?? bad("expiry-days", "use um número de dias ou never."));
    }
    const threshold = number("compaction-threshold", "deve ser um número entre 0,5 e 0,95.");
    if (threshold !== undefined) patch.compactionThreshold = threshold;

    if (Object.keys(patch).length > 0) {
      const checked = updateMemorySettingsBodySchema.safeParse(patch);
      if (!checked.success) {
        throw new UsageError(
          checked.error.issues
            .map((i) => `${i.path.map(String).join(".")}: ${i.message}.`)
            .join(" "),
          "memory settings",
        );
      }
      await updateMemorySettings(db, {
        ...(checked.data.consolidation?.enabled === undefined
          ? {}
          : { consolidationEnabled: checked.data.consolidation.enabled }),
        ...(checked.data.consolidation?.idleMinutes === undefined
          ? {}
          : { idleMinutes: checked.data.consolidation.idleMinutes }),
        ...(checked.data.consolidation?.maxTurns === undefined
          ? {}
          : { maxTurns: checked.data.consolidation.maxTurns }),
        ...(checked.data.promptLimitItems === undefined
          ? {}
          : { promptLimitItems: checked.data.promptLimitItems }),
        ...(checked.data.expiryDays === undefined ? {} : { expiryDays: checked.data.expiryDays }),
        ...(checked.data.compactionThreshold === undefined
          ? {}
          : { compactionThreshold: checked.data.compactionThreshold }),
      });
    }
    const s = await getMemorySettings(db);
    const status = ctx.runtime().memoryReviewerStatus();
    const usage = await memoryPromptUsage(db, s.promptLimitItems);
    if (ctx.json) {
      ctx.out.data({
        consolidation: {
          enabled: s.consolidationEnabled,
          idleMinutes: s.idleMinutes,
          maxTurns: s.maxTurns,
        },
        promptLimitItems: s.promptLimitItems,
        expiryDays: s.expiryDays,
        compactionThreshold: s.compactionThreshold,
        reviewer: { available: status.available, model: status.model, reason: status.reason },
        promptUsage: {
          limitItems: usage.limitItems,
          ceilingChars: usage.ceilingChars,
          sharedItems: usage.sharedItems,
          sharedChars: usage.sharedChars,
          overLimit: usage.overBots,
        },
      });
      return EXIT_OK;
    }
    ctx.out.line(
      `Consolidação em segundo plano: ${s.consolidationEnabled ? "ligada" : "desligada"}`,
    );
    ctx.out.line(
      `  roda quando a conversa fica ${s.idleMinutes} min em silêncio, ou com ${s.maxTurns} mensagens suas novas, ou antes de compactar o histórico`,
    );
    ctx.out.line(
      `Limite do que entra em todo prompt (regras e perfil ativos): ${s.promptLimitItems} memórias (e no máximo ${usage.ceilingChars} caracteres)`,
    );
    ctx.out.line(
      `Expiração de notas e diário sem uso: ${s.expiryDays === null ? "nunca" : `${s.expiryDays} dias`}`,
    );
    ctx.out.line(
      `Compactação do histórico: a ${Math.round(s.compactionThreshold * 100)}% da janela de contexto`,
    );
    ctx.out.line(
      status.available
        ? `Modelo da memória: ${status.model}.`
        : `Aviso: sem modelo para a memória (${status.reason ?? "sem motivo"}): nada é consolidado e o que o bot escreve depois de ler conteúdo de fora espera você.`,
    );
    if (usage.overBots.length > 0) {
      ctx.out.line("");
      ctx.out.line(
        `Aviso: regras e perfil ativos passam do limite (${usage.limitItems} memórias ou ${usage.ceilingChars} caracteres) para: ${usage.overBots.map((b) => `${b.name} (${b.usedItems} memórias, ${b.usedChars} caracteres)`).join(", ")}.`,
      );
      ctx.out.line(
        "O que não cabe fica de fora do prompt, na ordem de criação. Apague ou encurte algumas (suup memory forget/edit) ou aumente o limite.",
      );
    }
    return EXIT_OK;
  },
};
