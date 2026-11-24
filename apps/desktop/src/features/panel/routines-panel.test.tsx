import type { Routine, RoutineFire, SuupClient } from "@suup/api";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useSettings } from "../../app/settings-store.js";
import { useUi } from "../../app/ui-store.js";
import { mergeBot } from "../../data/reducers.js";
import { createDataStore, update } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { makeBot, pressOption, routineOf } from "../../test-fixtures.js";
import { Panel } from "./Panel.js";

afterEach(cleanup);
beforeEach(() => {
  useUi.setState({ panelRoutineId: null, chatPrefill: null, panelTab: "activity" });
  useSettings.getState().update({ favicons: "off" });
});

const BOT = "00000000-0000-4000-8000-0000000000b1";

const fireOf = (over: Partial<RoutineFire> = {}): RoutineFire => ({
  id: "00000000-0000-4000-8000-0000000000f1",
  routineId: routineOf().id,
  scheduledFor: "2026-11-22T11:00:00.000Z",
  kind: "scheduled",
  status: "done",
  skipReason: null,
  missedCount: 0,
  runId: "00000000-0000-4000-8000-0000000000e1",
  resultText: "## Hoje\n\n- **15h** dentista\n- 18h relatório",
  messageId: null,
  createdAt: "2026-11-22T11:00:01.000Z",
  finishedAt: "2026-11-22T11:00:09.000Z",
  sources: [
    { kind: "web", url: "https://agenda.exemplo.com.br/hoje", title: "Agenda de hoje" },
    { kind: "connector", connector: "calendario" },
  ],
  ...over,
});

function setup(routines: Routine[], fires: RoutineFire[] = [fireOf()]) {
  const api = {
    routines: {
      list: vi.fn(async () => routines),
      get: vi.fn(async (id: string) => routines.find((r) => r.id === id) as Routine),
      fires: vi.fn(async (_id: string, query: { limit?: number } = {}) =>
        fires.slice(0, query.limit ?? 30),
      ),
      update: vi.fn(async (id: string, body: Record<string, unknown>) => {
        const current = routines.find((r) => r.id === id) as Routine;
        return {
          ...current,
          status: body.paused === true ? "paused" : "active",
          nextRunAt: body.paused === true ? null : current.nextRunAt,
        } as Routine;
      }),
      run: vi.fn(async () => ({ kind: "manual", status: "running" })),
      delete: vi.fn(async () => undefined),
    },
    models: {
      list: vi.fn(async () => [
        { id: "model-x", provider: "scripted", available: true },
        { id: "model-y", provider: "scripted", available: true },
      ]),
    },
    bots: {
      update: vi.fn(async (_id: string, body: Record<string, unknown>) =>
        makeBot({ id: BOT, name: "Agenda", ...body }),
      ),
    },
  };
  const store = createDataStore();
  update(store, (s) => mergeBot(s, makeBot({ id: BOT, name: "Agenda" })));
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  const openUrl = vi.fn();
  const services = { api, sync, data: store, platform: { openUrl } } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <Panel botId={BOT} />
    </ServicesProvider>,
  );
  return { api: api.routines, apiAll: api, openUrl };
}

const openDetail = async (name = "Calendário da manhã") => {
  fireEvent.click(await screen.findByRole("button", { name: `Abrir a rotina ${name}` }));
  return screen.findByTestId("routine-detail");
};

describe("the Rotinas list", () => {
  it("is honest when there is none: it says how to make one by talking", async () => {
    setup([]);
    expect(await screen.findByText("Nenhuma rotina")).toBeTruthy();
    expect(screen.getByTestId("section-routines").textContent).toContain(
      "Peça no chat, por exemplo",
    );
  });

  it("changes the bot's chat model from the Chat e voz card, which also holds the voice ornament", async () => {
    const { apiAll } = setup([]);
    const dropdown = await screen.findByTestId("chat-model");
    expect(dropdown.textContent).toContain("model-x");
    fireEvent.click(dropdown);
    pressOption(await screen.findByRole("option", { name: /model-y/ }));
    await waitFor(() =>
      expect(apiAll.bots.update).toHaveBeenCalledWith(BOT, { modelId: "model-y" }),
    );
    const section = screen.getByTestId("section-voice");
    expect(section.textContent).toContain("Chat e voz");
    const ornament = within(section).getByTestId("ornament-voice");
    expect(ornament.getAttribute("aria-hidden")).toBe("true");
    expect(within(ornament).queryAllByRole("button")).toHaveLength(0);
  });

  it("has a switch on each row that pauses and resumes the routine, like the detail's button", async () => {
    const { api } = setup([routineOf()]);
    const toggle = await screen.findByTestId("routine-toggle");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(routineOf().id, { paused: true }));
    await waitFor(() =>
      expect(screen.getByTestId("routine-toggle").getAttribute("aria-checked")).toBe("false"),
    );
    expect(screen.getByTestId("routine-row").getAttribute("data-status")).toBe("paused");
    fireEvent.click(screen.getByTestId("routine-toggle"));
    await waitFor(() =>
      expect(api.update).toHaveBeenLastCalledWith(routineOf().id, { paused: false }),
    );
  });

  it("shows each routine in words; there is no menu and no schedule form", async () => {
    const { api } = setup([
      routineOf(),
      routineOf({
        id: "00000000-0000-4000-8000-000000000009",
        name: "Resumo da semana",
        schedule: { kind: "weekly", days: ["mon", "fri"], time: "18:00" },
        status: "paused",
        nextRunAt: null,
      }),
    ]);
    const rows = await screen.findAllByTestId("routine-row");
    expect(api.list).toHaveBeenCalledWith({ botId: BOT });
    expect(rows.map((r) => r.getAttribute("data-routine"))).toEqual([
      "Calendário da manhã",
      "Resumo da semana",
    ]);
    expect(within(rows[0] as HTMLElement).getByTestId("routine-schedule").textContent).toBe(
      "todo dia às 08:00",
    );
    expect(within(rows[1] as HTMLElement).getByTestId("routine-schedule").textContent).toBe(
      "Pausada",
    );
    expect(within(rows[1] as HTMLElement).queryByTestId("routine-next")).toBeNull();
    expect(screen.queryByRole("button", { name: /Ações da rotina/ })).toBeNull();
    expect(screen.queryByTestId("routine-form")).toBeNull();
  });
});

