import {
  addMemory,
  appendMessage,
  createBot,
  createGroupConversation,
  type Db,
  searchMemories,
  searchMemoriesBroadening,
  searchMessages,
  searchMessagesBroadening,
} from "@suup/db";
import { CONVERSATIONS, CORPUS, JOURNAL, NOTES, QUESTIONS, type RecallQuestion } from "./corpus.js";

/**
 * The recall benchmark (docs/MEMORIA.md, "Medindo a busca"): do the full-text searches the bot has
 * (`recall` over notes and the journal, `search_conversations` over the chats) put the item that
 * holds the answer in the first 5 results? Measured twice over the same made-up memory: with the
 * short fact (`summary`) indexed together with the text, and without it.
 *
 * No model is called: the questions come with the key words a bot would send, and the search is
 * the database's. It measures the search, not the model. The summaries and the questions were
 * written by hand (see `corpus.ts`), so a gain from the summary here shows that the plumbing works
 * and what it can do when the short fact repeats the words a question uses, not what a model's
 * summaries will achieve; that is why the real model's summaries are read in the consolidation run.
 */

export const TOP_K = 5;

type Mode = "all" | "any" | "fallback";

export type Variant = "with_summary" | "without_summary";

export interface QuestionResult {
  id: string;
  kind: RecallQuestion["kind"];
  category: RecallQuestion["category"];
  /** The 1-based position of the expected item among the results, or `null` when it is not there. */
  rank: number | null;
}

export interface VariantReport {
  variant: Variant;
  results: QuestionResult[];
  hitAt1: number;
  hitAt5: number;
  /** Mean reciprocal rank over the first 5 results (0 for a miss). */
  mrr: number;
  byKind: Record<string, { n: number; hitAt5: number }>;
  byCategory: Record<string, { n: number; hitAt5: number }>;
}

export interface RecallReport {
  corpus: { notes: number; journal: number; conversations: number; messages: number };
  questions: number;
  topK: number;
  /** All the key words must be in the item (what `recall` does today). */
  with: VariantReport;
  without: VariantReport;
  /**
   * Any of the key words (`a or b or c`, best match first): not what `recall` does today, measured
   * to decide whether the search should fall back to it when all the words find nothing.
   */
  anyWord: { with: VariantReport; without: VariantReport };
  /**
   * What `recall` and `search_conversations` do now: all the words, and only when that finds nothing,
   * any of them (`searchMemoriesBroadening` / `searchMessagesBroadening`).
   */
  fallback: { with: VariantReport; without: VariantReport };
  /** Questions the full question text (not the key words) would have found, as a note on the method. */
  sentenceAsQuery: { hitAt5: number; n: number };
}

const share = (hits: number, n: number): number => (n === 0 ? 0 : hits / n);

function summarize(variant: Variant, results: QuestionResult[]): VariantReport {
  const group = (pick: (r: QuestionResult) => string) => {
    const out: Record<string, { n: number; hitAt5: number }> = {};
    for (const r of results) {
      const key = pick(r);
      const entry = out[key] ?? { n: 0, hitAt5: 0 };
      out[key] = entry;
      entry.n += 1;
      if (r.rank !== null && r.rank <= TOP_K) entry.hitAt5 += 1;
    }
    for (const entry of Object.values(out)) entry.hitAt5 = share(entry.hitAt5, entry.n);
    return out;
  };
  const n = results.length;
  return {
    variant,
    results,
    hitAt1: share(results.filter((r) => r.rank === 1).length, n),
    hitAt5: share(results.filter((r) => r.rank !== null && r.rank <= TOP_K).length, n),
    mrr: share(
      results.reduce((sum, r) => sum + (r.rank !== null && r.rank <= TOP_K ? 1 / r.rank : 0), 0),
      n,
    ),
    byKind: group((r) => r.kind),
    byCategory: group((r) => r.category),
  };
}

/**
 * Loads the made-up memory into `db` (a migrated, empty schema) and measures both variants. One
 * bot per variant holds the notes and the journal; one bot holds all the conversations (a group room
 * per conversation), as `search_conversations` sees them.
 */
