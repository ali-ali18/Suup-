// Owns showing an approval card in the terminal and taking the person's answer to it: shared by
// `suup chat` (which asks inline), `suup run` and `suup resume` (which print the card and say how
// to answer it).
import { type Approval, type Db, decideApproval, listApprovals } from "@suup/db";
import type { Ctx } from "./context.js";
import type { LineQueue } from "./follow.js";
import { renderApprovalCard } from "./render.js";

/** The cards of a run that still wait for the person. */
export async function pendingCards(db: Db, runId: string): Promise<Approval[]> {
  return listApprovals(db, { runId, status: "pending", limit: 20 });
}

/** Prints the cards and how to answer them (for a terminal that cannot ask, or a `--json` stream). */
export function printCards(ctx: Ctx, cards: readonly Approval[]): void {
  for (const card of cards) {
    if (ctx.json) {
      ctx.out.ndjson({
        type: "approval",
        id: card.id,
        runId: card.runId,
        tool: card.tool,
        level: card.level,
        summary: card.summary,
        args: card.args,
        secrets: card.secrets,
      });
      continue;
    }
    ctx.out.lines(renderApprovalCard(card));
    ctx.out.line(
      `  Aprovar: suup approve ${card.id.slice(0, 8)}   ·   sempre permitir: suup approve ${card.id.slice(0, 8)} --always   ·   negar: suup deny ${card.id.slice(0, 8)} --reason "..."`,
    );
  }
}

export type InlineAnswer = "approved" | "denied" | "later";

const YES = new Set(["s", "sim", "y", "yes", "a", "aprovar"]);
const NO = new Set(["n", "nao", "não", "no", "negar"]);
const ALWAYS = new Set(["sempre", "always", "!"]);

/**
 * Shows one card and asks. `s` approves, `n [motivo]` denies, `sempre` approves and creates a rule
 * for equal calls of this bot; an empty line (or the end of the input) leaves it pending.
 */
export async function askInline(
  ctx: Ctx,
  lines: LineQueue,
  card: Approval,
  botName: string,
): Promise<InlineAnswer> {
  const db = ctx.runtime().db;
  ctx.out.line(`${botName} quer fazer isto e espera a sua decisão:`);
  ctx.out.lines(renderApprovalCard(card));
  for (;;) {
    ctx.out.raw(
      "Aprovar? [s] sim · [n] não (n <motivo>) · [sempre] sim e sempre permitir igual · [Enter] decidir depois > ",
    );
    const line = await lines.next();
    if (line === null) return "later";
    const text = line.trim();
    if (text === "") return "later";
    const [word = "", ...rest] = text.split(/\s+/);
    const key = word.toLowerCase();
    try {
      if (ALWAYS.has(key)) {
        await decideApproval(db, card.id, {
          decision: "approved",
          always: { scope: "bot" },
        });
        ctx.out.line(
          "Aprovada, e as chamadas iguais a esta deste bot passam a ser liberadas (suup rules list).",
        );
        return "approved";
      }
      if (YES.has(key)) {
        await decideApproval(db, card.id, { decision: "approved" });
        ctx.out.line("Aprovada.");
        return "approved";
      }
      if (NO.has(key)) {
        const reason = rest.join(" ").trim();
        await decideApproval(db, card.id, {
          decision: "denied",
          ...(reason === "" ? {} : { reason }),
        });
        ctx.out.line("Negada: o bot foi avisado e segue sem fazer isso.");
        return "denied";
      }
    } catch (error) {
      ctx.out.err(error instanceof Error ? error.message : String(error));
      return "later";
    }
    ctx.out.line("Não entendi. Responda s, n, sempre, ou Enter para decidir depois.");
  }
}
