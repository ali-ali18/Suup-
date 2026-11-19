import { describe, expect, it } from "vitest";
import { CONVERSATIONS, CORPUS, JOURNAL, NOTES, QUESTIONS } from "../src/memory/corpus.js";
import { formatRecallReport, runRecallBenchmark } from "../src/memory/recall.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";

describe("the recall benchmark: the made-up memory", () => {
  it("has at least 20 questions, each pointing to an item that exists, with no repeated key", () => {
    expect(QUESTIONS.length).toBeGreaterThanOrEqual(20);
    const keys = CORPUS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const q of QUESTIONS) expect(keys, q.id).toContain(q.expected);
    expect(new Set(QUESTIONS.map((q) => q.id)).size).toBe(QUESTIONS.length);
    expect(new Set(QUESTIONS.map((q) => q.kind))).toEqual(
      new Set(["note", "journal", "conversation"]),
    );
  });

  it("keeps every short fact within the limit and every key word list short", () => {
    for (const item of [...NOTES, ...JOURNAL])
      expect(item.summary.length, item.key).toBeLessThanOrEqual(200);
    for (const q of QUESTIONS) expect(q.keywords.split(" ").length, q.id).toBeLessThanOrEqual(5);
    for (const c of CONVERSATIONS)
      expect(
        c.messages.some((m) => m.author === "user"),
        c.key,
      ).toBe(true);
  });

  it("is made up: no e-mail address, no secret-looking token, no real-looking phone or card number", () => {
    const all = JSON.stringify(CORPUS);
    expect(all).not.toContain("@");
    expect(all).not.toContain("sk-");
    expect(all).not.toContain("http");
  });
});

describe.skipIf(!DATABASE_URL)(dbSuiteName("the recall benchmark: the measurement"), () => {
  const ctx = useIsolatedDb();

  it("measures the search with and without the short fact, deterministically", async () => {
    const first = await runRecallBenchmark(ctx.db);
    const text = formatRecallReport(first);
    expect(text).toContain("sem o fato curto");
    expect(first.questions).toBe(QUESTIONS.length);
    // The same corpus gives the same numbers in a second run (the search is deterministic).
    const ctx2 = await runRecallBenchmark(ctx.db);
    expect(ctx2.with.hitAt5).toBe(first.with.hitAt5);
    expect(ctx2.without.hitAt5).toBe(first.without.hitAt5);
    // The short fact is indexed together with the text: it can only add matches, never remove one.
    expect(first.with.hitAt5).toBeGreaterThanOrEqual(first.without.hitAt5);
    // Conversations have no short fact: both variants see them the same way.
    expect(first.with.byKind.conversation).toEqual(first.without.byKind.conversation);
    // Regression guards, set at the numbers measured the first time this ran (see docs/TESTES-REAIS.md):
    expect(first.without.hitAt5).toBeGreaterThanOrEqual(MEASURED.allWords.without - 1e-9);
    expect(first.with.hitAt5).toBeGreaterThanOrEqual(MEASURED.allWords.with - 1e-9);
    expect(first.anyWord.without.hitAt5).toBeGreaterThanOrEqual(MEASURED.anyWord.without - 1e-9);
    expect(first.anyWord.with.hitAt5).toBeGreaterThanOrEqual(MEASURED.anyWord.with - 1e-9);
    // What the bot does now (all the words, and any of them only when those find nothing):
    expect(first.fallback.without.hitAt5).toBeGreaterThanOrEqual(MEASURED.fallback.without - 1e-9);
    expect(first.fallback.with.hitAt5).toBeGreaterThanOrEqual(MEASURED.fallback.with - 1e-9);
    // ...and it never loses what the all-words search already found.
    expect(first.fallback.with.hitAt5).toBeGreaterThanOrEqual(first.with.hitAt5);
    expect(first.fallback.without.hitAt5).toBeGreaterThanOrEqual(first.without.hitAt5);
    // Same words, any of them: the unmatched words stop mattering, and every question is found at
    // the top. The question as a whole sentence is worse than both (the harness needs key words).
    expect(first.sentenceAsQuery.hitAt5).toBeLessThan(first.questions);
  });
});

/**
 * The numbers of the measurement (20 questions: 9 of 20 with all the words, 20 of 20 with any and 20 of 20 with the fallback the bot uses now,
 * of them, with and without the short fact). A guard against the search getting worse, never raised
 * to make a number look good: docs/TESTES-REAIS.md has the reading.
 */
const MEASURED = {
  allWords: { without: 9 / 20, with: 9 / 20 },
  anyWord: { without: 1, with: 1 },
  fallback: { without: 1, with: 1 },
};
