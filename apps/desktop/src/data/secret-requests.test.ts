import { describe, expect, it } from "vitest";
import { makeEvent, makeRun } from "../test-fixtures.js";
import { DECLINED_PREFIX, openSecretRequest, secretRequestsOf } from "./secret-requests.js";

const asked = (seq: number, name = "GH_TOKEN", reason?: string) =>
  makeEvent(seq, "secret_requested", { callId: `c${seq}`, name, ...(reason ? { reason } : {}) });
const answered = (seq: number, callId: string, content: string) =>
  makeEvent(seq, "tool_result", { callId, content, isError: false });

describe("secret requests of a run", () => {
  it("open while the run waits for the person: the name and the reason the bot gave", () => {
    const run = makeRun({ status: "waiting_user" });
    const items = secretRequestsOf(run, run.id, [asked(3, "GH_TOKEN", "para dar push")]);
    expect(items).toEqual([
      expect.objectContaining({
        callId: "c3",
        name: "GH_TOKEN",
        reason: "para dar push",
        state: "open",
      }),
    ]);
    expect(openSecretRequest(run, run.id, [asked(3)])?.name).toBe("GH_TOKEN");
  });

  it("answered with a value: the secret is available; answered with a refusal: declined", () => {
    const run = makeRun({ status: "running" });
    const events = [
      asked(2, "A_TOKEN"),
      answered(3, "c2", "The secret A_TOKEN is now available. Use it as {{secret:A_TOKEN}}."),
      asked(4, "B_TOKEN"),
      answered(5, "c4", `${DECLINED_PREFIX} to provide the secret B_TOKEN.`),
    ];
    expect(secretRequestsOf(run, run.id, events).map((i) => [i.name, i.state])).toEqual([
      ["A_TOKEN", "provided"],
      ["B_TOKEN", "declined"],
    ]);
    expect(openSecretRequest(run, run.id, events)).toBeUndefined();
  });

  it("a run that ended without an answer shows a closed request, and never an open form", () => {
    const run = makeRun({ status: "cancelled" });
    expect(secretRequestsOf(run, run.id, [asked(2)])[0]?.state).toBe("closed");
    expect(openSecretRequest(run, run.id, [asked(2)])).toBeUndefined();
  });

  it("only the latest unanswered request can be open", () => {
    const run = makeRun({ status: "waiting_user" });
    const items = secretRequestsOf(run, run.id, [asked(2, "A_TOKEN"), asked(3, "B_TOKEN")]);
    expect(items.map((i) => i.state)).toEqual(["closed", "open"]);
  });

  it("ignores other events and a result of another call", () => {
    const run = makeRun({ status: "waiting_user" });
    const items = secretRequestsOf(run, run.id, [
      makeEvent(1, "tool_call", { callId: "x", name: "shell" }),
      asked(2),
      answered(3, "x", "ok"),
    ]);
    expect(items[0]?.state).toBe("open");
  });
});
