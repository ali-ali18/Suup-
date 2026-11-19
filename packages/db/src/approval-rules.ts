// Owns the user's standing rules about tool calls (table `approval_rules`, migration 0011).
import { type ApprovalRule, type ArgMatcher, argMatcherSchema } from "@suup/core";
import { z } from "zod";
import type { Db } from "./client.js";

export type RuleCreator = "user" | "approval";

export interface StoredRule {
  id: string;
  /** `null`: every bot. */
  botId: string | null;
  /** A tool name, or `*`. */
  tool: string;
  effect: "allow" | "deny";
  matchers: ArgMatcher[];
  note: string | null;
  createdBy: RuleCreator;
  sourceApprovalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RuleRow {
  id: string;
  bot_id: string | null;
  tool: string;
  effect: "allow" | "deny";
  matchers: unknown;
  note: string | null;
  created_by: RuleCreator;
  source_approval_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const matchersSchema = z.array(argMatcherSchema).max(20);

function mapRule(row: RuleRow): StoredRule {
  return {
    id: row.id,
    botId: row.bot_id,
    tool: row.tool,
    effect: row.effect,
    matchers: matchersSchema.parse(row.matchers),
    note: row.note,
    createdBy: row.created_by,
    sourceApprovalId: row.source_approval_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateRuleInput {
  botId?: string | null;
  tool: string;
  effect: "allow" | "deny";
  matchers?: ArgMatcher[];
  note?: string | undefined;
  createdBy?: RuleCreator;
  sourceApprovalId?: string;
}

const createSchema = z.object({
  botId: z.uuid().nullable().optional(),
  tool: z.string().min(1).max(64),
  effect: z.enum(["allow", "deny"]),
  matchers: matchersSchema.optional(),
  note: z.string().max(500).optional(),
  createdBy: z.enum(["user", "approval"]).optional(),
  sourceApprovalId: z.uuid().optional(),
});

/** Creates a rule (in the caller's transaction when `db` is one). */
export async function createRuleRow(db: Db, input: CreateRuleInput): Promise<StoredRule> {
  const rule = createSchema.parse(input);
  const [row] = await db.sql<RuleRow[]>`
    insert into approval_rules (bot_id, tool, effect, matchers, note, created_by, source_approval_id)
    values (${rule.botId ?? null}, ${rule.tool}, ${rule.effect}, ${db.sql.json(rule.matchers ?? [])},
            ${rule.note ?? null}, ${rule.createdBy ?? "user"}, ${rule.sourceApprovalId ?? null})
    returning *`;
  if (row === undefined) throw new Error("insert into approval_rules returned no row");
  return mapRule(row);
}

export const createRule = createRuleRow;

export async function getRule(db: Db, id: string): Promise<StoredRule | null> {
  const [row] = await db.sql<
    RuleRow[]
  >`select * from approval_rules where id = ${z.uuid().parse(id)}`;
  return row === undefined ? null : mapRule(row);
}

export interface ListRulesOptions {
  /** Only the rules that apply to this bot: its own and the global ones. */
  botId?: string;
}

/** Oldest first (the order is part of how ties between rules are broken). */
export async function listRules(db: Db, opts: ListRulesOptions = {}): Promise<StoredRule[]> {
  const rows = await db.sql<RuleRow[]>`
    select * from approval_rules
    where ${opts.botId === undefined ? db.sql`true` : db.sql`(bot_id is null or bot_id = ${opts.botId})`}
    order by created_at, id`;
  return rows.map(mapRule);
}

export interface UpdateRuleInput {
  effect?: "allow" | "deny";
  matchers?: ArgMatcher[];
  /** `null` clears the note. */
  note?: string | null;
}

export async function updateRule(
  db: Db,
  id: string,
  input: UpdateRuleInput,
): Promise<StoredRule | null> {
  const patch = z
    .object({
      effect: z.enum(["allow", "deny"]).optional(),
      matchers: matchersSchema.optional(),
      note: z.string().max(500).nullable().optional(),
    })
    .parse(input);
  const [row] = await db.sql<RuleRow[]>`
    update approval_rules set
      effect = coalesce(${patch.effect ?? null}, effect),
      matchers = case when ${patch.matchers !== undefined} then ${db.sql.json(patch.matchers ?? [])} else matchers end,
      note = case when ${patch.note !== undefined} then ${patch.note ?? null} else note end
    where id = ${z.uuid().parse(id)}
    returning *`;
  return row === undefined ? null : mapRule(row);
}

export async function deleteRule(db: Db, id: string): Promise<boolean> {
  const rows =
    await db.sql`delete from approval_rules where id = ${z.uuid().parse(id)} returning id`;
  return rows.length > 0;
}

/** The rules of one bot in the shape the policy uses. */
export async function rulesForBot(db: Db, botId: string): Promise<ApprovalRule[]> {
  const rules = await listRules(db, { botId });
  return rules.map((r) => ({
    id: r.id,
    botId: r.botId,
    tool: r.tool,
    effect: r.effect,
    matchers: r.matchers,
    ...(r.note === null ? {} : { note: r.note }),
  }));
}
