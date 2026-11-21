import {
  CONTROL_TOOL_NAMES,
  type EscalateQuestion,
  escalatedQuestions,
  type FailureOrigin,
  runResultSchema,
} from "@suup/core";
import {
  addJournalMemory,
  appendMessageOnce,
  type Db,
  finishReception,
  getRun,
  type MessageQuestion,
  type Run,
  rolloverUnreadMessages,
} from "@suup/db";
import { returnDelegatedResult } from "./supervisor.js";

/** What a failure origin means, in plain Portuguese, for the message the user reads. */
export const ORIGIN_TEXT_PT: Record<FailureOrigin, string> = {
  provider: "o provedor do modelo falhou ou ficou indisponível",
  model: "o modelo se recusou, desistiu ou entrou em laço",
  tool: "uma ferramenta falhou",
  harness: "houve um erro interno do sistema",
  limit: "um limite configurado foi atingido (turnos, custo ou tempo)",
  approval: "uma aprovação foi negada",
  user: "foi encerrada a seu pedido",
};

const clip = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * A linha do diário de uma execução que terminou: quando, e como acabou. Sem modelo.
 *
 * O diário NUNCA copia o texto cru do usuário numa execução de conversa: o bot decide o que
 * guardar (e é instruído a não guardar segredos), e o diário seguia o que o usuário digitou, o que
 * vazava uma senha que o bot tinha se recusado a guardar. Aqui só entra o que o próprio bot
 * escreveu (o resumo do `finish`) e metadados neutros. Numa execução sem conversa (`suup run`) o
 * objetivo é uma tarefa dada por quem opera o sistema e entra, cortado. NÃO há detecção de
 * "texto que parece segredo" (isso seria reconhecer por padrão): o que protege é (1) o diário nunca
 * copiar o texto cru do usuário numa conversa, (2) o redator do cofre, que troca os valores EXATOS
 * dos segredos conhecidos (em `finishRun`, antes do corte) e (3) a regra no prompt do bot de nunca
 * guardar segredos. Um segredo que o bot repete no resumo e que não está no cofre não é pego.
 */
export function journalText(run: Run): string {
  const when = isoDay(run.finishedAt ?? run.updatedAt);
  const isConversation = run.conversationId !== null && run.conversationId !== undefined;
  let outcome: string;
  if (run.status === "done") {
    const summary = runResultSchema.safeParse(run.result);
    outcome = `concluída${summary.success && summary.data.summary.trim() !== "" ? `. Resumo: ${clip(summary.data.summary, 400)}` : "."}`;
  } else if (run.status === "failed") {
    outcome = `falhou (origem: ${run.failureOrigin ?? "desconhecida"}): ${clip(run.failureDetail ?? "sem detalhe", 200)}`;
  } else {
    outcome = "cancelada antes de terminar.";
  }
  const what = isConversation ? "Conversa" : `Objetivo: "${clip(run.objective, 200)}"`;
  return `${when} · ${what} · Resultado: ${outcome}`;
}

/**
 * O fato curto da entrada do diário (até 200 caracteres), que entra na busca junto do texto. Sem
 * modelo: sai só dos campos da própria execução (o que ela era e como acabou), na mesma regra de
 * privacidade do texto do diário (o texto cru do usuário numa conversa nunca entra).
 */
export function journalSummary(run: Run): string {
  const isConversation = run.conversationId !== null && run.conversationId !== undefined;
  const what = isConversation ? "Conversa" : clip(run.objective, 70);
  let outcome: string;
  if (run.status === "done") {
    const result = runResultSchema.safeParse(run.result);
    outcome =
      result.success && result.data.summary.trim() !== ""
        ? `concluída: ${clip(result.data.summary, 110)}`
        : "concluída";
  } else if (run.status === "failed") {
    outcome = `falhou (${run.failureOrigin ?? "origem desconhecida"})`;
  } else {
    outcome = "cancelada";
  }
  return clip(`${what}, ${outcome}`, 200);
}

/** Nomes das ferramentas de controle, para distinguir uma execução que só conversou. */
const CONTROL_NAMES: string[] = [...CONTROL_TOOL_NAMES];

/**
 * Uma execução de conversa que terminou bem sem usar nenhuma ferramenta além das de controle foi
 * só uma resposta ("bom dia"): não vira entrada no diário, que ficaria cheio de ruído.
 */
async function isPlainChat(db: Db, run: Run): Promise<boolean> {
  if (run.status !== "done" || run.conversationId === null || run.conversationId === undefined) {
    return false;
  }
  const [row] = await db.sql<{ n: number }[]>`
    select count(*)::int as n from run_events
    where run_id = ${run.id} and type = 'tool_call'
      and not (payload->>'name' = any(${CONTROL_NAMES}::text[]))`;
  return (row?.n ?? 0) === 0;
}

