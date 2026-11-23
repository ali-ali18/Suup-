import type { Routine, RoutineFire, SuupClient } from "@suup/api";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useSettings } from "../../app/settings-store.js";
import { useUi } from "../../app/ui-store.js";
import { mergeBot } from "../../data/reducers.js";
import { createDataStore, update } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { makeBot, routineOf } from "../../test-fixtures.js";
import { Panel } from "./Panel.js";
import { FIRES_PAGE } from "./RoutineDetail.js";

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
  return { api: api.routines, openUrl };
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
    expect(within(rows[1] as HTMLElement).getByTestId("routine-next").textContent).toBe("Pausada");
    expect(screen.queryByRole("button", { name: /Ações da rotina/ })).toBeNull();
    expect(screen.queryByTestId("routine-form")).toBeNull();
  });
});

describe("the detail of a routine, in the panel", () => {
  it("replaces the list: back on the left, the routine in words, its results", async () => {
    setup([routineOf()]);
    const detail = await openDetail();
    expect(screen.queryByTestId("section-routines")).toBeNull();
    expect(
      await within(detail).findByRole("heading", { name: "Calendário da manhã" }),
    ).toBeTruthy();
    expect(within(detail).getByTestId("routine-schedule").textContent).toBe("todo dia às 08:00");
    expect(within(detail).getByTestId("routine-next").textContent).toContain("Próxima:");
    fireEvent.click(within(detail).getByRole("button", { name: "Voltar às rotinas" }));
    expect(await screen.findByTestId("section-routines")).toBeTruthy();
    expect(screen.queryByTestId("routine-detail")).toBeNull();
  });

  it("what the bot wrote is Markdown, with the same renderer as the chat", async () => {
    setup([routineOf()]);
    const detail = await openDetail();
    const result = await within(detail).findByTestId("routine-result");
    expect(within(result).getByText("Hoje").className).toContain("font-title");
    expect(within(result).getByText("15h").tagName).toBe("STRONG");
    expect(result.querySelectorAll("li")).toHaveLength(2);
    expect(result.textContent).not.toContain("**");
  });

  it("the sources: the generic icon while the icons of sites are off, the site's own when on", async () => {
    const { openUrl } = setup([routineOf()]);
    const detail = await openDetail();
    const [web, connector] = await within(detail).findAllByTestId("routine-source");
    expect(web?.textContent).toBe("agenda.exemplo.com.br");
    expect(web?.getAttribute("href")).toBe("https://agenda.exemplo.com.br/hoje");
    expect(web?.querySelector("img")).toBeNull();
    expect(web?.querySelector(".lucide-globe")).not.toBeNull();
    expect(connector?.textContent).toBe("calendario");
    expect(connector?.querySelector(".lucide-plug")).not.toBeNull();
    fireEvent.click(web as HTMLElement);
    expect(openUrl).toHaveBeenCalledWith("https://agenda.exemplo.com.br/hoje");
    act(() => useSettings.getState().update({ favicons: "on" }));
    const img = within(detail).getAllByTestId("routine-source")[0]?.querySelector("img");
    // the host ONLY, never the page's path
    expect(img?.getAttribute("src")).toBe("https://agenda.exemplo.com.br/favicon.ico");
  });

  it("a skipped fire is one quiet line; a failure shows the reason as plain text", async () => {
    setup(
      [routineOf()],
      [
        fireOf({ id: "00000000-0000-4000-8000-0000000000f3", status: "skipped", runId: null }),
        fireOf({
          id: "00000000-0000-4000-8000-0000000000f2",
          status: "failed",
          resultText: "A execução falhou: **sem** acesso.",
          sources: [],
        }),
      ],
    );
    const detail = await openDetail();
    const [skipped, failed] = await within(detail).findAllByTestId("routine-fire");
    expect(skipped?.textContent).toContain("Pulada: a anterior ainda rodava");
    expect(within(skipped as HTMLElement).queryByTestId("routine-result")).toBeNull();
    expect(within(failed as HTMLElement).getByTestId("routine-result").textContent).toBe(
      "A execução falhou: **sem** acesso.",
    );
  });

  it("shows more on request", async () => {
    const many = Array.from({ length: FIRES_PAGE + 3 }, (_, i) =>
      fireOf({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }),
    );
    const { api } = setup([routineOf()], many);
    const detail = await openDetail();
    await waitFor(() =>
      expect(within(detail).getAllByTestId("routine-fire")).toHaveLength(FIRES_PAGE),
    );
    fireEvent.click(within(detail).getByTestId("routine-more"));
    await waitFor(() =>
      expect(within(detail).getAllByTestId("routine-fire")).toHaveLength(FIRES_PAGE + 3),
    );
    expect(api.fires).toHaveBeenLastCalledWith(routineOf().id, { limit: FIRES_PAGE * 2 });
    expect(within(detail).queryByTestId("routine-more")).toBeNull();
  });

  it("pauses, resumes and runs now from the icons on top", async () => {
    const { api } = setup([routineOf()]);
    const detail = await openDetail();
    fireEvent.click(await within(detail).findByRole("button", { name: "Pausar a rotina" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(routineOf().id, { paused: true }));
    expect(await within(detail).findByRole("button", { name: "Retomar a rotina" })).toBeTruthy();
    expect(within(detail).getByTestId("routine-next").textContent).toBe("Pausada");
    fireEvent.click(within(detail).getByRole("button", { name: /Rodar agora/ }));
    await waitFor(() => expect(api.run).toHaveBeenCalledWith(routineOf().id));
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
