import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { mergeApprovals, setBots } from "../../data/reducers.js";
import { createDataStore, update } from "../../data/store.js";
import { makeApproval, makeBot } from "../../test-fixtures.js";
import { ApprovalAnnouncer } from "./ApprovalAnnouncer.js";

function setup() {
  const data = createDataStore();
  const bot = makeBot({ name: "Ajudante" });
  update(data, (s) => setBots(s, [bot]));
  render(
    <ServicesProvider services={{ data } as unknown as Services}>
      <ApprovalAnnouncer />
    </ServicesProvider>,
  );
  const say = () => screen.getByTestId("approval-announcer").textContent;
  return { data, bot, say };
}

describe("the live announcement of approvals", () => {
  it("is a polite status region, hidden from the eyes, and says nothing before the cards are read", () => {
    const { say } = setup();
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.className).toContain("sr-only");
    expect(say()).toBe("");
  });

  it("says once how many cards were already waiting when the app opened", () => {
    const { data, bot, say } = setup();
    act(() => update(data, (s) => mergeApprovals(s, [makeApproval({ botId: bot.id })])));
    expect(say()).toBe("Há um pedido de aprovação esperando você.");
  });

  it("then announces each new card by its bot and its summary, on whatever screen", () => {
    const { data, bot, say } = setup();
    act(() => update(data, (s) => mergeApprovals(s, [])));
    expect(say()).toBe("");
    act(() =>
      update(data, (s) =>
        mergeApprovals(s, [makeApproval({ botId: bot.id, summary: "Shell em repo: git push" })]),
      ),
    );
    expect(say()).toBe("Ajudante pede aprovação: Shell em repo: git push");
  });

  it("a decided card is not announced", () => {
    const { data, bot, say } = setup();
    act(() => update(data, (s) => mergeApprovals(s, [])));
    act(() =>
      update(data, (s) => mergeApprovals(s, [makeApproval({ botId: bot.id, status: "approved" })])),
    );
    expect(say()).toBe("");
  });
});
