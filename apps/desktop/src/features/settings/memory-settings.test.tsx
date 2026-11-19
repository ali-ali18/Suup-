import { ApiError, type MemorySettings, type SuupClient } from "@suup/api";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { createDataStore } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { MemorySettings as Section } from "./MemorySettings.js";

afterEach(cleanup);

const settingsOf = (over: Partial<MemorySettings> = {}): MemorySettings => ({
  consolidation: { enabled: true, idleMinutes: 5, maxTurns: 15 },
  promptLimitChars: 6000,
  expiryDays: 90,
  compactionThreshold: 0.8,
  reviewer: { available: true, model: "m", reason: null },
  promptUsage: { limitChars: 6000, sharedChars: 1200, overLimit: [] },
  ...over,
});

function setup(initial: MemorySettings, update = vi.fn()) {
  const api = { memorySettings: { get: async () => initial, update } };
  const store = createDataStore();
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  const services = { api, sync, data: store } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <Section title="Memória" titleId="t" onClose={() => {}} />
    </ServicesProvider>,
  );
  return update;
}
const field = (id: string) => screen.findByTestId(id) as Promise<HTMLInputElement>;

describe("Configurações > Memória", () => {
  it("shows the server's values in Geral's groups, the usage line and the faded reviewer line", async () => {
    setup(
      settingsOf({
        reviewer: { available: false, model: null, reason: "Sem modelo configurado." },
      }),
    );
    expect((await field("memory-max-turns")).value).toBe("15");
    expect((await field("memory-idle-minutes")).value).toBe("5");
    expect((await field("memory-compaction")).value).toBe("80");
    expect((await field("memory-prompt-limit")).value).toBe("6000");
    expect(screen.getByTestId("memory-usage").textContent).toContain("de");
    expect(screen.getByTestId("memory-reviewer-unavailable").textContent).toBe(
      "Sem modelo configurado.",
    );
    expect(screen.getByTestId("memory-expiry-days").textContent).toBe("90 dias");
    expect(screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Consolidação",
      "Contexto",
      "Validade",
    ]);
  });

  it("sends only the key that changed, the percentage as a fraction, 'Nunca' as null", async () => {
    const update = vi.fn(async () => settingsOf());
    setup(settingsOf(), update);
    const turns = await field("memory-max-turns");
    fireEvent.change(turns, { target: { value: "20" } });
    fireEvent.blur(turns);
    await waitFor(() => expect(update).toHaveBeenCalledWith({ consolidation: { maxTurns: 20 } }));
    const pct = await field("memory-compaction");
    fireEvent.change(pct, { target: { value: "70" } });
    fireEvent.keyDown(pct, { key: "Enter" });
    await waitFor(() => expect(update).toHaveBeenCalledWith({ compactionThreshold: 0.7 }));
    fireEvent.click(screen.getByTestId("memory-enabled"));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ consolidation: { enabled: false } }));
    fireEvent.click(screen.getByTestId("memory-expiry-days"));
    fireEvent.click(await screen.findByRole("option", { name: "Nunca" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ expiryDays: null }));
  });

  it("offers 30/60/90/180/365 and Nunca, plus the current value when it is another", async () => {
    setup(settingsOf({ expiryDays: 45 }));
    fireEvent.click(await screen.findByTestId("memory-expiry-days"));
    expect((await screen.findAllByRole("option")).map((o) => o.textContent)).toEqual([
      "30 dias",
      "60 dias",
      "90 dias",
      "180 dias",
      "365 dias",
      "45 dias",
      "Nunca",
    ]);
  });

  it("goes back to the old value and shows the server's words under the row when it refuses", async () => {
    const update = vi.fn(async () => {
      throw new ApiError(
        "invalid_request",
        "consolidation.maxTurns: deve ser um número inteiro entre 3 e 100",
        400,
      );
    });
    setup(settingsOf(), update);
    const turns = await field("memory-max-turns");
    fireEvent.change(turns, { target: { value: "500" } });
    fireEvent.blur(turns);
    await waitFor(() =>
      expect(screen.getByTestId("memory-error-maxTurns").textContent).toContain("entre 3 e 100"),
    );
    expect(turns.value).toBe("15");
  });

  it("a bot over the limit gets a warning row, and 'Ver memórias' opens the memory screen on that bot", async () => {
    setup(
      settingsOf({
        promptUsage: {
          limitChars: 6000,
          sharedChars: 1200,
          overLimit: [
            { botId: "00000000-0000-4000-8000-000000000001", name: "Nova", usedChars: 7200 },
          ],
        },
      }),
    );
    const row = await screen.findByTestId("memory-over-limit");
    expect(row.textContent).toContain("Nova");
    fireEvent.click(screen.getByTestId("memory-over-limit-open"));
    expect(useUi.getState().view).toBe("memory");
    expect(useUi.getState().memoryBot).toBe("00000000-0000-4000-8000-000000000001");
    expect(useUi.getState().settingsOpen).toBe(false);
  });
});
