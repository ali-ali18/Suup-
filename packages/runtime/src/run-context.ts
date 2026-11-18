import type { Message, RunContextSnapshot } from "@suup/core";
import {
  type Message as ChatMessage,
  type Db,
  getRun,
  listMessages,
  memoryContextFor,
} from "@suup/db";

/** Characters of conversation history a run gets when the configuration does not say. */
export const DEFAULT_HISTORY_CHARS = 12_000;

const PAGE = 100;

/** A system message (a failure or cancellation notice) as a bracketed note, in the user's turn. */
const systemNote = (text: string): string => `[System message: ${text}]`;

/**
 * The context a run starts with (it is recorded once as `context_loaded`):
 *
 * - `rules` and `profile` from `memoryContextFor`, in its stable order;
 * - for a run that belongs to a conversation, `history`: the messages BEFORE the one that opened
 *   the run, newest first within `historyChars` characters, cut on whole messages, then put back
 *   in order. User messages are user turns and bot messages are assistant turns; consecutive ones
 *   of the same role are merged, so roles alternate. System messages (the notices of a failed or
 *   cancelled run) are kept, as a bracketed note inside the user turn next to them: the model
 *   learns that something did not finish, and none of it becomes a claim by the assistant.
 * - `historyNote` when older messages were left out, pointing to `search_conversations`.
 *
 * A run without a conversation (a routine, a delegation, `suup run`) gets rules and profile only.
 */
export async function loadRunContext(
  db: Db,
  runId: string,
  historyChars: number = DEFAULT_HISTORY_CHARS,
): Promise<RunContextSnapshot> {
  const run = await getRun(db, runId);
  if (run === null) throw new Error(`run ${runId} not found`);
  const memory = await memoryContextFor(db, run.botId);
  const rules = memory.rules.map((m) => ({ id: m.id, text: m.text }));
  const profile = memory.profile.map((m) => ({ id: m.id, text: m.text }));
  if (run.conversationId === null || run.conversationId === undefined) {
    return { rules, profile, history: [] };
  }

  // Everything before the message that opened this run.
  const [opening] = await db.sql<{ seq: string }[]>`
    select seq from messages
    where conversation_id = ${run.conversationId} and run_id = ${runId} and author_kind = 'user'
    order by seq limit 1`;
  let before = opening === undefined ? Number.POSITIVE_INFINITY : Number(opening.seq);

  const picked: ChatMessage[] = [];
  let used = 0;
  let omitted = false;
  fill: for (;;) {
    const page = await listMessages(db, run.conversationId, {
      limit: PAGE,
      ...(Number.isFinite(before) ? { beforeSeq: before } : {}),
    });
    if (page.length === 0) break;
    for (let i = page.length - 1; i >= 0; i--) {
      const message = page[i] as ChatMessage;
      const cost = textOf(message).length;
      if (used + cost > historyChars) {
        omitted = true;
        break fill;
      }
      picked.push(message);
      used += cost;
    }
    const oldest = page[0] as ChatMessage;
    if (page.length < PAGE || oldest.seq <= 1) break;
    before = oldest.seq;
  }
  picked.reverse();

  const history = toTurns(picked);
  const first = picked[0];
  const hidden = first === undefined ? 0 : first.seq - 1;
  const note = omitted
    ? `The conversation has earlier messages that are not shown here (${hidden > 0 ? `${hidden} older than the ones above` : "all of them"}). Use search_conversations to look them up if you need them.`
    : undefined;
  return { rules, profile, history, ...(note === undefined ? {} : { historyNote: note }) };
}

function textOf(message: ChatMessage): string {
  return message.authorKind === "system" ? systemNote(message.text) : message.text;
}

/** Chat messages as alternating user/assistant turns. */
function toTurns(messages: readonly ChatMessage[]): Message[] {
  const turns: { role: "user" | "assistant"; text: string }[] = [];
  for (const message of messages) {
    const role = message.authorKind === "bot" ? "assistant" : "user";
    const text = textOf(message);
    const last = turns[turns.length - 1];
    if (last?.role === role) last.text = `${last.text}\n\n${text}`;
    else turns.push({ role, text });
  }
  return turns.map((t) => ({ role: t.role, blocks: [{ type: "text" as const, text: t.text }] }));
}
