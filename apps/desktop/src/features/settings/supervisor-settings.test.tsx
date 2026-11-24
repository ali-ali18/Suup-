import { ApiError, type SupervisorSettings, type SuupClient, type TeamReview } from "@suup/api";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { createDataStore } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { pressOption } from "../../test-fixtures.js";
import {
  nightLabel,
  reviewLines,
  SupervisorSettings as Section,
  usd,
} from "./SupervisorSettings.js";

afterEach(cleanup);

const settingsOf = (over: Partial<SupervisorSettings> = {}): SupervisorSettings => ({
  reviewEnabled: true,
  reviewTime: "03:00",
  morningTime: "08:00",
  costCapUsd: null,
  timeZone: "America/Sao_Paulo",
  model: { available: true, id: "m", reason: null },
  ...over,
});

const reviewOf = (over: Partial<TeamReview> = {}): TeamReview => ({
  id: "00000000-0000-4000-8000-000000000001",
  night: "2026-11-21",
  status: "done",
  botsRead: [
    { botId: "00000000-0000-4000-8000-0000000000a1", name: "Tutor", journal: 3, notes: 1, open: 0 },
    {
      botId: "00000000-0000-4000-8000-0000000000a2",
      name: "Finanças",
      journal: 1,
      notes: 0,
      open: 1,
    },
  ],
  leftOver: [],
  capReached: false,
  costCapUsd: null,
  noted: [
    {
      memoryId: "00000000-0000-4000-8000-0000000000b1",
      text: "O Tutor montou o resumo de física.",
    },
  ],
  morningText: "O Tutor espera sua resposta sobre o cronograma.",
  morningPostedAt: "2026-11-21T11:00:00.000Z",
  model: "m",
  inputTokens: 1000,
  outputTokens: 100,
  costUsd: 0.0123,
  error: null,
  createdAt: "2026-11-21T06:00:00.000Z",
  finishedAt: "2026-11-21T06:00:05.000Z",
  ...over,
});

function setup(initial: SupervisorSettings, reviews: TeamReview[] = [], update = vi.fn()) {
  const api = {
    supervisor: { settings: { get: async () => initial, update }, reviews: async () => reviews },
  };
  const store = createDataStore();
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  const services = { api, sync, data: store } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <Section />
    </ServicesProvider>,
  );
  return update;
}

describe("Configurações > Memória > Principal", () => {
  it("shows the owner's defaults: review on at 03:00, morning at 08:00, no cap", async () => {
    setup(settingsOf());
    expect((await screen.findByTestId("supervisor-review-time")).textContent).toBe("03:00");
    expect(screen.getByTestId("supervisor-morning-time").textContent).toBe("08:00");
    expect(screen.getByTestId("supervisor-cost-cap").textContent).toBe("Sem teto");
    expect(screen.getByTestId("supervisor-enabled").getAttribute("aria-checked")).toBe("true");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Principal",
      "Revisões da equipe",
    ]);
  });

  it("sends only the key that changed: off, a time, no morning message, a cap and back to none", async () => {
    const update = vi.fn(async () => settingsOf());
    setup(settingsOf(), [], update);
    fireEvent.click(await screen.findByTestId("supervisor-enabled"));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ reviewEnabled: false }));
    fireEvent.click(screen.getByTestId("supervisor-review-time"));
    pressOption(await screen.findByRole("option", { name: "04:00" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ reviewTime: "04:00" }));
    fireEvent.click(screen.getByTestId("supervisor-morning-time"));
    pressOption(await screen.findByRole("option", { name: "Desligada" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ morningTime: null }));
    fireEvent.click(screen.getByTestId("supervisor-cost-cap"));
    pressOption(await screen.findByRole("option", { name: "US$ 0,50" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ costCapUsd: 0.5 }));
  });

  it("goes back and shows the server's words when it refuses", async () => {
    const update = vi.fn(async () => {
      throw new ApiError("invalid_request", "deve ser um valor entre 0,01 e 1000", 400);
    });
    setup(settingsOf(), [], update);
    fireEvent.click(await screen.findByTestId("supervisor-cost-cap"));
    pressOption(await screen.findByRole("option", { name: "US$ 1,00" }));
    expect((await screen.findByTestId("supervisor-error-cap")).textContent).toContain("entre 0,01");
    expect(screen.getByTestId("supervisor-cost-cap").textContent).toBe("Sem teto");
  });

  it("says the model cannot be used, in a faded friendly line (the server's reason stays in the logs)", async () => {
    setup(settingsOf({ model: { available: false, id: "m", reason: "Falta a chave." } }));
    expect((await screen.findByTestId("supervisor-model-unavailable")).textContent).toBe(
      "O modelo do Principal não está disponível agora.",
    );
  });

  it("lists the nights: who was read, what was noted, the cost and the morning message", async () => {
    setup(settingsOf(), [
      reviewOf(),
      reviewOf({
        id: "00000000-0000-4000-8000-000000000002",
        night: "2026-11-20",
        status: "skipped",
        botsRead: [],
        noted: [],
        morningText: null,
        costUsd: null,
      }),
      reviewOf({
        id: "00000000-0000-4000-8000-000000000003",
        night: "2026-11-19",
        status: "failed",
        botsRead: [],
        noted: [],
        morningText: null,
        costUsd: 0,
        error: "timeout: o modelo demorou demais",
      }),
    ]);
    const rows = await screen.findAllByTestId("supervisor-review");
    expect(rows.map((r) => within(r).getByText(/^Noite de/).textContent)).toEqual([
      "Noite de 21/11",
      "Noite de 20/11",
      "Noite de 19/11",
    ]);
    const first = rows[0]?.textContent ?? "";
    expect(first).toContain("Leu Tutor e Finanças · 1 nota · US$ 0,0123");
    expect(first).toContain("Anotou: O Tutor montou o resumo de física.");
    expect(first).toContain("Mensagem da manhã: “O Tutor espera sua resposta sobre o cronograma.”");
    expect(rows[1]?.textContent).toContain("Nada de novo nos outros bots.");
    expect(rows[2]?.textContent).toContain("Não deu certo: timeout: o modelo demorou demais");
  });

  it("an empty history says when the first review happens", async () => {
    setup(settingsOf());
    expect(await screen.findByText("Nenhuma revisão ainda")).toBeTruthy();
  });
});

describe("the words of a review row", () => {
  it("names the cap and who was left for the next night", () => {
    const lines = reviewLines(
      reviewOf({
        capReached: true,
        costCapUsd: 0.25,
        leftOver: [
          { botId: "00000000-0000-4000-8000-0000000000a3", name: "Saúde", reason: "cost_cap" },
        ],
        noted: [],
        morningText: null,
      }),
    );
    expect(lines).toContain("Teto de US$ 0,25 atingido: Saúde ficou para a próxima noite.");
  });
  it("formats money and the night", () => {
    expect(usd(0.25)).toBe("US$ 0,25");
    expect(usd(0.0123, 4)).toBe("US$ 0,0123");
    expect(nightLabel("2026-11-05")).toBe("05/11");
  });
});
