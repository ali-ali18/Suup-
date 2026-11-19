// What the mappers need from `@suup/db` and `@suup/core`, in one place.
import { runResultSchema } from "@suup/core";
import type { JsonValue } from "@suup/db";

export type {
  Approval,
  BotSummary,
  ConversationView,
  Memory,
  Message,
  Run,
  RunEvent,
  SecretMeta,
  StoredRule,
} from "@suup/db";

/** A finished run's `result` as the wire carries it, or `null` when it has none (or an old shape). */
export function runResultOrNull(
  result: JsonValue | null,
): { summary: string; evidence?: { criterion: string; evidence: string }[] } | null {
  if (result === null) return null;
  const parsed = runResultSchema.safeParse(result);
  if (!parsed.success) return null;
  return {
    summary: parsed.data.summary,
    ...(parsed.data.evidence === undefined ? {} : { evidence: parsed.data.evidence }),
  };
}
