import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { setBots } from "../../data/reducers.js";
import { createDataStore, update } from "../../data/store.js";
import { makeBot } from "../../test-fixtures.js";
import { TipProvider } from "../../ui/tooltip.js";
import { NoBots } from "../new-bot/NoBots.js";
import { Sidebar } from "./Sidebar.js";

afterEach(cleanup);
beforeEach(() => useUi.setState({ newBotOpen: false, sidebarWidth: 316 }));

function setup(bots: ReturnType<typeof makeBot>[] | null) {
  const data = createDataStore();
  if (bots !== null) update(data, (s) => setBots(s, bots));
  const services = {
    data,
    api: {},
    sync: {},
    mode: "local",
    disconnect: vi.fn(),
  } as unknown as Services;
  render(
    <TipProvider>
      <ServicesProvider services={services}>
        <Sidebar />
      </ServicesProvider>
    </TipProvider>,
  );
  return { data };
}

describe("the sidebar with no bot (everyone was archived)", () => {
  it("says so in a friendly line and offers to make one", () => {
    const openNewBot = vi.fn();
    useUi.setState({ openNewBot });
    setup([]);
    const empty = screen.getByTestId("sidebar-empty");
    expect(empty.textContent).toContain("Nenhum bot por aqui ainda");
    fireEvent.click(screen.getByRole("button", { name: "Criar bot" }));
    expect(openNewBot).toHaveBeenCalled();
  });

  it("says nothing before the list is read, and nothing once there is a bot", () => {
    const { data } = setup(null);
    expect(screen.queryByTestId("sidebar-empty")).toBeNull();
    act(() => update(data, (s) => setBots(s, [makeBot({ name: "Ajudante" })])));
    expect(screen.queryByTestId("sidebar-empty")).toBeNull();
    expect(screen.getByText("Ajudante")).toBeTruthy();
  });

  it("the main area of the app invites to make the first bot", () => {
    const openNewBot = vi.fn();
    useUi.setState({ openNewBot });
    render(<NoBots />);
    expect(screen.getByRole("heading", { name: "Nenhum bot por aqui ainda" })).toBeTruthy();
    fireEvent.click(screen.getByTestId("no-bots-create"));
    expect(openNewBot).toHaveBeenCalled();
  });
});
