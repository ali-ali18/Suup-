import type { Routine, SuupClient } from "@suup/api";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { createDataStore } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { routineOf } from "../../test-fixtures.js";
import { ActivityTab } from "./ActivityTab.js";

afterEach(cleanup);

const BOT = "00000000-0000-4000-8000-0000000000b1";

function setup(routines: Routine[], extra: Record<string, unknown> = {}) {
  const update = vi.fn(async (id: string, body: Record<string, unknown>) => {
    const current = routines.find((r) => r.id === id) as Routine;
    return {
      ...current,
      ...body,
      status: body.paused === true ? "paused" : body.paused === false ? "active" : current.status,
      nextRunAt: body.paused === true ? null : current.nextRunAt,
    } as Routine;
  });
  const run = vi.fn(async () => ({ kind: "manual", status: "running" }));
  const api = {
    routines: {
      list: vi.fn(async () => routines),
      update,
      run,
      delete: vi.fn(async () => undefined),
      fires: vi.fn(async () => []),
      ...extra,
    },
  };
  const store = createDataStore();
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  const services = { api, sync, data: store } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <ActivityTab botId={BOT} />
    </ServicesProvider>,
  );
  return api.routines;
}

const openMenu = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name: `Ações da rotina ${name}` }));

describe("the Rotinas panel", () => {
  it("is honest when there is none: it says how to make one by talking", async () => {
    setup([]);
    expect(await screen.findByText("Nenhuma rotina")).toBeTruthy();
    expect(screen.getByTestId("section-routines").textContent).toContain(
      "Peça no chat, por exemplo",
    );
  });

  it("shows each routine in words, with the next run and the last result", async () => {
    const api = setup([
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
    expect(within(rows[0] as HTMLElement).getByTestId("routine-next").textContent).toContain(
      "Próxima:",
    );
    expect(within(rows[1] as HTMLElement).getByTestId("routine-schedule").textContent).toBe(
      "toda segunda e sexta às 18:00",
    );
    expect(within(rows[1] as HTMLElement).getByTestId("routine-next").textContent).toBe("Pausada");
  });

  it("pauses, resumes and runs now from the row's menu", async () => {
    const api = setup([routineOf()]);
    await screen.findByTestId("routine-row");
    openMenu("Calendário da manhã");
    fireEvent.click(screen.getByRole("menuitem", { name: "Pausar" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(routineOf().id, { paused: true }));
    await waitFor(() => expect(screen.getByTestId("routine-next").textContent).toBe("Pausada"));
    openMenu("Calendário da manhã");
    fireEvent.click(screen.getByRole("menuitem", { name: /Rodar agora/ }));
    await waitFor(() => expect(api.run).toHaveBeenCalledWith(routineOf().id));
  });

  it("edits WHEN with structured fields and sends the schedule, never text", async () => {
    const api = setup([routineOf()]);
    await screen.findByTestId("routine-row");
    openMenu("Calendário da manhã");
    fireEvent.click(screen.getByRole("menuitem", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog");
    // kind: weekly
    fireEvent.click(within(dialog).getByTestId("routine-kind"));
    fireEvent.click(screen.getByRole("option", { name: "Toda semana" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "quarta" }));
    // hour 07, minute 30
    fireEvent.click(within(dialog).getByTestId("routine-hour"));
    fireEvent.click(screen.getByRole("option", { name: "07" }));
    fireEvent.click(within(dialog).getByTestId("routine-minute"));
    fireEvent.click(screen.getByRole("option", { name: "30" }));
    expect(within(dialog).getByTestId("routine-preview").textContent).toContain(
      "toda segunda e quarta às 07:30",
    );
    fireEvent.click(within(dialog).getByTestId("routine-save"));
    await waitFor(() =>
      expect(api.update).toHaveBeenCalledWith(routineOf().id, {
        name: "Calendário da manhã",
        instruction: "Veja meu calendário de hoje.",
        schedule: { kind: "weekly", days: ["mon", "wed"], time: "07:30" },
        timeZone: "America/Sao_Paulo",
      }),
    );
  });

  it("an empty set of days cannot be saved, and the form says why", async () => {
    setup([routineOf({ schedule: { kind: "weekly", days: ["mon"], time: "09:00" } })]);
    await screen.findByTestId("routine-row");
    openMenu("Calendário da manhã");
    fireEvent.click(screen.getByRole("menuitem", { name: "Editar" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "segunda" }));
    expect(within(dialog).getByTestId("routine-form-error").textContent).toBe(
      "Escolha pelo menos um dia.",
    );
    expect(within(dialog).getByTestId("routine-save").hasAttribute("disabled")).toBe(true);
  });

  it("deletes after asking once", async () => {
    const api = setup([routineOf()]);
    await screen.findByTestId("routine-row");
    openMenu("Calendário da manhã");
    fireEvent.click(screen.getByRole("menuitem", { name: "Apagar" }));
    fireEvent.click(await screen.findByTestId("routine-delete-confirm"));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith(routineOf().id));
    await waitFor(() => expect(screen.queryByTestId("routine-row")).toBeNull());
  });
});
