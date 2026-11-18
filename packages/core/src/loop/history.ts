// Owns turning the recorded conversation history into the messages that open a request: text only,
// strictly alternating roles, starting with a user message, the harness note first.
import type { Message } from "../messages.js";
import { renderHistoryNote } from "./prompts.js";

/**
 * The messages to place before the objective. Pure and deterministic, so the same recorded
 * snapshot always gives the same request prefix.
 *
 * - only text blocks are kept (history is plain text; anything else is dropped);
 * - blank messages are dropped, and neighbours with the same role are merged, so roles alternate;
 * - leading assistant messages are dropped (a conversation starts with the user);
 * - the note, if any, opens the first user message (or is a user message of its own).
 *
 * The last message may be a user message: it is then merged with the objective message.
 */
export function historyMessages(history: readonly Message[], note: string | undefined): Message[] {
  const out: Message[] = [];
  for (const message of history) {
    const blocks = message.blocks.flatMap((b) =>
      b.type === "text" && b.text.trim() !== "" ? [{ type: "text" as const, text: b.text }] : [],
    );
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.role === message.role) last.blocks.push(...blocks);
    else if (last !== undefined || message.role === "user") {
      out.push({ role: message.role, blocks });
    }
  }
  const trimmed = note?.trim();
  if (trimmed !== undefined && trimmed !== "") {
    const noteBlock = { type: "text" as const, text: renderHistoryNote(trimmed) };
    const first = out[0];
    if (first === undefined) out.push({ role: "user", blocks: [noteBlock] });
    else first.blocks.unshift(noteBlock);
  }
  return out;
}
