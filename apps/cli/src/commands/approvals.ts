import {
  type Approval,
  type Db,
  type DecideApprovalInput,
  decideApproval,
  getApproval,
  listApprovals,
  listBots,
} from "@suup/db";
import { flag, posInt, str } from "../args.js";
import type { CommandSpec, Ctx } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { formatDateTime, levelPt, oneLine } from "../format.js";
import { findBot } from "../lookup.js";
import { renderApprovalCard } from "../render.js";
import { renderTable } from "../table.js";

const STATUS_PT: Record<string, string> = {
  pending: "pendente",
  approved: "aprovada",
  denied: "negada",
  cancelled: "cancelada",
  expired: "expirada",
};

/** An approval by full id or unique id prefix. */
export async function findApproval(db: Db, ref: string): Promise<Approval> {
  if (!/^[0-9a-f][0-9a-f-]{3,35}$/i.test(ref)) {
    throw new CommandError(
      `${JSON.stringify(ref)} não parece um id de aprovação (use o id completo ou o início dele, com pelo menos 4 caracteres). Veja os pendentes com: suup approvals`,
    );
  }
  const rows = await db.sql<{ id: string }[]>`
    select id from approvals where id::text like ${`${ref.toLowerCase()}%`}
    order by created_at desc limit 5`;
  if (rows.length === 0) {
    throw new CommandError(
      `Aprovação não encontrada: ${ref}. Veja os pendentes com: suup approvals`,
    );
  }
  if (rows.length > 1) {
    throw new CommandError(
      `${JSON.stringify(ref)} corresponde a mais de uma aprovação (${rows.map((r) => r.id.slice(0, 12)).join(", ")}). Use mais caracteres do id.`,
    );
  }
  const approval = await getApproval(db, (rows[0] as { id: string }).id);
  if (approval === null) throw new CommandError(`Aprovação não encontrada: ${ref}.`);
  return approval;
}

export function approvalJson(a: Approval) {
  return {
    id: a.id,
    runId: a.runId,
    botId: a.botId,
    conversationId: a.conversationId,
    callId: a.callId,
    tool: a.tool,
    args: a.args,
    level: a.level,
    summary: a.summary,
    secrets: a.secrets,
    source: a.source,
    status: a.status,
    reason: a.reason,
    ruleId: a.ruleId,
    expiresAt: a.expiresAt?.toISOString() ?? null,
    decidedAt: a.decidedAt?.toISOString() ?? null,
    createdAt: a.createdAt.toISOString(),
  };
}

export const approvalsCommand: CommandSpec = {
  name: "approvals",
  summary: "Lista as aprovações que esperam você (ações que um bot quer fazer)",
  options: {
    all: { type: "boolean", help: "Inclui as já resolvidas (aprovadas, negadas, canceladas)" },
    bot: { type: "string", value: "bot", help: "Só as deste bot (id, início do id ou nome)" },
    limit: { type: "string", value: "N", help: "Quantas mostrar (padrão 50)" },
    show: { type: "boolean", help: "Mostra o cartão completo de cada uma (o conteúdo exato)" },
  },
  positionals: { names: [] },
  notes: [
    "Cada cartão é uma chamada de ferramenta que o bot quer fazer e que pede o seu OK: o que sai para o mundo ou não tem volta.",
    'Decida com: suup approve <id> [--always]   ou   suup deny <id> [--reason "..."]',
  ],
  async run(ctx) {
    const db = ctx.runtime().db;
    await ctx.primeRedaction();
    const botRef = str(ctx.args, "bot");
    const bot = botRef === undefined ? undefined : await findBot(db, botRef);
    const approvals = await listApprovals(db, {
      limit: posInt(ctx.args, "limit", "approvals") ?? 50,
      ...(flag(ctx.args, "all") ? {} : { status: "pending" as const }),
      ...(bot === undefined ? {} : { botId: bot.id }),
    });
    if (ctx.json) {
      ctx.out.data(approvals.map(approvalJson));
      return EXIT_OK;
    }
    if (approvals.length === 0) {
      ctx.out.line(flag(ctx.args, "all") ? "Nenhuma aprovação." : "Nenhuma aprovação pendente.");
      return EXIT_OK;
    }
    if (flag(ctx.args, "show")) {
      for (const a of approvals) {
        ctx.out.lines(renderApprovalCard(a));
        ctx.out.line("");
      }
      return EXIT_OK;
    }
    const names = new Map(
      (await listBots(db, { includeArchived: true })).map((b) => [b.id, b.name]),
    );
    ctx.out.lines(
      renderTable(
        ["ID", "BOT", "NÍVEL", "SITUAÇÃO", "QUANDO", "O QUE"],
        approvals.map((a) => [
          a.id.slice(0, 8),
          names.get(a.botId) ?? a.botId.slice(0, 8),
          levelPt(a.level),
          STATUS_PT[a.status] ?? a.status,
          formatDateTime(a.createdAt),
          oneLine(a.summary, 80),
        ]),
      ),
    );
    return EXIT_OK;
  },
};

