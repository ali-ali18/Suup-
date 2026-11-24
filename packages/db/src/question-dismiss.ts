// Owns the X of a question card (docs/API.md, "Fechar a pergunta"): the user will not pick an
// option. The card stays in the chat, locked ("Não respondido"); the run is told, so it goes on
// (it never waits forever for a choice that will not come); the user may still answer by typing.
import { type Db, withTransaction } from "./client.js";
import { postInbox } from "./inbox.js";
import { getMessage, type Message, type MessageQuestion } from "./messages.js";

/** Why a question cannot be closed: it does not exist, or it no longer waits for the user. */
export class QuestionDismissError extends Error {
  constructor(
    readonly code: "not_found" | "not_waiting",
    message: string,
  ) {
    super(message);
    this.name = "QuestionDismissError";
  }
}

/**
 * What the run receives as the answer to its question when the user closes the card: written by the
 * harness, for the model (never shown in the chat as the user's words).
 */
export const DISMISSED_QUESTION_ANSWER =
  "(The user closed this question without choosing an option. They may still answer in the chat. Do not ask the same question again now: go on with what you can do without it, or end your turn and wait for their message.)";

/**
 * Closes the open question of a bot message: marks it `dismissed` (structured, on the message) and
 * posts the harness's answer to the run that waits for it, which is requeued. Idempotent: closing a
 * closed question returns it unchanged. `QuestionDismissError`: no such question (`not_found`), or
 * it is not the one its run waits for (`not_waiting`: answered, the run moved on or ended).
 */
export async function dismissQuestion(
  db: Db,
  messageId: string,
): Promise<{ message: Message; dismissed: boolean }> {
  const result = await withTransaction(db, async (tx) => {
    // Lock order of the whole codebase: the conversation, then its run (docs: lock-order test). A
    // message sent at the same moment holds the conversation too, so the "newer message" check below
    // sees it, and the two never deadlock.
    const [owner] = await tx.sql<{ conversation_id: string }[]>`
      select conversation_id from messages where id = ${messageId}`;
    if (owner === undefined)
      throw new QuestionDismissError("not_found", "Pergunta não encontrada.");
    await tx.sql`
      select 1 from conversations where id = ${owner.conversation_id} for no key update`;
    const [row] = await tx.sql<
      {
        run_id: string | null;
        question: MessageQuestion | null;
        conversation_id: string;
        seq: string;
      }[]
    >`
      select run_id, question, conversation_id, seq from messages
      where id = ${messageId} and author_kind = 'bot' for update`;
    if (row === undefined || row.question === null) {
      throw new QuestionDismissError("not_found", "Pergunta não encontrada.");
    }
    if (row.question.dismissed === true) return false;
    const runId = row.run_id;
    // The run waits for THIS question: it is waiting for the user, and no newer message of the
    // conversation (an answer, a later question) came after it.
    const [run] =
      runId === null
        ? []
        : await tx.sql<{ status: string }[]>`select status from runs where id = ${runId}`;
    const [newer] = await tx.sql<{ one: number }[]>`
      select 1 as one from messages
      where conversation_id = ${row.conversation_id} and seq > ${row.seq} limit 1`;
    if (runId === null || run?.status !== "waiting_user" || newer !== undefined) {
      throw new QuestionDismissError("not_waiting", "Esta pergunta não espera mais uma resposta.");
    }
    await tx.sql`
      update messages set question = question || '{"dismissed": true}'::jsonb
      where id = ${messageId}`;
    await postInbox(tx, runId, { kind: "user_message", text: DISMISSED_QUESTION_ANSWER });
    return true;
  });
  const message = await getMessage(db, messageId);
  if (message === null) throw new QuestionDismissError("not_found", "Pergunta não encontrada.");
  return { message, dismissed: result };
}
