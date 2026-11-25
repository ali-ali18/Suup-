import { CONVERSATION_ORIGINS, FINISH_TOOL_NAME } from "@suup/core";
import { z } from "zod";
import type { Db } from "./client.js";
import { ConversationNotFoundError, ConversationRuleError } from "./conversations.js";
import { appendMessageOnce } from "./messages.js";

// What the bot wrote in a turn that also called tools ("vou conferir...", then the card) is part of
// the answer the chat shows, in the order it happened (KOD-64, docs/pesquisas/kod-64-...). Each text
// block of the model's response becomes one bot message, written in the same transaction as the
// `model_response` event, so the log and the chat never disagree and a redelivery cannot write it
// twice: the key is the run, the position of the event and the position of the block.
//
// Nothing here reads or compares text. The decisions come from the structure of the response: the
// kind of each block, the name of each call (exact), and the declared origin of the run.

const blocksSchema = z.object({
  blocks: z.array(
    z.looseObject({
      type: z.string(),
      text: z.exactOptional(z.string()),
      name: z.exactOptional(z.string()),
    }),
  ),
  purpose: z.exactOptional(z.string()),
});

/** The run that answers the user in a conversation: only those post parts. */
const PART_ORIGINS: ReadonlySet<string> = CONVERSATION_ORIGINS;

/** The tool that ends the run with its own summary: a turn that calls it posts no part. */
const FINISH_TOOL = FINISH_TOOL_NAME;

/** The key of one part: unique per run, event and block. */
export function partKey(runId: string, eventSeq: number, blockIndex: number): string {
  return `run:${runId}:part:${eventSeq}:${blockIndex}`;
}

/** The texts of a response that become parts, with the index of their block; none for the others. */
export function partsOfResponse(payload: unknown): { index: number; text: string }[] {
  const parsed = blocksSchema.safeParse(payload);
  if (!parsed.success) return [];
  const { blocks, purpose } = parsed.data;
  // A call of the reviewer, the compaction or the watchdog is not the bot talking.
  if (purpose !== undefined) return [];
  if (!blocks.some((b) => b.type === "tool_call")) return [];
  // The summary of `finish` is the end message: the words of that turn would repeat it.
  if (blocks.some((b) => b.type === "tool_call" && b.name === FINISH_TOOL)) return [];
  const out: { index: number; text: string }[] = [];
  blocks.forEach((b, index) => {
    const text = b.type === "text" ? (b.text ?? "").trim() : "";
    if (text !== "") out.push({ index, text });
  });
  return out;
}

/** Whether a response of this payload posts parts (decided before any lock is taken). */
export function hasParts(payload: unknown): boolean {
  return partsOfResponse(payload).length > 0;
}

/**
 * Writes the parts of a `model_response` event, inside the transaction that appends it. Idempotent
 * (the key). A run that is not a conversation answer, or whose conversation is archived, writes
 * nothing, and never keeps the event from being logged.
 */
export async function writeTurnParts(
  tx: Db,
  run: { id: string; botId: string; conversationId: string | null; origin: string },
  eventSeq: number,
  payload: unknown,
): Promise<number> {
  if (run.conversationId === null || !PART_ORIGINS.has(run.origin)) return 0;
  let written = 0;
  for (const part of partsOfResponse(payload)) {
    try {
      const { created } = await appendMessageOnce(tx, {
        conversationId: run.conversationId,
        authorKind: "bot",
        authorBotId: run.botId,
        text: part.text,
        runId: run.id,
        dedupeKey: partKey(run.id, eventSeq, part.index),
        eventSeq,
        attachFiles: false,
      });
      if (created) written++;
    } catch (error) {
      if (error instanceof ConversationRuleError || error instanceof ConversationNotFoundError) {
        return written;
      }
      throw error;
    }
  }
  return written;
}
