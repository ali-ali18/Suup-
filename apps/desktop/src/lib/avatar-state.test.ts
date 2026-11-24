import { RUN_STATUSES, type RunStatus } from "@suup/api";
import { AVATAR_STATES, BODY_MORPH_STATES } from "@suup/avatar";
import { describe, expect, it } from "vitest";
import { avatarStateOf } from "./avatar-state.js";

describe("avatarStateOf", () => {
  const cases: [string, RunStatus, boolean, boolean, string][] = [
    ["queued", "queued", false, false, "working"],
    ["queued and paused", "queued", true, false, "paused"],
    ["running, no tool", "running", false, false, "working"],
    ["running a tool", "running", false, true, "working"],
    ["running and paused", "running", true, false, "paused"],
    ["running a tool, then paused", "running", true, true, "paused"],
    ["waiting for the user's answer", "waiting_user", false, false, "asking"],
    ["waiting for an approval", "waiting_approval", false, false, "asking"],
    ["parked until its own return", "waiting_timer", false, false, "idle"],
    ["done", "done", false, false, "done"],
    ["failed", "failed", false, false, "failed"],
    ["cancelled", "cancelled", false, false, "idle"],
  ];
  it.each(cases)("%s -> %s", (_name, status, paused, tool, expected) => {
    expect(avatarStateOf({ status, paused }, tool)).toBe(expected);
  });

  it("no run: idle", () => {
    expect(avatarStateOf(null)).toBe("idle");
    expect(avatarStateOf(null, true)).toBe("idle");
  });

  it("the pause flag only matters while the run can be paused", () => {
    expect(avatarStateOf({ status: "waiting_user", paused: true })).toBe("asking");
    expect(avatarStateOf({ status: "done", paused: true })).toBe("done");
  });

  it("keeps the face in every state: never one whose body turns into an indicator (owner, 24/11/2026)", () => {
    expect(BODY_MORPH_STATES).toEqual(expect.arrayContaining(["thinking", "waiting"]));
    for (const status of RUN_STATUSES) {
      for (const paused of [false, true]) {
        for (const tool of [false, true]) {
          expect(BODY_MORPH_STATES).not.toContain(avatarStateOf({ status, paused }, tool));
        }
      }
    }
  });

  it("covers every status of the contract with a state the engine knows", () => {
    for (const status of RUN_STATUSES) {
      for (const paused of [false, true]) {
        expect(AVATAR_STATES).toContain(avatarStateOf({ status, paused }));
      }
    }
  });
});
