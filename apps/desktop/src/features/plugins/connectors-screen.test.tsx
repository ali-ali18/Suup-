import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { ConnectorsScreen } from "./ConnectorsScreen.js";
import { CATALOG, CATEGORIES } from "./catalog.js";

afterEach(cleanup);
beforeEach(() => useUi.setState({ view: "connectors", settingsOpen: false }));

function setup() {
  const openUrl = vi.fn();
  const services = { platform: { openUrl } } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      <ConnectorsScreen />
    </ServicesProvider>,
  );
  return { openUrl };
}

const itemOf = (id: string) =>
  screen
    .getAllByTestId("connector-item")
    .find((i) => i.getAttribute("data-plugin") === id) as HTMLElement;

describe("the connectors screen", () => {
  it("has the title, its line, search, and the services by section with their counts", () => {
    setup();
    const screenEl = screen.getByTestId("connectors-screen");
    expect(within(screenEl).getByRole("heading", { name: "Conectores", level: 1 })).toBeTruthy();
    expect(screenEl.textContent).toContain(
      "Conecte as ferramentas e os serviços com que seus bots trabalham.",
    );
    expect(within(screenEl).getByRole("searchbox", { name: "Buscar conectores" })).toBeTruthy();
    const sections = within(screenEl).getAllByTestId("connectors-section");
    expect(sections.map((s) => s.getAttribute("data-category"))).toEqual([...CATEGORIES]);
    for (const section of sections) {
      const category = section.getAttribute("data-category");
      const count = CATALOG.filter((e) => e.category === category).length;
      expect(within(section).getAllByTestId("connector-item")).toHaveLength(count);
      expect(within(section).getByRole("heading").textContent).toBe(`${category}${count}`);
    }
    expect(within(screenEl).getAllByTestId("connector-item")).toHaveLength(CATALOG.length);
  });

  it("each line: the logo at the left, the name with one faded line under it, and + Conectar (off)", () => {
    setup();
    const github = itemOf("github");
    const logo = github.querySelector("img[data-logo='github']");
    expect(logo?.getAttribute("alt")).toBe("");
    // the logo on the background of its tone (GitHub: ink), nothing inverted
    expect(logo?.className).not.toContain("invert");
    expect(logo?.parentElement?.className).toContain("bg-tile-ink");
    expect(github.textContent).toContain("GitHub");
    expect(github.textContent).toContain("Repositórios, issues e pull requests");
    const connect = within(github).getByRole("button", { name: "Conectar GitHub" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    expect(connect.getAttribute("title")).toBe("Em breve");
    // Higgsfield is not in thesvg: the generic plug
    const higgsfield = itemOf("higgsfield");
    expect(higgsfield.querySelector("img")).toBeNull();
    expect(higgsfield.querySelector("svg.lucide-plug")).not.toBeNull();
  });

  it("search filters by name, line and section, and says so when nothing matches", () => {
    setup();
    const field = screen.getByRole("searchbox", { name: "Buscar conectores" });
    fireEvent.change(field, { target: { value: "gOOgle" } });
    const names = screen.getAllByTestId("connector-item").map((i) => i.getAttribute("data-plugin"));
    expect(names.sort()).toEqual(
      ["google-calendar", "google-docs", "google-drive", "google-sheets"].sort(),
    );
    // a section with no match disappears
    const categories = screen
      .getAllByTestId("connectors-section")
      .map((s) => s.getAttribute("data-category"));
    expect(categories).toEqual(["Produtividade", "Documentos"]);
    fireEvent.change(field, { target: { value: "xyz-nada" } });
    expect(screen.queryAllByTestId("connector-item")).toHaveLength(0);
    expect(screen.getByText("Nenhum conector encontrado")).toBeTruthy();
    fireEvent.change(field, { target: { value: "" } });
    expect(screen.getAllByTestId("connector-item")).toHaveLength(CATALOG.length);
  });

  it('"Meus conectores" is an ornament: faded, out of the reading order, logos stacked right to left', () => {
    setup();
    const mine = screen.getByTestId("connectors-mine");
    expect(mine.textContent).toContain("Meus conectores");
    expect(mine.getAttribute("aria-hidden")).toBe("true");
    expect(mine.className).toContain("opacity-60");
    const icons = within(mine).getAllByTestId("connectors-mine-icon");
    expect(icons.map((i) => i.getAttribute("data-plugin"))).toEqual([
      "github",
      "figma",
      "gmail",
      "google-drive",
    ]);
    expect(icons[0]?.parentElement?.className).toContain("flex-row-reverse");
    expect(icons[1]?.className).toContain("-mr-1.5");
    // each logo keeps the background of its own tone
    const tiles = [...mine.querySelectorAll("span[class*='bg-tile-']")].map((t) =>
      [...t.classList].find((c) => c.startsWith("bg-tile-")),
    );
    expect(tiles).toEqual(["bg-tile-ink", "bg-tile-ink", "bg-tile-paper", "bg-tile-sky"]);
  });

  it('"Adicionar personalizado" is real: it opens Configurações > Conectores', () => {
    setup();
    fireEvent.click(screen.getByTestId("connectors-add-custom"));
    expect(useUi.getState()).toMatchObject({ settingsOpen: true, settingsTab: "connectors" });
  });
});

describe("the page of a connector, in the same screen", () => {
  const open = (id: string) => {
    const { openUrl } = setup();
    fireEvent.click(itemOf(id).querySelector("button") as HTMLElement);
    return { openUrl, page: screen.getByTestId("connector-page") };
  };

  it("replaces the list: the way back, the head with the state, the examples, Conexão and Informações", () => {
    const { page } = open("google-docs");
    expect(screen.queryByTestId("connectors-screen")).toBeNull();
    // the way back: Conectores > Google Docs
    const nav = within(page).getByRole("navigation", { name: "Caminho" });
    expect(nav.textContent).toContain("Conectores");
    expect(within(nav).getByText("Google Docs").getAttribute("aria-current")).toBe("page");
    // the head
    expect(within(page).getByRole("heading", { name: "Google Docs", level: 1 })).toBeTruthy();
    expect(within(page).getByTestId("connector-state").textContent).toContain("Não conectado");
    const connect = within(page).getByRole("button", { name: "Conectar Google Docs" });
    expect((connect as HTMLButtonElement).disabled).toBe(true);
    // the band with the examples: a gradient of the family of the service (Google Docs: sky)
    const examples = within(page).getByTestId("connector-examples");
    expect(examples.className).toContain("bg-linear-to-br");
    expect(examples.className).toContain("from-banner-sky-from");
    expect(examples.textContent).toContain("Resuma o documento de requisitos.");
    expect(within(examples).getAllByText("Google Docs")).toHaveLength(3);
    // the blocks
    expect(within(page).getByRole("heading", { name: "Conexão" })).toBeTruthy();
    expect(within(page).getByRole("heading", { name: "Informações" })).toBeTruthy();
    const info = within(page).getByTestId("connector-info").textContent ?? "";
    expect(info).toContain("DesenvolvedorGoogle");
    expect(info).toContain("CategoriaDocumentos");
    expect(info).toContain("DisponibilidadeEm breve");
    expect(info).toContain("Sitedocs.google.com");
    expect(page.textContent).toContain("ainda não funciona");
  });

  it("the site opens in the browser, and Abrir Configurações leads to the real connectors", () => {
    const { openUrl, page } = open("github");
    fireEvent.click(within(page).getByTestId("connector-site"));
    expect(openUrl).toHaveBeenCalledWith("https://github.com");
    fireEvent.click(within(page).getByTestId("connector-open-settings"));
    expect(useUi.getState()).toMatchObject({ settingsOpen: true, settingsTab: "connectors" });
  });

  it("the breadcrumb and Esc return to the list", () => {
    const { page } = open("notion");
    fireEvent.click(within(page).getByTestId("connector-back"));
    expect(screen.getByTestId("connectors-screen")).toBeTruthy();
    fireEvent.click(itemOf("notion").querySelector("button") as HTMLElement);
    expect(screen.getByTestId("connector-page")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("connectors-screen")).toBeTruthy();
  });
});
