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
    const id = card.id.slice(0, 8);
    ctx.out.line(
      card.outbound === null
        ? `  Aprovar: suup approve ${id}   ·   negar: suup deny ${id} --reason "..."`
        : `  Enviar: suup approve ${id}   ·   enviar e permitir este destinatário: suup approve ${id} --allow-recipient   ·   descartar: suup deny ${id} --reason "..."`,
    );
  }
}

export type InlineAnswer = "approved" | "denied" | "later";

const YES = new Set(["s", "sim", "y", "yes", "a", "aprovar"]);
const NO = new Set(["n", "nao", "não", "no", "negar"]);
const ALLOW_RECIPIENT = new Set(["p", "permitir"]);

/** The first word of a line and the rest, split at the first space or tab (no pattern involved). */
function splitFirstWord(text: string): [string, string] {
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === " " || text[i] === "\t") return [text.slice(0, i), text.slice(i + 1).trim()];
  }
  return [text, ""];
}

/**
 * Shows one card and asks. `s` approves, `n [motivo]` denies; for a message to another person
 * `p` also approves and allows exactly this recipient (a standing rule for this bot). Nothing else
 * creates a rule here: standing rules are made in `suup rules`. An empty line (or the end of the
 * input) leaves it pending.
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
      card.outbound === null
        ? "Aprovar? [s] sim · [n] não (n <motivo>) · [Enter] decidir depois > "
        : "Enviar? [s] sim · [p] sim e permitir este destinatário · [n] não (n <motivo>) · [Enter] decidir depois > ",
    );
    const line = await lines.next();
    if (line === null) return "later";
    const text = line.trim();
    if (text === "") return "later";
    const [word, rest] = splitFirstWord(text);
    const key = word.toLowerCase();
    try {
      if (card.outbound !== null && ALLOW_RECIPIENT.has(key)) {
        await decideApproval(db, card.id, { decision: "approved", allowRecipient: true });
        ctx.out.line(
          "Aprovada, e este destinatário passa a ser liberado neste bot (suup rules list).",
        );
        return "approved";
      }
      if (YES.has(key)) {
        await decideApproval(db, card.id, { decision: "approved" });
        ctx.out.line("Aprovada.");
        return "approved";
      }
      if (NO.has(key)) {
        const reason = rest;
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
    ctx.out.line(
      `Não entendi. Responda s, ${card.outbound === null ? "" : "p, "}n, ou Enter para decidir depois.`,
    );
  }
}
