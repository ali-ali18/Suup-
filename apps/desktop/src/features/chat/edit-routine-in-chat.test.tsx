import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { mergeBot, mergeConversation } from "../../data/reducers.js";
import { createDataStore, update } from "../../data/store.js";
import { makeBot, makeConversation, routineOf } from "../../test-fixtures.js";
import { ChatScreen } from "./ChatScreen.js";

// "Editar" on a routine (docs/ROTINAS.md): the chat of its bot gets the draft, focused, with the
// caret at the end, and the routine bound to it as data. The id is never in the text; clearing the
// draft or opening another bot drops the reference.

afterEach(cleanup);

const A = "00000000-0000-4000-8000-0000000000b1";
const B = "00000000-0000-4000-8000-0000000000b2";
const DRAFT = "Editar a rotina “Calendário da manhã” (todo dia às 08:00): ";

function setup() {
  const store = createDataStore();
  for (const [id, name] of [
    [A, "Agenda"],
    [B, "Outro"],
  ] as const) {
    const conversation = makeConversation({ id: `${id.slice(0, -2)}c${id.slice(-1)}` });
    update(store, (s) => mergeConversation(s, conversation));
    update(store, (s) =>
      mergeBot(s, makeBot({ id, name, conversationId: conversation.id, personality: "x" })),
    );
  }
  const send = vi.fn(
    async (_c: string, text: string, _options: { routineRef?: { id: string } } = {}) => ({
      ok: false as const,
      text,
    }),
  );
  const sync = {
    openBotConversation: async (bot: { conversationId: string | null }) =>
      store.getState().conversations[bot.conversationId as string],
    startReceptionIfDue: async () => undefined,
    watchConversation: async () => undefined,
    unwatchConversation: () => undefined,
    follow: () => undefined,
    markRead: async () => undefined,
    loadOlderMessages: async () => false,
    send,
  };
  const services = { sync, data: store, platform: { openUrl: vi.fn() } } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <ChatScreen />
    </ServicesProvider>,
  );
  return { send };
}

const field = () => screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement;
const editar = () =>
  act(() =>
    useUi.getState().editRoutineInChat({
      botId: A,
      text: DRAFT,
      routine: { id: routineOf().id, name: "Calendário da manhã" },
    }),
  );

beforeEach(() => {
  useUi.setState({ selectedBotId: A, panelOpen: false, chatPrefill: null, view: "chat" });
});

describe("Editar a routine in the chat", () => {
  it("prefills the composer, focused, caret at the end, with the routine's NAME in a chip", async () => {
    setup();
    await screen.findByTestId("chat");
    editar();
    await waitFor(() => expect(field().value).toBe(DRAFT));
    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(DRAFT.length);
    const chip = screen.getByTestId("draft-routine");
    expect(chip.textContent).toContain("Calendário da manhã");
    expect(chip.textContent).not.toContain(routineOf().id);
    expect(document.body.textContent).not.toContain(routineOf().id);
    // taken: it does not come back on the next render
    expect(useUi.getState().chatPrefill).toBeNull();
  });

  it("sends the text as typed and the routine as data (the hidden reference)", async () => {
    const { send } = setup();
    await screen.findByTestId("chat");
    editar();
    await waitFor(() => expect(field().value).toBe(DRAFT));
    fireEvent.change(field(), { target: { value: `${DRAFT}muda pra 7h` } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const [, text, options] = send.mock.calls[0] ?? [];
    expect(text).toBe(`${DRAFT}muda pra 7h`);
    expect(text).not.toContain(routineOf().id);
    expect(options).toEqual({ routineRef: { id: routineOf().id } });
  });

  it("clearing the draft drops the reference: the message goes without it", async () => {
    const { send } = setup();
    await screen.findByTestId("chat");
    editar();
    await waitFor(() => expect(field().value).toBe(DRAFT));
    fireEvent.change(field(), { target: { value: "" } });
    expect(screen.queryByTestId("draft-routine")).toBeNull();
    fireEvent.change(field(), { target: { value: "outra coisa" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[2]).toEqual({});
  });

  it("the chip's remove drops it too, and opening another bot never carries it over", async () => {
    setup();
    await screen.findByTestId("chat");
    editar();
    await waitFor(() => expect(screen.getByTestId("draft-routine")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Tirar a rotina/ }));
    expect(screen.queryByTestId("draft-routine")).toBeNull();
    editar();
    await waitFor(() => expect(screen.getByTestId("draft-routine")).toBeTruthy());
    act(() => useUi.getState().selectBot(B));
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-bot")).toBe("Outro"));
    expect(screen.queryByTestId("draft-routine")).toBeNull();
    act(() => useUi.getState().selectBot(A));
    await waitFor(() => expect(screen.getByTestId("chat").getAttribute("data-bot")).toBe("Agenda"));
    expect(screen.queryByTestId("draft-routine")).toBeNull();
  });
});
