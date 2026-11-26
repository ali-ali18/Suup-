import { CHAT_APPROVAL_TOOL_NAME, createChatApprovalJudge } from "@suup/core";
import { FakeProvider, type FakeStep } from "@suup/core/testing";
import { describe, expect, it } from "vitest";
import { CHAT_BATTERY, runChatBattery } from "../src/index.js";

const judgeThat = (answer: (expect: "yes" | "not_yes") => string) =>
  createChatApprovalJudge({
    provider: new FakeProvider(
      CHAT_BATTERY.map(
        (c): FakeStep => ({
          blocks: [
            {
              type: "tool_call",
              id: "r",
              name: CHAT_APPROVAL_TOOL_NAME,
              args: { answer: answer(c.expect), reason: "x" },
            },
          ],
          usage: { inputTokens: 100, outputTokens: 10 },
        }),
      ),
    ),
    model: { id: "scripted", maxOutputTokens: 300 },
  });

describe("the chat battery (scripted; the real model is measured by hand)", () => {
  it("is well formed: 12 cases, 3 clear yes, unique ids", () => {
    expect(CHAT_BATTERY).toHaveLength(12);
    expect(CHAT_BATTERY.filter((c) => c.expect === "yes")).toHaveLength(3);
    expect(new Set(CHAT_BATTERY.map((c) => c.id)).size).toBe(12);
  });
  it("an ideal judge has no wrong yes and no missed yes; a judge that always says yes is caught", async () => {
    const ideal = await runChatBattery({
      judge: judgeThat((e) => (e === "yes" ? "yes" : "unclear")),
      model: "s",
    });
    expect([ideal.wrongYes, ideal.missedYes]).toEqual([0, 0]);
    const naive = await runChatBattery({ judge: judgeThat(() => "yes"), model: "s" });
    expect(naive.wrongYes).toBe(9);
  });
});
