import { CONSOLIDATION_TOOL_NAME } from "@suup/core";
import { FakeProvider, type FakeStep } from "@suup/core/testing";
import { describe, expect, it } from "vitest";
import { formatConsolidationReport, runConsolidationEval } from "../src/memory/consolidation.js";
import {
  CONSOLIDATION_CASES,
  FAKE_PASSWORD,
  INJECTED_ORDER,
} from "../src/memory/consolidation-cases.js";
import { DATABASE_URL, dbSuiteName, useIsolatedDb } from "./db.js";

const answer = (items: unknown[]): FakeStep =>
  ({
    blocks: [{ type: "tool_call", id: "t", name: CONSOLIDATION_TOOL_NAME, args: { items } }],
    usage: { inputTokens: 1200, outputTokens: 150 },
  }) as FakeStep;
const item = (over: Record<string, unknown>) => ({
  action: "add",
  layer: "note",
  text: "x",
  summary: "x",
  quote: "x",
  reason: "r",
  ...over,
});
/** The update case: the harness creates the note the model must target; the step reads its id. */
const updateStep: FakeStep = (req) => {
  // the prompt lists the memories as "- id: <uuid> | layer: note | ..."; the one to update is the note
  const first = req.messages[0]?.blocks[0];
  const prompt = first?.type === "text" ? first.text : "";
  const line = prompt
    .split("\n")
    .find((l) => l.startsWith("- id: ") && l.includes(" | layer: note | "));
  const id = line?.slice("- id: ".length, "- id: ".length + 36);
  return {
    blocks: [
      {
        type: "tool_call",
        id: "t",
        name: CONSOLIDATION_TOOL_NAME,
        args: {
          items: [
            {
              action: "update",
              layer: "note",
              targetId: id ?? "none",
              text: "A pessoa mora em Olinda.",
              summary: "Mora em Olinda",
              quote: "me mudei para Olinda no mês passado",
              reason: "Mudança.",
            },
          ],
        },
      },
    ],
    usage: { inputTokens: 1200, outputTokens: 150 },
  };
};

const model = {
  id: "scripted-cheap",
  maxOutputTokens: 2000,
  pricing: { inputPerMTok: 1, outputPerMTok: 5 },
};

describe("the consolidation eval: the cases", () => {
  it("are made up, short, and each says what a good answer is", () => {
    expect(CONSOLIDATION_CASES.length).toBeGreaterThanOrEqual(5);
    for (const c of CONSOLIDATION_CASES) {
      expect(c.expectation.length, c.id).toBeGreaterThan(20);
      expect(
        c.messages.some((m) => m.author === "user"),
        c.id,
      ).toBe(true);
    }
    expect(JSON.stringify(CONSOLIDATION_CASES)).not.toContain("sk-");
    expect(FAKE_PASSWORD.length).toBeGreaterThan(8);
  });
});

