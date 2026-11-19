// Owns the rules the user WRITES in plain language (table `written_rules`, migration 0016) and the
// approval mode (table `approval_settings`). The text is free prose that the model reviewer reads:
// nothing here parses or matches it. Only an explicit act of the user creates a rule.
import {
  type ApprovalMode,
  approvalModeSchema,
  DEFAULT_APPROVAL_MODE,
  MAX_WRITTEN_RULES,
  type WrittenRule,
  type WrittenRuleKind,
  writtenRuleKindSchema,
  writtenRuleTextSchema,
} from "@suup/core";
import { z } from "zod";
import type { Db } from "./client.js";

export interface StoredWrittenRule {
  id: string;
  kind: WrittenRuleKind;
  text: string;
  /** `null`: every bot. */
  botId: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface WrittenRuleRow {
  id: string;
  kind: WrittenRuleKind;
  text: string;
  bot_id: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const map = (row: WrittenRuleRow): StoredWrittenRule => ({
  id: row.id,
  kind: row.kind,
  text: row.text,
  botId: row.bot_id,
  enabled: row.enabled,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type WrittenRuleErrorCode = "not_found" | "conflict";

export class WrittenRuleError extends Error {
  override readonly name = "WrittenRuleError";
  constructor(
    readonly code: WrittenRuleErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface CreateWrittenRuleInput {
  kind: WrittenRuleKind;
  text: string;
  botId?: string | null;
  enabled?: boolean;
}

const createSchema = z.object({
  kind: writtenRuleKindSchema,
  text: writtenRuleTextSchema,
  botId: z.uuid().nullable().optional(),
  enabled: z.boolean().optional(),
});

export async function createWrittenRule(
  db: Db,
  input: CreateWrittenRuleInput,
): Promise<StoredWrittenRule> {
  const rule = createSchema.parse(input);
  const [count] = await db.sql<{ n: number }[]>`select count(*)::int as n from written_rules`;
  if ((count?.n ?? 0) >= MAX_WRITTEN_RULES) {
    throw new WrittenRuleError(
      "conflict",
      `Já existem ${MAX_WRITTEN_RULES} regras escritas: apague alguma antes de criar outra.`,
    );
  }
  const [row] = await db.sql<WrittenRuleRow[]>`
    insert into written_rules (kind, text, bot_id, enabled)
    values (${rule.kind}, ${rule.text}, ${rule.botId ?? null}, ${rule.enabled ?? true})
    returning *`;
  if (row === undefined) throw new Error("insert into written_rules returned no row");
  return map(row);
}

export async function getWrittenRule(db: Db, id: string): Promise<StoredWrittenRule | null> {
  const [row] = await db.sql<
    WrittenRuleRow[]
  >`select * from written_rules where id = ${z.uuid().parse(id)}`;
  return row === undefined ? null : map(row);
}

export interface ListWrittenRulesOptions {
  /** Only the rules that apply to this bot: its own and the ones for every bot. */
  botId?: string;
}

/** Oldest first. */
export async function listWrittenRules(
  db: Db,
  opts: ListWrittenRulesOptions = {},
): Promise<StoredWrittenRule[]> {
  const rows = await db.sql<WrittenRuleRow[]>`
    select * from written_rules
    where ${opts.botId === undefined ? db.sql`true` : db.sql`(bot_id is null or bot_id = ${z.uuid().parse(opts.botId)})`}
    order by created_at, id`;
  return rows.map(map);
}

export interface UpdateWrittenRuleInput {
  kind?: WrittenRuleKind;
  text?: string;
  enabled?: boolean;
}

export async function updateWrittenRule(
  db: Db,
  id: string,
  input: UpdateWrittenRuleInput,
): Promise<StoredWrittenRule | null> {
  const patch = z
    .object({
      kind: writtenRuleKindSchema.optional(),
      text: writtenRuleTextSchema.optional(),
      enabled: z.boolean().optional(),
    })
    .parse(input);
  const [row] = await db.sql<WrittenRuleRow[]>`
    update written_rules set
      kind = coalesce(${patch.kind ?? null}, kind),
      text = coalesce(${patch.text ?? null}, text),
      enabled = coalesce(${patch.enabled ?? null}, enabled)
    where id = ${z.uuid().parse(id)}
    returning *`;
  return row === undefined ? null : map(row);
}

export async function deleteWrittenRule(db: Db, id: string): Promise<boolean> {
  const rows =
    await db.sql`delete from written_rules where id = ${z.uuid().parse(id)} returning id`;
  return rows.length > 0;
}

/** The ENABLED written rules that apply to one bot, in the shape the model reviewer reads. */
export async function writtenRulesForBot(db: Db, botId: string): Promise<WrittenRule[]> {
  const rules = (await listWrittenRules(db, { botId })).filter((r) => r.enabled);
  return rules.map((r) => ({ id: r.id, kind: r.kind, text: r.text, botId: r.botId }));
}

// ---- the approval mode -----------------------------------------------------------------

export async function getApprovalMode(db: Db): Promise<ApprovalMode> {
  const [row] = await db.sql<{ mode: string }[]>`select mode from approval_settings`;
  return row === undefined ? DEFAULT_APPROVAL_MODE : approvalModeSchema.parse(row.mode);
}

export async function setApprovalMode(db: Db, mode: ApprovalMode): Promise<ApprovalMode> {
  const next = approvalModeSchema.parse(mode);
  await db.sql`
    insert into approval_settings (singleton, mode) values (true, ${next})
    on conflict (singleton) do update set mode = excluded.mode`;
  return next;
}