/** The message the user sees for the end (or the pause) of a conversation run; `null` for none. */
async function outcomeMessage(
  db: Db,
  run: Run,
): Promise<{
  authorKind: "bot" | "system";
  text: string;
  key: string;
  question?: MessageQuestion;
} | null> {
  switch (run.status) {
    case "done": {
      const parsed = runResultSchema.safeParse(run.result);
      const summary = parsed.success ? parsed.data.summary.trim() : "";
      return {
        authorKind: "bot",
        text: summary === "" ? "Concluí o que você pediu." : summary,
        key: `run:${run.id}:done`,
      };
    }
    case "waiting_user": {
      // The latest question the run asked: its position in the log makes the key, so each
      // question is written once however often the pause is observed.
      const [asked] = await db.sql<{ seq: number; payload: { name?: string; reason?: string } }[]>`
        select seq, payload from run_events
        where run_id = ${run.id} and type in ('escalated', 'secret_requested')
        order by seq desc limit 1`;
      const [question] = await db.sql<
        {
          seq: number;
          payload: {
            question?: string;
            questions?: EscalateQuestion[];
            reason?: "review_tie_break";
          };
        }[]
      >`
        select seq, payload from run_events
        where run_id = ${run.id} and type = 'escalated'
        order by seq desc limit 1`;
      if (asked !== undefined && (question === undefined || asked.seq > question.seq)) {
        // The bot asked for a credential: the message says so (the app draws the secure form from
        // the run's `secret_requested` event); the value never goes through the chat.
        const name = asked.payload.name ?? "";
        return {
          authorKind: "bot",
          text: `Preciso do segredo ${name}${asked.payload.reason === undefined ? "" : ` (${asked.payload.reason})`}. Guarde-o no cofre pelo formulário seguro; eu nunca vejo o valor.`,
          key: `run:${run.id}:secret:${asked.seq}`,
        };
      }
      const text = question?.payload.question?.trim();
      if (question === undefined || text === undefined || text === "") return null;
      return {
        authorKind: "bot",
        text,
        key: `run:${run.id}:question:${question.seq}`,
        // The structured side, so the app draws the card from the message alone.
        question: {
          questions: escalatedQuestions({ question: text, questions: question.payload.questions }),
          ...(question.payload.reason === undefined ? {} : { reason: question.payload.reason }),
        },
      };
    }
    case "waiting_timer": {
      // The bot scheduled a return and told the user in its last message of the turn (kept in the
      // status change that parked the run): that is the chat message. Its position in the log makes
      // the key, so each parking writes once however often it is observed.
      const [parked] = await db.sql<{ seq: number; payload: { result?: { summary?: string } } }[]>`
        select seq, payload from run_events
        where run_id = ${run.id} and type = 'status_changed' and payload->>'to' = 'waiting_timer'
        order by seq desc limit 1`;
      if (parked === undefined) return null;
      const text = parked.payload.result?.summary?.trim() ?? "";
      return {
        authorKind: "bot",
        text: text === "" ? "Volto daqui a pouco para conferir." : text,
        key: `run:${run.id}:wait:${parked.seq}`,
      };
    }
    case "failed": {
      const origin = (run.failureOrigin ?? "harness") as FailureOrigin;
      return {
        authorKind: "system",
        text: `Não consegui concluir esta tarefa: ${ORIGIN_TEXT_PT[origin] ?? "houve uma falha"} (origem: ${origin}).${run.failureDetail === null ? "" : ` Detalhe: ${clip(run.failureDetail, 300)}`}`,
        key: `run:${run.id}:failed`,
      };
    }
    case "cancelled":
      return {
        authorKind: "system",
        text: "A execução foi cancelada antes de terminar.",
        key: `run:${run.id}:cancelled`,
      };
    default:
      return null;
  }
}

/**
 * Como o fim de uma execução limpa o texto que vai ao diário. `redact` é o redator do cofre
 * (`runtime.redactJson`): ele conhece os valores exatos dos segredos e roda sobre o texto cru, ANTES
 * do corte, porque um corte no meio de um valor deixaria um pedaço que o redator não reconheceria.
 * Sem ele nada é trocado (não há detecção por padrão).
 */
export interface RunEndOptions {
  redact?: <T>(value: T) => Promise<T>;
}

/** A execução com os campos que alimentam o diário limpos pelo redator do cofre. */
async function scrubbedForJournal(run: Run, options: RunEndOptions): Promise<Run> {
  const { redact } = options;
  if (redact === undefined) return run;
  const { objective, failureDetail, result } = run;
  const safe = await redact({ objective, failureDetail, result });
  return { ...run, ...safe };
}

export interface RunEffects {
  /** A bot or system message was written to the conversation now (not already there). */
  messageWritten: boolean;
  /** A journal entry was written now. */
  journalWritten: boolean;
  /** Messages the run never read became a new run. */
  rolledOver: Run | null;
}

