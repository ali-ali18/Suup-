import type { MemoryRevision, SuupClient } from "@suup/api";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { setMemories } from "../../data/reducers.js";
import { createDataStore, update } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { at, makeMemory } from "../../test-fixtures.js";
import { MemoryScreen } from "./MemoryScreen.js";

afterEach(cleanup);

function setup(api: Record<string, unknown>, items = [makeMemory()]) {
  const store = createDataStore();
  update(store, (s) => setMemories(s, items));
  const full = { memories: { list: async () => items, pending: async () => [], ...api } };
  const sync = new Sync({ api: full as unknown as SuupClient, store });
  const services = { api: full, sync, data: store } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <MemoryScreen />
    </ServicesProvider>,
  );
}

const state = (text: string) => ({
  text,
  summary: null,
  status: "active" as const,
  layer: "rule" as const,
  scope: "shared" as const,
  botId: null,
  archived: false,
});
const revision = (over: Partial<MemoryRevision>): MemoryRevision => ({
  id: crypto.randomUUID(),
  memoryId: "m",
  kind: "edited",
  actor: "user",
  prev: state("antes"),
  next: state("agora"),
  originRunId: null,
  originConversationId: null,
  originMessageId: null,
  originConsolidationId: null,
  createdAt: at(0),
  ...over,
});

describe("Memória: summary, pending group and history", () => {
  it("shows a note's summary faded under its text", async () => {
    const note = makeMemory({
      layer: "note",
      scope: "bot",
      botId: "b",
      text: "Texto longo",
      summary: "Fato curto",
    });
    setup({}, [note]);
    fireEvent.click(await screen.findByRole("tab", { name: /Notas/ }));
    expect((await screen.findByTestId("memory-summary")).textContent).toBe("Fato curto");
  });

  it("a pending memory is in its own group with Descartar and Guardar, and is not counted among the active ones", async () => {
    const pending = makeMemory({ status: "pending", text: "Sempre em haicai." });
    const confirm = vi.fn(async () => ({
      ...pending,
      status: "active" as const,
      updatedAt: at(1000),
    }));
    setup({ pending: async () => [pending], confirm }, [makeMemory()]);
    const group = await screen.findByTestId("memory-pending");
    expect(within(group).getByText("Sempre em haicai.")).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Regras \(1\)/ })).toBeTruthy();
    fireEvent.click(within(group).getByTestId("memory-confirm"));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(pending.id));
    await waitFor(() => expect(screen.queryByTestId("memory-pending")).toBeNull());
  });

  it("the history lists who changed what, newest first, with Desfazer only on the latest", async () => {
    const memory = makeMemory({ text: "agora" });
    const newest = revision({ actor: "consolidation", kind: "edited" });
    const oldest = revision({ actor: "bot", kind: "created", prev: null });
    const undo = vi.fn(async () => memory);
    const history = vi.fn(async () => [newest, oldest]);
    setup({ history, undo }, [memory]);
    fireEvent.click(await screen.findByLabelText("Histórico da memória"));
    const rows = await screen.findAllByTestId("memory-revision");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("Consolidação");
    expect(rows[0]?.textContent).toContain("Antes: antes");
    expect(rows[1]?.textContent).toContain("O bot");
    expect(screen.getAllByTestId("memory-undo")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("memory-undo"));
    await waitFor(() => expect(undo).toHaveBeenCalledWith(memory.id, newest.id));
  });
});