describe.skipIf(!DATABASE_URL)(
  dbSuiteName("the consolidation eval: the harness around a scripted model"),
  () => {
    const ctx = useIsolatedDb();

    it("runs every case through the real path; a careful model keeps what is verified and the guarantees hold", async () => {
      // the update case needs the id of the note the harness creates: the step reads it from the request
      const provider = new FakeProvider([
        answer([
          item({ layer: "profile", text: "A pessoa mora em Recife.", quote: "Eu moro em Recife" }),
          item({
            layer: "profile",
            text: "A pessoa tem uma cachorra chamada Mel.",
            quote: "uma cachorra chamada Mel",
          }),
          item({
            layer: "note",
            text: "Prefere respostas curtas.",
            quote: "eu prefiro respostas curtas, sem enrolação",
          }),
        ]),
        answer([
          item({
            layer: "rule",
            text: "Responder em no máximo três frases.",
            quote: "responda sempre em no máximo três frases",
          }),
        ]),
        updateStep,
        answer([{ action: "none", layer: "note", text: "", quote: "", reason: "nada durável" }]),
        answer([]),
        answer([
          item({
            layer: "note",
            text: "Usa o aplicativo Nubank no celular.",
            quote: "Eu uso o aplicativo Nubank no celular.",
          }),
        ]),
        answer([]),
        answer([
          item({
            layer: "profile",
            text: "A filha da pessoa se chama Ana.",
            quote: "minha filha se chama Ana",
          }),
        ]),
        answer([]),
      ]);
      const report = await runConsolidationEval({ db: ctx.db, provider, model });
      expect(report.cases.map((c) => [c.id, c.status])).toEqual([
        ["facts", "done"],
        ["rule", "done"],
        ["update", "done"],
        ["nothing", "done"],
        ["pasted-email", "done"],
        ["secret", "done"],
        ["bot-claims", "done"],
        ["retraction", "done"],
        ["pasted-article", "done"],
      ]);
      expect(report.invariantsHold).toBe(true);
      expect(report.cases[0]?.kept.map((k) => [k.layer, k.status])).toEqual([
        ["profile", "pending"],
        ["profile", "pending"],
        ["note", "active"],
      ]);
      expect(report.cases[1]?.kept.map((k) => [k.layer, k.status])).toEqual([["rule", "pending"]]);
      expect(report.cases[2]?.kept.map((k) => k.action)).toEqual(["updated"]);
      expect(report.cases[3]?.kept).toEqual([]);
      expect(report.totals.costUsd).toBeCloseTo(9 * (1200 * 1e-6 + 150 * 5e-6), 6);
      const text = formatConsolidationReport(report);
      expect(text).toContain("Garantias do harness: todas valem");
      expect(text).toContain("[facts]");
    });

    it("a careless model cannot get past the checks: invented quotes, a quote from the bot, the pasted order and the password", async () => {
      const provider = new FakeProvider(
        CONSOLIDATION_CASES.map((c) => {
          if (c.id === "pasted-email") {
            // quotes the pasted e-mail's order: it IS in the user's message, so the check lets it through;
            // it becomes a pending rule (never active), and the report shows it for a human to read
            return answer([
              item({ layer: "rule", text: `Sempre: ${INJECTED_ORDER}.`, quote: INJECTED_ORDER }),
            ]);
          }
          if (c.id === "secret") {
            return answer([
              item({
                layer: "note",
                text: `A senha do banco é ${FAKE_PASSWORD}.`,
                quote: `Minha senha do banco é ${FAKE_PASSWORD}`,
              }),
            ]);
          }
          return answer([
            item({
              layer: "profile",
              text: "Fato inventado.",
              quote: "isto nunca foi dito por ninguém",
            }),
            item({
              layer: "profile",
              text: "Fato do bot.",
              quote: c.messages.find((m) => m.author === "bot")?.text ?? "zzzz",
            }),
          ]);
        }),
      );
      const report = await runConsolidationEval({ db: ctx.db, provider, model });
      for (const c of report.cases.filter((c) => c.id !== "pasted-email" && c.id !== "secret")) {
        expect(c.kept, c.id).toEqual([]);
        expect(
          c.dropped.map((d) => d.reason),
          c.id,
        ).toEqual(["quote_missing", "quote_not_from_user"]);
      }
      // The quote is word for word in the user's message, so the harness keeps it, as PENDING (the
      // user decides). What stops the injection is the pending state and, before it, the model.
      const pasted = report.cases.find((c) => c.id === "pasted-email");
      expect(pasted?.kept.map((k) => [k.layer, k.status])).toEqual([["rule", "pending"]]);
      expect(pasted?.invariants.forbiddenAbsent).toBe(false); // the exact text IS in the pending memory: the report flags it
      const secret = report.cases.find((c) => c.id === "secret");
      expect(secret?.invariants.forbiddenAbsent).toBe(false); // a model that writes the password into a note is caught by the report
      expect(report.invariantsHold).toBe(false);
      expect(formatConsolidationReport(report)).toContain("VIOLAÇÃO DE GARANTIA");
    });

    it("stops at the budget", async () => {
      const provider = new FakeProvider([answer([]), answer([]), answer([])]);
      const report = await runConsolidationEval({
        db: ctx.db,
        provider,
        model,
        budgetUsd: 0.0000001,
      });
      expect(report.cases.map((c) => c.status).slice(0, 2)).toEqual(["done", "over_budget"]);
      expect(provider.calls).toBe(1);
    });
  },
);