/**
 * What must follow a run that ended or paused, derived only from the stored run and its event log
 * (never from memory of this process), and idempotent: calling it again, from the same worker
 * after a redelivery or from another one after a crash, writes nothing twice.
 *
 * - `done`, `failed`, `cancelled`: one `journal` memory for the bot (key: the run; not for a
 *   conversation run that only answered, with no tool beyond the control ones), and, for a
 *   conversation run, the bot's side in the conversation (key: run + outcome): the final answer,
 *   or a system message in Portuguese saying it failed or was cancelled.
 * - `waiting_user`: the question the run asked, as a bot message (key: run + the position of the
 *   `escalated` event, so each question is written once).
 * - `waiting_timer`: the bot's message of the turn in which it scheduled its return (key: run + the
 *   position of the status change that parked it). There is no other mark of the return in the chat.
 * - messages posted to a run that ended before reading them become the objective of a new run.
 * - any other status: nothing.
 */
export async function finishRun(
  db: Db,
  runId: string,
  options: RunEndOptions = {},
): Promise<RunEffects> {
  const effects: RunEffects = { messageWritten: false, journalWritten: false, rolledOver: null };
  const run = await getRun(db, runId);
  if (run === null) return effects;
  const terminal = run.status === "done" || run.status === "failed" || run.status === "cancelled";

  if (run.conversationId !== null && run.conversationId !== undefined) {
    const message = await outcomeMessage(db, run);
    if (message !== null) {
      const { created } = await appendMessageOnce(db, {
        conversationId: run.conversationId,
        authorKind: message.authorKind,
        ...(message.authorKind === "bot" ? { authorBotId: run.botId } : {}),
        text: message.text,
        runId: run.id,
        dedupeKey: message.key,
        ...(message.question === undefined ? {} : { question: message.question }),
      });
      effects.messageWritten = created;
    }
  }
  if (terminal) {
    // The welcome is over, however it ended: it never starts by itself again (only "Refazer").
    if (run.origin === "reception" && run.conversationId != null) {
      await finishReception(db, run.conversationId);
    }
    // Uma execução isolada (avaliação) nunca escreve na memória do usuário: sem diário.
    if (run.isolated !== true && !(await isPlainChat(db, run))) {
      const journal = await addJournalMemory(db, {
        botId: run.botId,
        text: journalText(await scrubbedForJournal(run, options)),
        summary: journalSummary(await scrubbedForJournal(run, options)),
        sourceRunId: run.id,
        ...(run.conversationId == null ? {} : { sourceConversationId: run.conversationId }),
      });
      effects.journalWritten = journal !== null;
    }
    effects.rolledOver = await rolloverUnreadMessages(db, run.id);
    // A task another bot delegated to this one: its short result goes back to that bot's chat.
    if (run.origin === "delegation") await returnDelegatedResult(db, run);
  }
  return effects;
}

/**
 * Applies `finishRun` to the runs whose effects may be missing: the process that finished them
 * died before the worker hook ran. Looks at conversation runs paused for the user and at runs
 * that ended in the last `sinceDays` days without their journal entry or outcome message.
 * Cheap to call at every start of a worker. Returns the ids it touched.
 */
export async function reconcileRunEffects(
  db: Db,
  options: RunEndOptions & { sinceDays?: number; limit?: number } = {},
): Promise<string[]> {
  const days = options.sinceDays ?? 7;
  const limit = options.limit ?? 200;
  const rows = await db.sql<{ id: string }[]>`
    select r.id from runs r
    where not r.isolated and ((
      r.status in ('waiting_user', 'waiting_timer') and r.conversation_id is not null
    ) or (
      r.status in ('done', 'failed', 'cancelled')
      and r.updated_at > now() - make_interval(days => ${days}::integer)
      and (
        (
          not exists (
            select 1 from memories m where m.source_run_id = r.id and m.layer = 'journal'
          )
          -- uma conversa que só respondeu (sem ferramenta além das de controle) não tem diário
          and not (
            r.status = 'done' and r.conversation_id is not null
            and not exists (
              select 1 from run_events e
              where e.run_id = r.id and e.type = 'tool_call'
                and not (e.payload->>'name' = any(${CONTROL_NAMES}::text[]))
            )
          )
        )
        or (
          r.conversation_id is not null
          and not exists (
            select 1 from messages g
            where g.conversation_id = r.conversation_id
              and g.dedupe_key = 'run:' || r.id::text || ':' || r.status
          )
        )
        or exists (
          select 1 from delegations d where d.to_run_id = r.id and d.returned_at is null
        )
        or exists (
          select 1 from run_inbox i
          where i.run_id = r.id and i.kind = 'user_message' and i.consumed_at is null
        )
      )
    ))
    order by r.updated_at
    limit ${limit}`;
  for (const row of rows) await finishRun(db, row.id, options);
  return rows.map((r) => r.id);
}
