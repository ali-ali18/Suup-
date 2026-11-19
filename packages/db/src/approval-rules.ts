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
  /** Exact equality of named arguments; empty means any use of the tool. */
  matchers: ArgMatcher[];
  /**
   * `false`: the rule does not apply. Today the only reason is migration 0013, which disabled the
   * rules that used a comparison that no longer exists (`disabledReason` says which).
   */
  enabled: boolean;
  disabledReason: string | null;
  /** The stored conditions still hold a comparison other than equality: it cannot be enabled as is. */
  hasRemovedConditions: boolean;
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
  enabled: boolean;
  disabled_reason: string | null;
  note: string | null;
  created_by: RuleCreator;
  source_approval_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const matchersSchema = z.array(argMatcherSchema).max(20);

/** What an older version stored: a condition with an `op`. Only `equals` still means something. */
const storedMatchersSchema = z
  .array(z.object({ field: z.string(), op: z.string().optional(), value: z.string() }))
  .max(20);

function mapRule(row: RuleRow): StoredRule {
  const stored = storedMatchersSchema.parse(row.matchers);
  const exact = stored.filter((m) => m.op === undefined || m.op === "equals");
  return {
    id: row.id,
    botId: row.bot_id,
    tool: row.tool,
    effect: row.effect,
    matchers: exact.map((m) => ({ field: m.field, value: m.value })),
    enabled: row.enabled,
    disabledReason: row.disabled_reason,
    hasRemovedConditions: exact.length !== stored.length,
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
  /**
   * `true` turns a disabled rule on: refused while its stored conditions still hold a removed
   * comparison (replace the conditions in the same call). `false` turns it off.
   */
  enabled?: boolean;
}

export type RuleErrorCode = "not_found" | "conflict";

export class RuleError extends Error {
  override readonly name = "RuleError";
  constructor(
    readonly code: RuleErrorCode,
    message: string,
  ) {
    super(message);
  }
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
      enabled: z.boolean().optional(),
    })
    .parse(input);
  const ruleId = z.uuid().parse(id);
  const current = await getRule(db, ruleId);
  if (current === null) return null;
  if (patch.enabled === true && current.hasRemovedConditions && patch.matchers === undefined) {
    throw new RuleError(
      "conflict",
      "Esta regra usava uma condição por padrão, que não existe mais: troque as condições por valores exatos para ativá-la.",
    );
  }
  const enabled = patch.enabled ?? current.enabled;
  const [row] = await db.sql<RuleRow[]>`
    update approval_rules set
      effect = coalesce(${patch.effect ?? null}, effect),
      matchers = case when ${patch.matchers !== undefined} then ${db.sql.json(patch.matchers ?? [])} else matchers end,
      note = case when ${patch.note !== undefined} then ${patch.note ?? null} else note end,
      enabled = ${enabled},
      disabled_reason = case when ${enabled} then null
        else coalesce(disabled_reason, 'Desativada por você.') end
    where id = ${ruleId}
    returning *`;
  return row === undefined ? null : mapRule(row);
}

export async function deleteRule(db: Db, id: string): Promise<boolean> {
  const rows =
    await db.sql`delete from approval_rules where id = ${z.uuid().parse(id)} returning id`;
  return rows.length > 0;
}

/** The rules of one bot in the shape the policy uses (the disabled ones do not apply). */
export async function rulesForBot(db: Db, botId: string): Promise<ApprovalRule[]> {
  const rules = (await listRules(db, { botId })).filter((r) => r.enabled);
  return rules.map((r) => ({
    id: r.id,
    botId: r.botId,
    tool: r.tool,
    effect: r.effect,
    matchers: r.matchers,
    ...(r.note === null ? {} : { note: r.note }),
  }));
}
