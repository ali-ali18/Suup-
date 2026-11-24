import { RUN_STATUSES, type RunStatus } from "@suup/api";
import { AVATAR_STATES, BODY_MORPH_STATES, PIXEL_POSE_OF } from "@suup/avatar";
import { describe, expect, it } from "vitest";
import { makeEvent } from "../test-fixtures.js";
import {
  ACTIVITY_AVATAR,
  activityPhrase,
  CHAT_ACTIVITIES,
  type ChatActivity,
  chatActivityOf,
} from "./chat-activity.js";

const call = (seq: number, callId: string, name: string, args: Record<string, unknown> = {}) =>
  makeEvent(seq, "tool_call", { callId, name, args });
const result = (seq: number, callId: string) =>
  makeEvent(seq, "tool_result", { callId, content: "ok", isError: false, truncated: false });
const running = { status: "running" as const, paused: false };

describe("chatActivityOf: what the run on screen is doing, from its status and events", () => {
  it("running with no tool in flight is thinking (waiting for the model)", () => {
    expect(chatActivityOf(running, [])).toBe("thinking");
    expect(chatActivityOf(running, [call(1, "a", "shell"), result(2, "a")])).toBe("thinking");
  });

  it.each<[string, Record<string, unknown>, ChatActivity]>([
    ["shell", { command: "ls" }, "terminal"],
    ["read_file", { path: "a" }, "files"],
    ["write_file", { path: "a" }, "files"],
    ["edit_file", { path: "a" }, "files"],
    ["web_search", { query: "x" }, "web"],
    ["web_read", { url: "https://a.b" }, "web"],
    ["web_fetch", { url: "https://a.b" }, "web"],
    ["recall", {}, "memory"],
    ["remember", {}, "memory"],
    ["delegate", {}, "tool"],
    ["create_routine", {}, "tool"],
    ["conn_fake__echo", {}, "tool"],
    ["uma_ferramenta_qualquer", {}, "tool"],
  ])("a call of %s in flight is %s (by the exact name, never by text)", (name, args, activity) => {
    expect(chatActivityOf(running, [call(1, "a", name, args)])).toBe(activity);
  });

  it("the real tool behind use_tool counts; the control tools do not", () => {
    expect(
      chatActivityOf(running, [call(1, "u", "use_tool", { tool: "shell", arguments: {} })]),
    ).toBe("terminal");
    for (const control of ["plan", "finish", "escalate", "schedule_return"])
      expect(chatActivityOf(running, [call(1, "c", control)])).toBe("thinking");
  });

  it("the last unanswered call wins", () => {
    expect(
      chatActivityOf(running, [call(1, "a", "shell"), result(2, "a"), call(3, "b", "web_search")]),
    ).toBe("web");
  });

  it.each<[RunStatus, boolean, ChatActivity | null]>([
    ["queued", false, "queued"],
    ["queued", true, "paused"],
    ["running", true, "paused"],
    ["waiting_approval", false, "approval"],
    ["waiting_user", false, "question"],
    ["done", false, "done"],
    ["failed", false, "failed"],
    ["cancelled", false, "failed"],
    // A bot parked until its own return has no mark at all (docs/DESIGN.md §1).
    ["waiting_timer", false, null],
  ])("status %s (paused %s) is %s", (status, paused, activity) => {
    expect(chatActivityOf({ status, paused }, [call(1, "a", "shell")])).toBe(activity);
  });

  it("no run: no avatar", () => {
    expect(chatActivityOf(null, [])).toBeNull();
  });

  it("every status of the contract has an answer", () => {
    for (const status of RUN_STATUSES) {
      const activity = chatActivityOf({ status, paused: false }, []);
      if (activity !== null) expect(CHAT_ACTIVITIES).toContain(activity);
    }
  });
});

describe("ACTIVITY_AVATAR: the expression of each activity", () => {
  it("is the exact map the design names", () => {
    expect(ACTIVITY_AVATAR).toEqual({
      queued: "pondering",
      thinking: "pondering",
      terminal: "coding",
      files: "reading",
      web: "reading",
      memory: "reading",
      tool: "working",
      approval: "asking",
      question: "asking",
      paused: "paused",
      done: "done",
      failed: "failed",
    });
    expect(Object.keys(ACTIVITY_AVATAR).sort()).toEqual([...CHAT_ACTIVITIES].sort());
  });

  it("is always a state the engine knows, and never one whose body turns into an indicator", () => {
    for (const state of Object.values(ACTIVITY_AVATAR)) {
      expect(AVATAR_STATES).toContain(state);
      expect(BODY_MORPH_STATES).not.toContain(state);
    }
  });

  it("thinking looks different from working, in both styles", () => {
    expect(ACTIVITY_AVATAR.thinking).not.toBe(ACTIVITY_AVATAR.tool);
    // The pixel style has the owner's own "Pensando" pose for it.
    expect(PIXEL_POSE_OF[ACTIVITY_AVATAR.thinking]).toBe("pensando");
    expect(PIXEL_POSE_OF[ACTIVITY_AVATAR.approval]).toBe("duvida");
  });
});

describe("activityPhrase: short, friendly, never technical", () => {
  const run = { startedAt: "2026-11-24T12:00:00.000Z" };
  const plan = [
    { id: "s1", title: "Ler o código", status: "done" as const },
    { id: "s2", title: "Rodar os testes", status: "in_progress" as const },
  ];

  it("one fixed phrase per activity: no command, path, URL or tool name", () => {
    expect(activityPhrase("terminal", run, plan)).toBe("Rodando um comando");
    expect(activityPhrase("files", run, [])).toBe("Mexendo nos arquivos");
    expect(activityPhrase("web", run, plan)).toBe("Procurando na web");
    expect(activityPhrase("memory", run, [])).toBe("Usando a memória");
    expect(activityPhrase("tool", run, [])).toBe("Trabalhando");
    expect(activityPhrase("approval", run, [])).toBe("Esperando a sua aprovação");
    expect(activityPhrase("question", run, [])).toBe("Esperando a sua resposta");
    expect(activityPhrase("paused", run, plan)).toBe("Pausado");
  });

  it("thinking with a plan of several steps says the step (the bot's own words)", () => {
    expect(activityPhrase("thinking", run, plan)).toBe("Passo 2 de 2 · Rodar os testes");
    expect(activityPhrase("thinking", run, [])).toBe("Pensando");
    expect(activityPhrase("thinking", run, [plan[1] as (typeof plan)[number]])).toBe("Pensando");
  });

  it("queued: 'Retomando' after it had started, else 'Na fila'", () => {
    expect(activityPhrase("queued", run, [])).toBe("Retomando");
    expect(activityPhrase("queued", { startedAt: null }, [])).toBe("Na fila");
  });
});
