import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useUi } from "../../app/ui-store.js";
import { CATALOG } from "./catalog.js";
import { PluginsDialog } from "./PluginsDialog.js";

afterEach(cleanup);
beforeEach(() => useUi.setState({ pluginsOpen: true }));

describe("the connectors gallery dialog", () => {
  it("is a wide grid, one item per plug-in, with no box around each: the logo in its colours on top, the name and one faded line under it", () => {
    render(<PluginsDialog />);
    const dialog = screen.getByRole("dialog", { name: "Conectores" });
    const items = within(dialog).getAllByTestId("plugin-item");
    expect(items).toHaveLength(CATALOG.length);
    expect(within(dialog).getByTestId("plugins-grid").className).toContain("grid-cols-2");
    expect(within(dialog).getByTestId("plugins-grid").className).toContain("narrow:grid-cols-1");
    const github = items[0] as HTMLElement;
    expect(github.textContent).toContain("GitHub");
    expect(github.textContent).toContain("Repositórios, issues e pull requests");
    // the service's own logo (an SVG of thesvg) on a square in the project's grey, white ones inverted in the light theme
    const logo = github.querySelector("img[data-logo='github']");
    expect(logo).not.toBeNull();
    expect(logo?.getAttribute("alt")).toBe("");
    expect(logo?.className).toContain("light:invert");
    expect(logo?.parentElement?.className).toContain("bg-raised");
    expect(logo?.parentElement?.className).not.toContain("bg-brand-tile");
    // Composio and Higgsfield are not in Simple Icons: the generic plug
    const composio = items.find((i) => i.getAttribute("data-plugin") === "composio");
    expect(composio?.querySelector("img[data-logo='composio']")).not.toBeNull();
    // Higgsfield is not in thesvg: the generic plug
    const higgsfield = items.find((i) => i.getAttribute("data-plugin") === "higgsfield");
    expect(higgsfield?.querySelector("img")).toBeNull();
    expect(higgsfield?.querySelector("svg.lucide-plug")).not.toBeNull();
  });

  it('has "Meus conectores" beside the close button: the logos stacked from the right to the left, as an ornament', () => {
    render(<PluginsDialog />);
    const mine = screen.getByTestId("plugins-mine");
    expect(mine.textContent).toContain("Meus conectores");
    expect(mine.getAttribute("aria-hidden")).toBe("true");
    expect(mine.className).toContain("opacity-60");
    const icons = within(mine).getAllByTestId("plugins-mine-icon");
    expect(icons.map((i) => i.getAttribute("data-plugin"))).toEqual([
      "github",
      "figma",
      "gmail",
      "google-drive",
    ]);
    // the logos on the same grey squares, overlapping
    expect(mine.querySelectorAll(".bg-raised")).toHaveLength(4);
    expect(mine.querySelectorAll("img")).toHaveLength(4);
    // the first at the right, each next one to its left and over it
    expect(icons[0]?.parentElement?.className).toContain("flex-row-reverse");
    expect(icons[1]?.className).toContain("-mr-1.5");
    // beside the close button, in the title row
    const close = screen.getAllByRole("button", { name: "Fechar janela" })[0] as HTMLElement;
    expect(close.parentElement?.contains(mine)).toBe(true);
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
    expect(detail.textContent).toContain("ainda não funciona");
    // the menu, as the Grok Bot's: state, the button to connect (off: ornament), information, tools
    expect(within(detail).getByTestId("plugin-state").textContent).toBe("Não conectado");
    const connect = within(detail).getByTestId("plugin-connect") as HTMLButtonElement;
    expect(connect.textContent).toBe("Conectar Google Drive");
    expect(connect.disabled).toBe(true);
    expect(within(detail).getByRole("heading", { name: "Informações" })).toBeTruthy();
    expect(within(detail).getByTestId("plugin-info").textContent).toContain("CategoriaArquivos");
    expect(within(detail).getByTestId("plugin-info").textContent).toContain(
      "DisponibilidadeEm breve",
    );
    expect(within(detail).getByRole("heading", { name: "Ferramentas" })).toBeTruthy();
    expect(within(detail).getByTestId("plugin-tools").textContent).toContain("depois de conectar");
    fireEvent.click(within(detail).getByRole("button", { name: "Fechar" }));
    expect(screen.queryByRole("dialog", { name: "Google Drive" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Conectores" })).toBeTruthy();
  });

  it("Fechar closes it in the store", () => {
    render(<PluginsDialog />);
    fireEvent.click(screen.getAllByRole("button", { name: "Fechar" })[0] as HTMLElement);
    expect(useUi.getState().pluginsOpen).toBe(false);
  });
});
