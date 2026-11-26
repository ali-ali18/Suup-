// Owns approving a card by writing in the chat (docs/APROVACOES.md, "Aprovar pelo chat"). When a
// message arrives and the run waits for approval, this decides whether the message is a clear yes
// to the ONE card that waits. Everything about "may the chat decide this card" is structure the
// card carries (secrets, message to another person, the tools whose card is click-only); the only
// judgement is the reviewer's, over the card and the user's text, and only `yes` counts. A yes
// goes through the same `decideApproval` as a click, so a click that arrives first or at the same
// time wins and this does nothing.
import { type ChatApprovalReview, NETWORK_ACCESS_TOOL } from "@suup/core";
import {
  type Approval,
  ApprovalError,
  decideApproval,
  listApprovals,
  type Message,
  type Run,
} from "@suup/db";
import { PROPOSE_CONNECTOR_TOOL } from "./connectors/propose-tool.js";
import type { Runtime } from "./runtime.js";

/**
 * What came of looking at a message as a possible approval:
 * `approved` the card was approved through the chat; `not_a_yes` the reviewer did not read a clear
 * yes (or it failed): the message is only a message; `click_only` the card is one the chat never
 * decides (a secret, a message to another person, the network, a connector); `several_cards` more
 * than one card waits, so the chat approves none; `stopping` a stop request came with it;
 * `unavailable` there is no model to read it; `already_decided` a click got there first.
 */
export const CHAT_APPROVAL_OUTCOMES = [
  "approved",
  "not_a_yes",
  "click_only",
  "several_cards",
  "stopping",
  "unavailable",
  "already_decided",
] as const;
export type ChatApprovalOutcome = {
  outcome: (typeof CHAT_APPROVAL_OUTCOMES)[number];
  approvalId?: string;
};

/** The tools whose card is click-only, whatever else the card says. */
const CLICK_ONLY_TOOLS: readonly string[] = [NETWORK_ACCESS_TOOL, PROPOSE_CONNECTOR_TOOL];

/** Click-only by what the card declares: a secret, a destination for it, a message to another person. */
export function cardIsClickOnly(card: Approval): boolean {
  return (
    card.secrets.length > 0 ||
    (card.secretHost ?? null) !== null ||
    card.outbound !== null ||
    CLICK_ONLY_TOOLS.includes(card.tool)
  );
}

export async function approveByChat(
  runtime: Runtime,
  run: Run,
  message: Message,
  text: string,
): Promise<ChatApprovalOutcome> {
  const { db } = runtime;
  const pending = await listApprovals(db, { status: "pending", runId: run.id, limit: 3 });
  const [card] = pending;
  if (card === undefined) return { outcome: "already_decided" };
  if (pending.length > 1) return { outcome: "several_cards" };
  if (cardIsClickOnly(card)) return { outcome: "click_only", approvalId: card.id };
  // A stop request of the user wins over any reading of the text.
  const [stop] = await db.sql<{ n: number }[]>`
    select count(*)::int as n from run_inbox
    where run_id = ${run.id} and kind = 'stop' and consumed_at is null`;
  if ((stop?.n ?? 0) > 0) return { outcome: "stopping" };
  const judge = runtime.chatApprovalJudge();
  if (judge === undefined) return { outcome: "unavailable" };
  const verdict = await judge.judge(
    { tool: card.tool, summary: card.summary, args: card.args, level: card.level },
    text,
  );
  if (verdict.answer !== "yes" || verdict.failure !== undefined) {
    return { outcome: "not_a_yes", approvalId: card.id };
  }
  const review: ChatApprovalReview = {
    answer: "yes",
    reason: verdict.reason,
    model: verdict.model,
    promptVersion: verdict.promptVersion,
    usage: verdict.usage,
    costUsd: verdict.costUsd,
    latencyMs: verdict.latencyMs,
  };
  try {
    await decideApproval(db, card.id, {
      decision: "approved",
      viaChat: { messageId: message.id, review },
    });
  } catch (error) {
    if (error instanceof ApprovalError) return { outcome: "already_decided", approvalId: card.id };
    throw error;
  }
  return { outcome: "approved", approvalId: card.id };
}
