import type { Bot, Run } from "@suup/api";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import {
  mergeBot,
  mergeConversation,
  mergeRun,
  mergeRunEvents,
  upsertMessage,
} from "../../data/reducers.js";
import { createDataStore, update } from "../../data/store.js";
import { makeBot, makeConversation, makeEvent, makeMessage, makeRun } from "../../test-fixtures.js";
import { ChatScreen } from "./ChatScreen.js";

// The bot's live avatar in the chat (docs/DESIGN.md §3, "O bot trabalhando"): it replaced the three
// dots; its face follows what the run does; it leaves smoothly when the answer arrives; reduced
// motion makes it a still face that leaves at once.

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.motion;
});

const BOT = "00000000-0000-4000-8000-0000000000b1";
const CONV = "00000000-0000-4000-8000-0000000000c1";

function setup(over: Partial<Bot> = {}) {
  const store = createDataStore();
  update(store, (s) => mergeConversation(s, makeConversation({ id: CONV })));
  update(store, (s) =>
    mergeBot(
      s,
      makeBot({
        id: BOT,
        name: "Nova",
        conversationId: CONV,
        personality: "x",
        avatar: "mascot:blob",
        color: "azul",
        ...over,
      }),
    ),
  );
  const run = makeRun({ botId: BOT, conversationId: CONV, status: "running" });
  update(store, (s) => mergeRun(s, run));
  update(store, (s) =>
    upsertMessage(
      s,
      makeMessage({ conversationId: CONV, seq: 1, runId: run.id, text: "faça o relatório" }),
    ),
  );
  const sync = {
    openBotConversation: async () => store.getState().conversations[CONV],
    startReceptionIfDue: async () => undefined,
    watchConversation: async () => undefined,
    unwatchConversation: () => undefined,
    follow: () => undefined,
    markRead: async () => undefined,
    loadOlderMessages: async () => false,
    send: vi.fn(),
  };
  const services = { sync, data: store, platform: { openUrl: vi.fn() } } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <ChatScreen />
    </ServicesProvider>,
  );
  const set = (patch: Partial<Run>) => act(() => update(store, (s) => mergeRun(s, { ...run, ...patch, updatedAt: new Date(Date.now() + 1000).toISOString() })));
  const events = (...items: ReturnType<typeof makeEvent>[]) =>
    act(() => update(store, (s) => mergeRunEvents(s, run.id, items)));
  const answer = (text: string) =>
    act(() =>
      update(store, (s) =>
        upsertMessage(
          s,
          makeMessage({
            conversationId: CONV,
            seq: 2,
            runId: run.id,
            authorKind: "bot",
            authorBotId: BOT,
            text,
          }),
        ),
      ),
    );
  return { run, set, events, answer };
}

const indicator = () => screen.queryByTestId("working-indicator");
const face = () => indicator()?.querySelector("[data-mascot]") as HTMLElement | null;

beforeEach(() => {
  useUi.setState({ selectedBotId: BOT, panelOpen: false, chatPrefill: null, view: "chat" });
});

describe("the live avatar replaces the three dots", () => {
  it("while the run works: the bot's own face, its phrase, no dots; the face follows the run", async () => {
    const { events } = setup();
    await screen.findByTestId("working-indicator");
    expect(document.querySelector('[data-testid="dots-dot"]')).toBeNull();
    expect(indicator()?.dataset.activity).toBe("thinking");
    expect(indicator()?.textContent).toBe("Pensando…");
    expect(face()?.dataset.mascot).toBe("blob");
    expect(face()?.dataset.color).toBe("azul");
    expect(face()?.dataset.state).toBe("pondering");

    events(makeEvent(1, "tool_call", { callId: "a", name: "shell", args: { command: "ls -la" } }));
    expect(indicator()?.dataset.activity).toBe("terminal");
    expect(face()?.dataset.state).toBe("coding");
    // Friendly: the command is never in the phrase.
    expect(indicator()?.textContent).toBe("Rodando um comando…");

    events(
      makeEvent(2, "tool_result", { callId: "a", content: "ok", isError: false }),
      makeEvent(3, "tool_call", { callId: "b", name: "web_search", args: { query: "x" } }),
    );
    expect(face()?.dataset.state).toBe("reading");
    expect(indicator()?.textContent).toBe("Procurando na web…");
  });

  it("waiting for your approval: the asking face, under the card", async () => {
    const { set } = setup();
    await screen.findByTestId("working-indicator");
    set({ status: "waiting_approval" });
    expect(indicator()?.dataset.activity).toBe("approval");
    expect(face()?.dataset.state).toBe("asking");
    expect(indicator()?.textContent).toBe("Esperando a sua aprovação…");
  });

  it("the answer arrives: the same row leaves with the face of 'done', then it is gone", async () => {
    const { set, answer } = setup();
    await screen.findByTestId("working-indicator");
    const before = face();
    answer("Aqui está o relatório.");
    set({ status: "done", finishedAt: new Date().toISOString() });
    const wrap = screen.getByTestId("working-wrap");
    expect(wrap.dataset.leaving).toBe("true");
    // The same element (never remounted), now with the happy face, and no longer announced.
    expect(face()).toBe(before);
    expect(face()?.dataset.state).toBe("done");
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.transitionEnd(wrap, { propertyName: "opacity" });
    expect(indicator()).toBeNull();
    expect(screen.getByText("Aqui está o relatório.")).not.toBeNull();
  });

  it("a failed run leaves with the 'failed' face", async () => {
    const { set } = setup();
    await screen.findByTestId("working-indicator");
    set({ status: "failed", failureOrigin: "limit" });
    expect(face()?.dataset.state).toBe("failed");
  });

  it("reduced motion: a still face, and it leaves at once", async () => {
    document.documentElement.dataset.motion = "reduce";
    const { set } = setup();
    await screen.findByTestId("working-indicator");
    expect(face()?.dataset.mode).toBe("still");
    set({ status: "done" });
    expect(indicator()).toBeNull();
  });

  it("the pixel style and its 3D are the bot's own", async () => {
    setup({ avatarStyle: "pixel", avatar: "mascot:gato", avatarPixel3d: true, color: null });
    await screen.findByTestId("working-indicator");
    const pixel = indicator()?.querySelector('[data-mascot-style="pixel"]') as HTMLElement;
    expect(pixel).not.toBeNull();
    expect(pixel.dataset.pixel3d).toBe("true");
    expect(pixel.dataset.state).toBe("pondering");
  });
});
