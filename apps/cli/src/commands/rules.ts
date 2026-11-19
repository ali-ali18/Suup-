import type { ArgMatcher, MatchOp } from "@suup/core";
import {
  createRule,
  deleteRule,
  getRule,
  listBots,
  listRules,
  type StoredRule,
  updateRule,
} from "@suup/db";
import { list, str } from "../args.js";
import type { CommandSpec } from "../context.js";
import { CommandError, EXIT_OK, UsageError } from "../errors.js";
import { formatDateTime, oneLine } from "../format.js";
import { findBot } from "../lookup.js";
import { renderTable } from "../table.js";

function ruleJson(r: StoredRule) {
  return {
    id: r.id,
    botId: r.botId,
    tool: r.tool,
    effect: r.effect,
    matchers: r.matchers,
    note: r.note,
    createdBy: r.createdBy,
    sourceApprovalId: r.sourceApprovalId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** `campo=valor` (igual), `campo^=valor` (começa com), `campo~=valor` (contém), `campo*=padrão` (glob). */
export function parseMatcher(text: string, command: string): ArgMatcher {
  const found = /^([A-Za-z0-9_.-]+)(\*=|\^=|~=|=)([\s\S]*)$/.exec(text);
  if (found === null) {
    throw new UsageError(
      `Condição inválida: ${JSON.stringify(text)}. Use campo=valor, campo^=início, campo~=trecho ou campo*=padrão (com * e ?).`,
      command,
    );
  }
  const ops: Record<string, MatchOp> = {
    "=": "equals",
    "^=": "starts_with",
    "~=": "contains",
    "*=": "glob",
  };
  return {
    field: found[1] as string,
    op: ops[found[2] as string] as MatchOp,
    value: found[3] as string,
  };
}

async function findRule(ctx: Parameters<CommandSpec["run"]>[0], ref: string): Promise<StoredRule> {
  const db = ctx.runtime().db;
  const rows = await db.sql<{ id: string }[]>`
    select id from approval_rules where id::text like ${`${ref.toLowerCase()}%`} limit 5`;
  if (!/^[0-9a-f][0-9a-f-]{3,35}$/i.test(ref) || rows.length === 0) {
    throw new CommandError(`Regra não encontrada: ${JSON.stringify(ref)}. Veja: suup rules list`);
  }
  if (rows.length > 1) {
    throw new CommandError(
      `${JSON.stringify(ref)} corresponde a mais de uma regra. Use mais caracteres do id.`,
    );
  }
  const rule = await getRule(db, (rows[0] as { id: string }).id);
  if (rule === null) throw new CommandError(`Regra não encontrada: ${ref}.`);
  return rule;
}

export const rulesList: CommandSpec = {
  name: "rules list",
  summary: "Lista as regras de aprovação (o que sempre pode ou nunca pode, por bot ou para todos)",
  options: {
    bot: { type: "string", value: "bot", help: "Só as regras que valem para este bot" },
  },
  positionals: { names: [] },
  notes: [
    "Uma regra que proíbe vale mais que uma que libera. Sem regra, o nível de risco decide: leitura e escrita reversível",
    "passam; o que sai para o mundo ou não tem volta vira cartão (suup approvals).",
  ],
  async run(ctx) {
    const db = ctx.runtime().db;
    const botRef = str(ctx.args, "bot");
    const bot = botRef === undefined ? undefined : await findBot(db, botRef);
    const rules = await listRules(db, bot === undefined ? {} : { botId: bot.id });
    if (ctx.json) {
      ctx.out.data(rules.map(ruleJson));
      return EXIT_OK;
    }
    if (rules.length === 0) {
      ctx.out.line(
        'Nenhuma regra. Para criar uma: suup rules add --tool shell --effect allow --match "command^=git status"',
      );
      return EXIT_OK;
    }
    const names = new Map(
      (await listBots(db, { includeArchived: true })).map((b) => [b.id, b.name]),
    );
    ctx.out.lines(
      renderTable(
        ["ID", "EFEITO", "DE", "FERRAMENTA", "CONDIÇÕES", "CRIADA", "NOTA"],
        rules.map((r) => [
          r.id.slice(0, 8),
          r.effect === "allow" ? "libera" : "proíbe",
          r.botId === null ? "todos" : (names.get(r.botId) ?? r.botId.slice(0, 8)),
          r.tool,
          r.matchers.length === 0
            ? "(qualquer chamada)"
            : r.matchers.map((m) => `${m.field} ${m.op} ${JSON.stringify(m.value)}`).join(" e "),
          `${formatDateTime(r.createdAt)}${r.createdBy === "approval" ? " (de um cartão)" : ""}`,
          oneLine(r.note ?? "", 40),
        ]),
      ),
    );
    return EXIT_OK;
  },
};

export const rulesAdd: CommandSpec = {
  name: "rules add",
  summary:
    "Cria uma regra: libera ou proíbe uma ferramenta (com condições opcionais nos argumentos)",
  options: {
    tool: {
      type: "string",
      value: "ferramenta",
      help: "Nome da ferramenta, ou * para qualquer uma",
    },
    effect: { type: "string", value: "allow|deny", help: "allow libera, deny proíbe" },
    bot: {
      type: "string",
      value: "bot",
      help: "Vale só para este bot (sem isto, vale para todos)",
    },
    match: {
      type: "string",
      value: "condição",
      multiple: true,
      help: "Condição sobre um argumento (repita para várias, todas valem): campo=valor, campo^=início, campo~=trecho, campo*=padrão",
    },
    note: { type: "string", value: "texto", help: "Uma anotação sua sobre a regra" },
  },
  positionals: { names: [] },
  notes: [
    'Exemplo: suup rules add --tool shell --effect allow --bot ajudante --match "command^=git push origin"',
    "As condições olham os argumentos como o modelo os escreveu (um segredo aparece como {{secret:NOME}}).",
  ],
  async run(ctx) {
    const tool = str(ctx.args, "tool");
    const effect = str(ctx.args, "effect");
    if (tool === undefined) throw new UsageError("Falta --tool.", "rules add");
    if (effect !== "allow" && effect !== "deny") {
      throw new UsageError("--effect precisa ser allow ou deny.", "rules add");
    }
    const db = ctx.runtime().db;
    const botRef = str(ctx.args, "bot");
    const bot = botRef === undefined ? undefined : await findBot(db, botRef);
    const matchers = list(ctx.args, "match").map((m) => parseMatcher(m, "rules add"));
    const rule = await createRule(db, {
      tool,
      effect,
      botId: bot?.id ?? null,
      matchers,
      ...(str(ctx.args, "note") === undefined ? {} : { note: str(ctx.args, "note") }),
    });
    if (ctx.json) ctx.out.data(ruleJson(rule));
    else
      ctx.out.line(
        `Regra criada: ${rule.id.slice(0, 8)} (${rule.effect === "allow" ? "libera" : "proíbe"} ${rule.tool}).`,
      );
    return EXIT_OK;
  },
};

export const rulesEdit: CommandSpec = {
  name: "rules edit",
  summary: "Muda o efeito ou a anotação de uma regra",
  options: {
    effect: { type: "string", value: "allow|deny", help: "Novo efeito" },
    note: { type: "string", value: "texto", help: "Nova anotação" },
  },
  positionals: { names: ["id"] },
  notes: [],
  async run(ctx) {
    const [ref] = ctx.args.positionals as [string];
    const effect = str(ctx.args, "effect");
    if (effect !== undefined && effect !== "allow" && effect !== "deny") {
      throw new UsageError("--effect precisa ser allow ou deny.", "rules edit");
    }
    const note = str(ctx.args, "note");
    if (effect === undefined && note === undefined) {
      throw new UsageError("Diga o que mudar: --effect e/ou --note.", "rules edit");
    }
    const found = await findRule(ctx, ref);
    const rule = await updateRule(ctx.runtime().db, found.id, {
      ...(effect === undefined ? {} : { effect }),
      ...(note === undefined ? {} : { note }),
    });
    if (rule === null) throw new CommandError("Regra não encontrada.");
    if (ctx.json) ctx.out.data(ruleJson(rule));
    else ctx.out.line(`Regra ${rule.id.slice(0, 8)} atualizada.`);
    return EXIT_OK;
  },
};

export const rulesRemove: CommandSpec = {
  name: "rules rm",
  summary: "Apaga uma regra",
  options: {},
  positionals: { names: ["id"] },
  notes: [],
  async run(ctx) {
    const [ref] = ctx.args.positionals as [string];
    const rule = await findRule(ctx, ref);
    await deleteRule(ctx.runtime().db, rule.id);
    if (ctx.json) ctx.out.data({ deleted: rule.id });
    else ctx.out.line(`Regra ${rule.id.slice(0, 8)} apagada.`);
    return EXIT_OK;
  },
};
