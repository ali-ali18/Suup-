import { describe, expect, it } from "vitest";
import { call, createRig, eventsOfType, use } from "../testing/index.js";
import { ESCALATE_DESCRIPTION } from "./control-tools.js";
import { buildSystemPrompt, buildSystemPromptParts } from "./prompts.js";

// The bot knows what its tools draw in the chat (owner, 24/11/2026: hiding output the model paid for
// is waste; the fix is at the source). These lines must not be dropped by a later edit.

describe("the bot is told what the question card shows", () => {
  it("escalate's description: the question is the card's title, never repeated; text only to add something", () => {
    expect(ESCALATE_DESCRIPTION).toContain("the question is the TITLE of a card in the chat");
    expect(ESCALATE_DESCRIPTION).toContain("never repeat it in your message text");
    expect(ESCALATE_DESCRIPTION).toContain("write no text at all and only call this tool");
  });

  it("the shared, stable part of the system prompt says it too (the same for every bot)", () => {
    const a = buildSystemPrompt({ name: "A", personality: "" });
    const b = buildSystemPrompt({ name: "B", personality: "Outra." });
    const line =
      "The question is shown as the title of a card with the options under it: do not repeat it in your text.";
    expect(a).toContain(line);
    // Inside the prefix every bot shares (the cache breakpoint): before the per-bot part.
    expect(a.indexOf(line)).toBeLessThan(a.indexOf("## Who you are"));
    expect(a.slice(0, a.indexOf("## Who you are"))).toBe(b.slice(0, b.indexOf("## Who you are")));
  });

  it("what the bot wrote in the turn of the question is kept apart (`lead`); nothing when it only asked", async () => {
    const question = "Qual cor você prefere?";
    const withText = createRig({
      script: [
        use(
          { type: "text", text: "  A busca está fora do ar.  " },
          call("c1", "escalate", { question }),
        ),
      ],
    });
    expect(await withText.run()).toBe("waiting_user");
    expect(eventsOfType(await withText.events(), "escalated")[0]?.payload).toEqual({
      question,
      callId: "c1",
      lead: "A busca está fora do ar.",
    });
    const bare = createRig({ script: [use(call("c1", "escalate", { question }))] });
    await bare.run();
    expect(eventsOfType(await bare.events(), "escalated")[0]?.payload).not.toHaveProperty("lead");
  });
});

describe("the bot is told what the file card shows", () => {
  it("the prompt line for send_file: a card under the message, never the name or path again", () => {
    const prompt = buildSystemPrompt({ name: "A", personality: "" }, undefined, { sendFile: true });
    expect(prompt).toContain("it appears as a card under your message");
    expect(prompt).toContain("Never repeat its name or path in your text");
  });
});

describe("documents: free code by default, create_document as a shortcut", () => {
  const machine = { terminal: true, files: true, isolated: true } as never;
  const context = (m: unknown = machine) => ({ rules: [], profile: [], machine: m }) as never;

  it("the prompt line for create_document: a shortcut for a simple document, a card, one short line", () => {
    const prompt = buildSystemPrompt({ name: "A", personality: "" }, undefined, {
      sendFile: true,
      createDocument: true,
    });
    expect(prompt).toContain("`create_document`: a shortcut for a simple, standard PDF");
    expect(prompt).toContain("never repeat its name in your text");
    expect(prompt).not.toContain("not the terminal or Python");
  });

  it("with a terminal, the short document skill lists the guardrails and the optional helper", () => {
    const prompt = buildSystemPrompt({ name: "A", personality: "" }, context(), {
      sendFile: true,
      createDocument: true,
    });
    for (const text of [
      "write your own code on your machine",
      "A4 pages and UTF-8",
      "registered and embedded (never Helvetica, Times or Courier)",
      "xlsx formulas without errors",
      "margins 3/2/2/3 cm",
      "Figura 1 \u2013 title",
      "`import suup_docs`",
      "`create_document` is faster",
      "`force: true` with a `reason`",
    ]) {
      expect(prompt, text).toContain(text);
    }
  });

  it("the skill is short and does not mention create_document when the bot lacks it", () => {
    const prompt = buildSystemPrompt({ name: "A", personality: "" }, context(), { sendFile: true });
    expect(prompt).toContain("write your own code on your machine");
    expect(prompt).not.toContain("create_document");
    const skill = prompt.slice(prompt.indexOf("- PDF, Word and Excel files"));
    expect(skill.split(" ").length).toBeLessThan(170);
  });

  it("no terminal, no skill (there is nothing to write code on)", () => {
    const prompt = buildSystemPrompt(
      { name: "A", personality: "" },
      context({ terminal: false, files: true, isolated: true }),
      {
        sendFile: true,
      },
    );
    expect(prompt).not.toContain("write your own code");
  });

  it("the shared prefix (the cache) is the same with and without the tool or the skill", () => {
    const bot = { name: "A", personality: "x" };
    const without = buildSystemPromptParts(bot, undefined, { sendFile: true });
    const withTool = buildSystemPromptParts(bot, context(), {
      sendFile: true,
      createDocument: true,
    });
    expect(withTool.stableLength).toBe(without.stableLength);
    expect(withTool.text.slice(0, withTool.stableLength)).toBe(
      without.text.slice(0, without.stableLength),
    );
    expect(without.text).not.toContain("create_document");
    // The skill and the tool line come after the shared part.
    expect(withTool.text.slice(0, withTool.stableLength)).not.toContain("suup_docs");
    expect(withTool.text.slice(withTool.stableLength)).toContain("suup_docs");
  });
});
