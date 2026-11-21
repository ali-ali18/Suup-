import { z } from "zod";
import type { Db } from "./client.js";

/** The ranges the user may choose from (also enforced by the table and by the API). */
export const MEMORY_SETTING_LIMITS = {
  idleMinutes: { min: 1, max: 120 },
  maxTurns: { min: 3, max: 100 },
  promptLimitItems: { min: 20, max: 1000 },
  expiryDays: { min: 7, max: 3650 },
  compactionThreshold: { min: 0.5, max: 0.95 },
} as const;

/**
 * The safety ceiling, in characters, of what always enters the prompt (active rules and profile),
 * whatever the item limit says. Not a setting: it mirrors the 25KB cap of Claude Code's MEMORY.md
 * (docs/pesquisas/memoria-dos-agentes.md). The item limit (default 200, the first 200 lines of
 * MEMORY.md) is the one the user controls.
 */
export const MEMORY_PROMPT_CEILING_CHARS = 25_000;

/** The defaults the owner chose (the table starts with them). */
export const MEMORY_SETTING_DEFAULTS = {
  consolidationEnabled: true,
  idleMinutes: 5,
  maxTurns: 15,
  promptLimitItems: 200,
  expiryDays: 90,
  compactionThreshold: 0.8,
} as const;

export interface MemorySettings {
  /** Whether the background consolidation runs at all. */
  consolidationEnabled: boolean;
  /** A conversation quiet for this long, with new user turns, is consolidated. */
  idleMinutes: number;
  /** ...or when this many user turns piled up since the last consolidation. */
  maxTurns: number;
  /** The most memories (active rules and profile facts) that go into every prompt. */
  promptLimitItems: number;
  /** Notes and journal entries unused for this many days are archived; `null`: never. */
  expiryDays: number | null;
  /** Compact the history when the next request passes this share of the context window. */
  compactionThreshold: number;
  updatedAt: Date;
}

interface SettingsRow {
  consolidation_enabled: boolean;
  idle_minutes: number;
  max_turns: number;
  prompt_limit_items: number;
  expiry_days: number | null;
  compaction_threshold: number;
  updated_at: Date;
}

const map = (r: SettingsRow): MemorySettings => ({
  consolidationEnabled: r.consolidation_enabled,
  idleMinutes: r.idle_minutes,
  maxTurns: r.max_turns,
  promptLimitItems: r.prompt_limit_items,
  expiryDays: r.expiry_days,
  compactionThreshold: Number(r.compaction_threshold),
  updatedAt: r.updated_at,
});

export async function getMemorySettings(db: Db): Promise<MemorySettings> {
  const [row] = await db.sql<SettingsRow[]>`select * from memory_settings`;
  if (row === undefined)
    throw new Error("memory_settings has no row (migration 0017 not applied?)");
  return map(row);
}

const range = (min: number, max: number) => z.number().int().min(min).max(max);
const L = MEMORY_SETTING_LIMITS;

export const memorySettingsPatchSchema = z.strictObject({
  consolidationEnabled: z.exactOptional(z.boolean()),
  idleMinutes: z.exactOptional(range(L.idleMinutes.min, L.idleMinutes.max)),
  maxTurns: z.exactOptional(range(L.maxTurns.min, L.maxTurns.max)),
  promptLimitItems: z.exactOptional(range(L.promptLimitItems.min, L.promptLimitItems.max)),
  expiryDays: z.exactOptional(z.union([range(L.expiryDays.min, L.expiryDays.max), z.null()])),
  compactionThreshold: z.exactOptional(
    z.number().min(L.compactionThreshold.min).max(L.compactionThreshold.max),
  ),
});
export type MemorySettingsPatch = z.input<typeof memorySettingsPatchSchema>;

/** Changes the settings the patch names (the others stay). Throws a `ZodError` outside a range. */
export async function updateMemorySettings(
  db: Db,
  patch: MemorySettingsPatch,
): Promise<MemorySettings> {
  const p = memorySettingsPatchSchema.parse(patch);
  const { sql } = db;
  const [row] = await sql<SettingsRow[]>`
    update memory_settings set
      consolidation_enabled = ${p.consolidationEnabled ?? sql`consolidation_enabled`},
      idle_minutes = ${p.idleMinutes ?? sql`idle_minutes`},
      max_turns = ${p.maxTurns ?? sql`max_turns`},
      prompt_limit_items = ${p.promptLimitItems ?? sql`prompt_limit_items`},
      expiry_days = ${p.expiryDays === undefined ? sql`expiry_days` : p.expiryDays},
      compaction_threshold = ${p.compactionThreshold ?? sql`compaction_threshold`}
    returning *`;
  if (row === undefined) throw new Error("memory_settings has no row");
  return map(row);
}