export async function runRecallBenchmark(db: Db): Promise<RecallReport> {
  const bot = (name: string) => createBot(db, { name, modelProvider: "fake", modelId: "fake-1" });
  const withBot = await bot("bench-with-summary");
  const withoutBot = await bot("bench-without-summary");
  const chatBot = await bot("bench-chats");

  const keyOfMemory = new Map<string, string>();
  for (const [variant, owner] of [
    ["with_summary", withBot],
    ["without_summary", withoutBot],
  ] as const) {
    for (const item of [...NOTES, ...JOURNAL]) {
      const memory = await addMemory(db, {
        layer: item.kind,
        botId: owner.id,
        text: item.text,
        ...(variant === "with_summary" ? { summary: item.summary } : {}),
        createdBy: "bot",
      });
      keyOfMemory.set(memory.id, item.key);
    }
  }

  const keyOfConversation = new Map<string, string>();
  let messages = 0;
  for (const conversation of CONVERSATIONS) {
    const room = await createGroupConversation(db, {
      title: `bench ${conversation.key}`,
      botIds: [chatBot.id],
    });
    keyOfConversation.set(room.id, conversation.key);
    for (const m of conversation.messages) {
      await appendMessage(db, {
        conversationId: room.id,
        authorKind: m.author,
        ...(m.author === "bot" ? { authorBotId: chatBot.id } : {}),
        text: m.text,
      });
      messages += 1;
    }
  }

  const rankOf = async (
    question: RecallQuestion,
    query: string,
    owner: { id: string },
    mode: Mode,
  ): Promise<number | null> => {
    if (question.kind === "conversation") {
      const opts = { query, botId: chatBot.id, limit: 30 };
      const hits =
        mode === "fallback"
          ? (await searchMessagesBroadening(db, opts)).hits
          : await searchMessages(db, { ...opts, match: mode });
      const order: string[] = [];
      for (const hit of hits) {
        const key = keyOfConversation.get(hit.message.conversationId);
        if (key !== undefined && !order.includes(key)) order.push(key);
      }
      const at = order.indexOf(question.expected);
      return at === -1 ? null : at + 1;
    }
    const opts = {
      query,
      botId: owner.id,
      layers: ["note", "journal"] as ("note" | "journal")[],
      limit: TOP_K,
    };
    const hits =
      mode === "fallback"
        ? (await searchMemoriesBroadening(db, opts)).hits
        : await searchMemories(db, { ...opts, match: mode });
    const at = hits.findIndex((h) => keyOfMemory.get(h.memory.id) === question.expected);
    return at === -1 ? null : at + 1;
  };

  const measure = async (
    variant: Variant,
    owner: { id: string },
    text: "keywords" | "question",
    mode: Mode = "all",
  ) =>
    summarize(
      variant,
      await Promise.all(
        QUESTIONS.map(async (q) => ({
          id: q.id,
          kind: q.kind,
          category: q.category,
          rank: await rankOf(q, q[text], owner, mode),
        })),
      ),
    );

  const sentence = await measure("with_summary", withBot, "question");
  return {
    corpus: {
      notes: NOTES.length,
      journal: JOURNAL.length,
      conversations: CONVERSATIONS.length,
      messages,
    },
    questions: QUESTIONS.length,
    topK: TOP_K,
    with: await measure("with_summary", withBot, "keywords"),
    without: await measure("without_summary", withoutBot, "keywords"),
    anyWord: {
      with: await measure("with_summary", withBot, "keywords", "any"),
      without: await measure("without_summary", withoutBot, "keywords", "any"),
    },
    fallback: {
      with: await measure("with_summary", withBot, "keywords", "fallback"),
      without: await measure("without_summary", withoutBot, "keywords", "fallback"),
    },
    sentenceAsQuery: {
      n: QUESTIONS.length,
      hitAt5: Math.round(sentence.hitAt5 * QUESTIONS.length),
    },
  };
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** The report as text (the CLI prints it; TESTES-REAIS.md quotes it). */
export function formatRecallReport(report: RecallReport): string {
  const lines = [
    `Corpus inventado: ${report.corpus.notes} notas, ${report.corpus.journal} entradas de diário, ${report.corpus.conversations} conversas (${report.corpus.messages} mensagens); ${report.questions} perguntas, top ${report.topK}.`,
    "",
    "                         sem o fato curto   com o fato curto",
    `acerto no 1º lugar        ${pct(report.without.hitAt1).padStart(6)}             ${pct(report.with.hitAt1).padStart(6)}`,
    `acerto nos 5 primeiros    ${pct(report.without.hitAt5).padStart(6)}             ${pct(report.with.hitAt5).padStart(6)}`,
    `MRR (top 5)               ${report.without.mrr.toFixed(2).padStart(6)}             ${report.with.mrr.toFixed(2).padStart(6)}`,
    "",
  ];
  for (const kind of ["note", "journal", "conversation"]) {
    const a = report.without.byKind[kind];
    const b = report.with.byKind[kind];
    if (a === undefined || b === undefined) continue;
    lines.push(
      `${kind.padEnd(13)} (${String(a.n).padStart(2)} perguntas)  ${pct(a.hitAt5).padStart(6)}             ${pct(b.hitAt5).padStart(6)}`,
    );
  }
  const missed = report.with.results
    .filter((r) => r.rank === null || r.rank > report.topK)
    .map((r) => r.id);
  const missedWithout = report.without.results
    .filter((r) => r.rank === null || r.rank > report.topK)
    .map((r) => r.id);
  lines.push("");
  lines.push("Com QUALQUER das palavras-chave (a or b or c), sempre:");
  lines.push(
    `acerto nos 5 primeiros    ${pct(report.anyWord.without.hitAt5).padStart(6)}             ${pct(report.anyWord.with.hitAt5).padStart(6)}   (MRR ${report.anyWord.without.mrr.toFixed(2)} / ${report.anyWord.with.mrr.toFixed(2)})`,
  );
  for (const kind of ["note", "journal", "conversation"]) {
    const a = report.anyWord.without.byKind[kind];
    const b = report.anyWord.with.byKind[kind];
    if (a === undefined || b === undefined) continue;
    lines.push(
      `${kind.padEnd(13)} (${String(a.n).padStart(2)} perguntas)  ${pct(a.hitAt5).padStart(6)}             ${pct(b.hitAt5).padStart(6)}`,
    );
  }
  lines.push("");
  lines.push(
    "O que o `recall` e o `search_conversations` fazem agora (todas as palavras; se nada, qualquer uma):",
  );
  lines.push(
    `acerto nos 5 primeiros    ${pct(report.fallback.without.hitAt5).padStart(6)}             ${pct(report.fallback.with.hitAt5).padStart(6)}   (MRR ${report.fallback.without.mrr.toFixed(2)} / ${report.fallback.with.mrr.toFixed(2)})`,
  );
  lines.push("");
  lines.push(`Perdidas sem o fato curto: ${missedWithout.join(", ") || "nenhuma"}`);
  lines.push(`Perdidas com o fato curto: ${missed.join(", ") || "nenhuma"}`);
  lines.push(
    `Com a pergunta inteira como consulta (em vez das palavras-chave): ${report.sentenceAsQuery.hitAt5} de ${report.sentenceAsQuery.n} nos 5 primeiros.`,
  );
  return lines.join("\n");
}

export { CORPUS };