describe("the detail of a routine, in the panel", () => {
  it("replaces the list: header with the way back and the name, the instruction in Markdown, nothing else", async () => {
    setup([routineOf({ instruction: "Veja **meu** calendário:\n\n- hoje\n- amanhã" })]);
    const detail = await openDetail();
    expect(screen.queryByTestId("section-routines")).toBeNull();
    expect(
      await within(detail).findByRole("heading", { name: "Calendário da manhã" }),
    ).toBeTruthy();
    const content = await within(detail).findByTestId("routine-instruction");
    expect(within(content).getByText("meu").tagName).toBe("STRONG");
    expect(content.querySelectorAll("li")).toHaveLength(2);
    expect(content.textContent).not.toContain("**");
    // as in the Grok Bot: the section "Quando executar" has the clock and the words; no results list
    expect(within(detail).getByRole("heading", { name: "Instrução" })).toBeTruthy();
    expect(within(detail).getByRole("heading", { name: "Quando executar" })).toBeTruthy();
    expect(within(detail).getByTestId("routine-schedule").textContent).toBe("todo dia às 08:00");
    expect(within(detail).queryByTestId("routine-fires")).toBeNull();
    fireEvent.click(within(detail).getByRole("button", { name: "Voltar às rotinas" }));
    expect(await screen.findByTestId("section-routines")).toBeTruthy();
    expect(screen.queryByTestId("routine-detail")).toBeNull();
  });

  it("the actions are one row at the foot of the column: two equal buttons and the trash circle", async () => {
    setup([routineOf()]);
    const detail = await openDetail();
    const actions = await within(detail).findByTestId("routine-actions");
    expect(detail.lastElementChild).toBe(actions);
    for (const id of ["routine-pause", "routine-edit"]) {
      expect(within(actions).getByTestId(id).className).toContain("flex-1");
    }
    expect(within(actions).getByTestId("routine-remove").getAttribute("aria-label")).toBe(
      "Excluir rotina",
    );
  });

  it("Pausar and Retomar change the routine", async () => {
    const { api } = setup([routineOf()]);
    const detail = await openDetail();
    fireEvent.click(await within(detail).findByRole("button", { name: "Pausar" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(routineOf().id, { paused: true }));
    expect(await within(detail).findByRole("button", { name: "Retomar" })).toBeTruthy();
    expect(within(detail).queryByRole("button", { name: "Testar" })).toBeNull();
  });

  it("Editar goes to the chat with the draft and the routine bound to it (never its id in the text)", async () => {
    setup([routineOf()]);
    const detail = await openDetail();
    fireEvent.click(await within(detail).findByTestId("routine-edit"));
    const prefill = useUi.getState().chatPrefill;
    expect(prefill).toMatchObject({
      botId: BOT,
      text: "Editar a rotina “Calendário da manhã” (todo dia às 08:00): ",
      routine: { id: routineOf().id, name: "Calendário da manhã" },
    });
    expect(prefill?.text).not.toContain(routineOf().id);
    expect(useUi.getState()).toMatchObject({ view: "chat", selectedBotId: BOT });
  });

  it("Remover asks once, deletes, and goes back to the list", async () => {
    const { api } = setup([routineOf()]);
    const detail = await openDetail();
    fireEvent.click(await within(detail).findByTestId("routine-remove"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Remover a rotina?");
    expect(api.delete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId("routine-remove-confirm"));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(routineOf().id));
    await waitFor(() => expect(screen.queryByTestId("routine-detail")).toBeNull());
    expect(useUi.getState().panelRoutineId).toBeNull();
  });
});