/** Decides one card and tells the person what happens next. */
export async function decideAndReport(
  ctx: Ctx,
  ref: string,
  decision: DecideApprovalInput,
): Promise<number> {
  const db = ctx.runtime().db;
  const card = await findApproval(db, ref);
  const { approval, ruleId } = await decideApproval(db, card.id, decision).catch(
    (error: unknown) => {
      throw error instanceof Error && error.name === "ApprovalError"
        ? new CommandError(error.message)
        : error;
    },
  );
  if (ctx.json) {
    ctx.out.data({ ...approvalJson(approval), createdRuleId: ruleId });
    return EXIT_OK;
  }
  ctx.out.line(
    approval.status === "approved"
      ? `Aprovada: ${approval.summary}`
      : `Negada: ${approval.summary}${approval.reason === null ? "" : ` (${approval.reason})`}`,
  );
  if (ruleId !== null) {
    ctx.out.line(
      `Regra criada (${ruleId.slice(0, 8)}): chamadas iguais a esta passam a ser liberadas. Veja: suup rules list`,
    );
  }
  ctx.out.line(
    `A execução ${approval.runId.slice(0, 8)} volta à fila e segue; um worker precisa estar rodando (suup worker).`,
  );
  return EXIT_OK;
}

export const approveCommand: CommandSpec = {
  name: "approve",
  summary: "Aprova uma ação que um bot pediu (opcionalmente, e sempre permite ações iguais)",
  options: {
    always: {
      type: "boolean",
      help: "Aprova e cria uma regra: chamadas iguais a esta (mesmos argumentos de texto) deste bot passam sem perguntar",
    },
    global: {
      type: "boolean",
      help: "Com --always: a regra vale para todos os bots",
    },
    "any-args": {
      type: "boolean",
      help: "Com --always: a regra vale para qualquer chamada desta ferramenta, com quaisquer argumentos",
    },
  },
  positionals: { names: ["id"] },
  notes: [
    "O que roda é exatamente o conteúdo do cartão (suup approvals --show): o bot não pode mudá-lo depois.",
  ],
  async run(ctx) {
    const [ref] = ctx.args.positionals as [string];
    const always = flag(ctx.args, "always");
    if ((flag(ctx.args, "global") || flag(ctx.args, "any-args")) && !always) {
      throw new UsageError("--global e --any-args só fazem sentido com --always.", "approve");
    }
    return decideAndReport(ctx, ref, {
      decision: "approved",
      ...(always
        ? {
            always: {
              scope: flag(ctx.args, "global") ? ("global" as const) : ("bot" as const),
              ...(flag(ctx.args, "any-args") ? { matchers: [] } : {}),
            },
          }
        : {}),
    });
  },
};

export const denyCommand: CommandSpec = {
  name: "deny",
  summary: "Nega uma ação que um bot pediu (o bot é avisado e segue com outra abordagem)",
  options: {
    reason: { type: "string", value: "texto", help: "O motivo, que o bot lê" },
  },
  positionals: { names: ["id"] },
  notes: ["Negar não derruba a execução: o bot recebe a negação como resultado e continua."],
  async run(ctx) {
    const [ref] = ctx.args.positionals as [string];
    return decideAndReport(ctx, ref, { decision: "denied", reason: str(ctx.args, "reason") });
  },
};
