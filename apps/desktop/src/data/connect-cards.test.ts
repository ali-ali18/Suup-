import { describe, expect, it } from "vitest";
import { makeApproval, makeEvent, makeRun } from "../test-fixtures.js";
import {
  connectCardOfApproval,
  connectCardsOf,
  connectCardsOfConversation,
} from "./connect-cards.js";

const run = makeRun();
const call = (seq: number, callId: string, name: string, args: unknown) =>
  makeEvent(seq, "tool_call", { callId, name, args });
const result = (seq: number, callId: string, isError = false) =>
  makeEvent(seq, "tool_result", { callId, content: "ok", isError });

describe("the connect cards of a run", () => {
  it("come from the declared arguments of show_connect_card, kept only when the tool answered without error", () => {
    const cards = connectCardsOf(run, [
      call(1, "a", "show_connect_card", {
        connector: "composio",
        app: "Google Agenda",
        url: "https://connect.composio.dev/link/lk_x?token=1",
        expiresAt: "2026-11-24T13:00:00Z",
        action: "authorize_app",
      }),
      result(2, "a"),
      call(3, "b", "show_connect_card", {
        connector: "composio",
        action: "connect",
        url: "https://evil.example/",
      }),
      result(4, "b", true),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      callId: "a",
      connector: "composio",
      app: "Google Agenda",
      action: "authorize_app",
      botId: run.botId,
    });
  });

  it("a propose_connector that worked is a card too (even when nothing asked the user: already installed)", () => {
    const cards = connectCardsOf(run, [
      call(1, "p", "propose_connector", { connector: "notion", reason: "x" }),
      result(2, "p"),
    ]);
    expect(cards.map((c) => [c.connector, c.action])).toEqual([["notion", "connect"]]);
  });

  it("an approved proposal whose run is not loaded still gives its card; one loaded is not doubled", () => {
    const approval = makeApproval({
      tool: "propose_connector",
      status: "approved",
      callId: "p",
      args: { connector: "notion", reason: "x" },
    });
    expect(connectCardOfApproval(approval)?.connector).toBe("notion");
    expect(
      connectCardOfApproval(makeApproval({ tool: "propose_connector", status: "denied" })),
    ).toBeUndefined();
    const withEvents = connectCardsOfConversation(
      [run],
      { [run.id]: [call(1, "p", "propose_connector", { connector: "notion" }), result(2, "p")] },
      [approval],
    );
    expect(withEvents).toHaveLength(1);
    expect(connectCardsOfConversation([run], {}, [approval])).toHaveLength(1);
  });
});
