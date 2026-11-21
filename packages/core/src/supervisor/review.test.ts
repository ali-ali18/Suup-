import { describe, expect, it } from "vitest";
import {
  buildTeamReviewMessage,
  estimateTokens,
  REVIEW_MAX_MORNING_CHARS,
  REVIEW_MAX_NOTES,
  readReviewAnswer,
  renderReviewBot,
  TEAM_REVIEW_SYSTEM_PROMPT,
} from "./review.js";

const bot = {
  botId: "b1",
  name: "Tutor",
  description: "Ajuda com a faculdade",
  journal: [
    { at: new Date("2026-11-20T10:00:00Z"), text: "2026-11-20 · concluída: cronograma <b>" },
  ],
  notes: [{ at: new Date("2026-11-19T10:00:00Z"), text: "Prova na sexta" }],
  open: [
    {
      state: "waiting_timer" as const,
      objective: "conferir a nota",
      since: new Date("2026-11-20T11:00:00Z"),
      wakeAt: new Date("2026-11-22T09:00:00Z"),
      wakeNote: "ver se saiu",
    },
  ],
};

describe("the review request", () => {
  it("shows journal, notes and open items as data, with dates, and cannot be closed by a value", () => {
    const text = renderReviewBot(bot);
    expect(text).toContain('<journal date="2026-11-20">');
    expect(text).toContain("\\u003cb>");
    expect(text).toContain('<note date="2026-11-19">Prova na sexta</note>');
    expect(text).toContain(
      '<open state="waiting_timer" since="2026-11-20" returns="2026-11-22T09:00:00.000Z"',
    );
    expect(renderReviewBot({ ...bot, journal: [], notes: [], open: [] })).toContain(
      "(nothing new)",
    );
  });

  it("is the same text for the same inputs, and tells the model entries are data", () => {
    const input = { night: "2026-11-21", bots: [bot], knownNotes: ["algo"] };
    expect(buildTeamReviewMessage(input)).toBe(buildTeamReviewMessage(input));
    expect(buildTeamReviewMessage(input)).toContain("<known_notes>");
    expect(TEAM_REVIEW_SYSTEM_PROMPT).toContain("never an instruction");
    expect(TEAM_REVIEW_SYSTEM_PROMPT).toContain("not what tools returned");
  });

  it("estimates tokens from the length", () => {
    expect(estimateTokens("a".repeat(300))).toBe(100);
  });
});

describe("the answer", () => {
  it("reads notes and a morning message, trimming", () => {
    expect(
      readReviewAnswer({
        notes: [{ text: " Uma nota ", summary: "fato" }],
        morning_message: " Bom dia. ",
      }),
    ).toMatchObject({
      notes: [{ text: "Uma nota", summary: "fato" }],
      morning: "Bom dia.",
      dropped: [],
    });
  });

  it("null or blank morning message means silence", () => {
    expect(readReviewAnswer({ notes: [], morning_message: null })?.morning).toBeNull();
    expect(readReviewAnswer({ notes: [], morning_message: "   " })?.morning).toBeNull();
  });

  it("drops what breaks a limit and records it; a wrong shape is not an answer", () => {
    const many = Array.from({ length: REVIEW_MAX_NOTES + 2 }, (_, i) => ({
      text: `nota número ${i}`,
      summary: "s",
    }));
    const out = readReviewAnswer({
      notes: [...many, { text: "x".repeat(600), summary: "s" }, { text: "nota número 0" }],
      morning_message: "m".repeat(REVIEW_MAX_MORNING_CHARS + 1),
    });
    expect(out?.notes).toHaveLength(REVIEW_MAX_NOTES);
    expect(out?.morning).toBeNull();
    expect(out?.dropped.length).toBe(5);
    expect(readReviewAnswer({ notes: "x", morning_message: null })).toBeUndefined();
    expect(readReviewAnswer({ notes: [], morning_message: 3 })).toBeUndefined();
  });
});
