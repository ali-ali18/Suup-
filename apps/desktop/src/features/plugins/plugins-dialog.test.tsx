import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useUi } from "../../app/ui-store.js";
import { CATALOG } from "./catalog.js";
import { PluginsDialog } from "./PluginsDialog.js";

afterEach(cleanup);
beforeEach(() => useUi.setState({ pluginsOpen: true }));

describe("the plug-ins dialog", () => {
  it("is a wide grid, one item per plug-in, with no box around each: the logo in its colours on top, the name and one faded line under it", () => {
    render(<PluginsDialog />);
    const dialog = screen.getByRole("dialog", { name: "Plug-ins" });
    const items = within(dialog).getAllByTestId("plugin-item");
    expect(items).toHaveLength(CATALOG.length);
    expect(within(dialog).getByTestId("plugins-grid").className).toContain("grid-cols-2");
    expect(within(dialog).getByTestId("plugins-grid").className).toContain("narrow:grid-cols-1");
    const github = items[0] as HTMLElement;
    expect(github.textContent).toContain("GitHub");
    expect(github.textContent).toContain("Repositórios, issues e pull requests");
    const mark = github.querySelector("svg[data-brand='github']");
    expect(mark).not.toBeNull();
    // in the service's own colour (the hex of Simple Icons), on the light square
    expect(mark?.getAttribute("fill")).toBe("#181717");
    expect(mark?.parentElement?.className).toContain("bg-brand-tile");
    // Composio and Higgsfield are not in Simple Icons: the generic plug
    const composio = items.find((i) => i.getAttribute("data-plugin") === "composio");
    expect(composio?.querySelector("svg[data-brand]")).toBeNull();
    expect(composio?.querySelector("svg.lucide-plug")).not.toBeNull();
  });

  it("says once, above the grid, that they do not work yet", () => {
    render(<PluginsDialog />);
    expect(screen.getByTestId("plugins-soon").textContent).toContain("Em breve");
    expect(screen.getByTestId("plugins-soon").textContent).toContain("Conectores");
  });

  it("choosing one opens ITS dialog over this one; closing goes back to the grid", () => {
    render(<PluginsDialog />);
    fireEvent.click(screen.getAllByTestId("plugin-item")[4] as HTMLElement);
    const detail = screen.getByRole("dialog", { name: "Google Drive" });
    expect(within(detail).getByTestId("plugin-detail").getAttribute("data-plugin")).toBe(
      "google-drive",
    );
    expect(detail.textContent).toContain("ainda não funcionam");
    fireEvent.click(within(detail).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog", { name: "Google Drive" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Plug-ins" })).toBeTruthy();
  });

  it("Fechar closes it in the store", () => {
    render(<PluginsDialog />);
    fireEvent.click(screen.getAllByRole("button", { name: "Fechar" })[0] as HTMLElement);
    expect(useUi.getState().pluginsOpen).toBe(false);
  });
});
