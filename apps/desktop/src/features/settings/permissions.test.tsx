import { ApiError, type ApprovalSettings, type SuupClient, type WrittenRule } from "@suup/api";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { setBots, setRules, setWrittenRules } from "../../data/reducers.js";
import { createDataStore, update } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { makeBot, makeRule, makeWrittenRule, pressOption } from "../../test-fixtures.js";
import { Modal } from "../../ui/dialog.js";
import { PermissionsSettings } from "./PermissionsSettings.js";

const settingsOf = (over: Partial<ApprovalSettings> = {}): ApprovalSettings => ({
  mode: "auto_review",
  staleAfterMinutes: 60,
  reviewer: { available: true, model: "model-x", reason: null },
  ...over,
});

function setup(api: Record<string, unknown>, written: WrittenRule[] = []) {
  const store = createDataStore();
  const bots = [makeBot({ name: "Nova", isDefault: true }), makeBot({ name: "Cookie" })];
  update(store, (s) => setWrittenRules(setBots(s, bots), written));
  const full = {
    rules: { list: async () => [] },
    writtenRules: { list: async () => written },
    connectors: { list: async () => [] },
    ...api,
  };
  const sync = new Sync({ api: full as unknown as SuupClient, store });
  const services = { api: full, sync, data: store } as unknown as Services;
  render(
    <ServicesProvider services={services}>
      {/* as in the app: a section lives inside the settings dialog (its X closes that dialog) */}
      <Modal onClose={() => {}} label="Configurações" className="">
        <PermissionsSettings title="Permissões" titleId="t" />
      </Modal>
    </ServicesProvider>,
  );
  return { store, bots };
}

const modeButton = () => screen.getByTestId("approval-mode");
const pick = async (name: string) => {
  fireEvent.click(modeButton());
  pressOption(await screen.findByRole("option", { name: new RegExp(name) }));
};

describe("Permissões: the mode", () => {
  it("shows the server's mode and says what each choice means; changing it is on screen at once and sent", async () => {
    const update = vi.fn(async (body: { mode: "auto_review" | "ask_all" }) => settingsOf(body));
    setup({ approvalSettings: { get: async () => settingsOf(), update } });
    await waitFor(() => expect(modeButton().textContent).toBe("Auto-review"));
    expect(screen.getByTestId("approval-mode-description").textContent).toContain(
      "só pergunta quando precisa",
    );
    expect(screen.queryByTestId("reviewer-unavailable")).toBeNull();
    fireEvent.click(modeButton());
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Auto-review"),
      expect.stringContaining("Perguntar tudo"),
    ]);
    expect(options[1]?.textContent).toContain(
      "toda ação que não é só leitura pede aprovação".replace("toda", "Toda"),
    );
    pressOption(options[1] as HTMLElement);
    expect(modeButton().textContent).toBe("Perguntar tudo");
    await waitFor(() => expect(update).toHaveBeenCalledWith({ mode: "ask_all" }));
    // In this mode the written rules are not read, and the page says so.
    await waitFor(() =>
      expect(screen.getByTestId("rules-allow").textContent).toContain("não são lidas"),
    );
  });

  it("goes back to the old mode, with a friendly sentence (never the server's raw text), when it fails", async () => {
    const update = vi.fn(async () => {
      throw new ApiError("internal_error", "O servidor não conseguiu gravar.", 500);
    });
    setup({ approvalSettings: { get: async () => settingsOf(), update } });
    await waitFor(() => expect(modeButton().textContent).toBe("Auto-review"));
    await pick("Perguntar tudo");
    await waitFor(() =>
      expect(screen.getByRole("note").textContent).toContain("Algo deu errado. Tenta de novo?"),
    );
    expect(screen.getByRole("note").textContent).not.toContain("não conseguiu gravar");
    expect(modeButton().textContent).toBe("Auto-review");
  });

  it("says the truth when there is no reviewer: one faded friendly line (the server's reason stays in the logs)", async () => {
    setup({
      approvalSettings: {
        get: async () =>
          settingsOf({
            reviewer: {
              available: false,
              model: null,
              reason: "Nenhum modelo de revisão configurado.",
            },
          }),
        update: async () => settingsOf(),
      },
    });
    const note = await screen.findByTestId("reviewer-unavailable");
    expect(note.textContent).toContain("O revisor não está disponível agora.");
    expect(note.textContent).not.toContain("Nenhum modelo de revisão configurado.");
    expect(screen.getByTestId("rules-allow").textContent).toContain("não são lidas");
  });
});

describe("Permissões: the card that waited too long", () => {
  const staleButton = () => screen.getByTestId("approval-stale");

  it("shows the server's limit in a Dropdown with the owner's five choices; the current one is added when it is another", async () => {
    setup({
      approvalSettings: {
        get: async () => settingsOf({ staleAfterMinutes: 90 }),
        update: async () => settingsOf(),
      },
    });
    await waitFor(() => expect(staleButton().textContent).toBe("90 min"));
    expect(staleButton().getAttribute("aria-haspopup")).toBe("listbox");
    fireEvent.click(staleButton());
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "15 min",
      "1 h",
      "90 min",
      "6 h",
      "1 dia",
      "1 semana",
    ]);
  });

  it("changes at once and sends only the limit", async () => {
    const update = vi.fn(async (body: { staleAfterMinutes?: number }) =>
      settingsOf({ staleAfterMinutes: body.staleAfterMinutes ?? 60 }),
    );
    setup({ approvalSettings: { get: async () => settingsOf(), update } });
    await waitFor(() => expect(staleButton().textContent).toBe("1 h"));
    fireEvent.click(staleButton());
    pressOption(await screen.findByRole("option", { name: "1 dia" }));
    expect(staleButton().textContent).toBe("1 dia");
    await waitFor(() => expect(update).toHaveBeenCalledWith({ staleAfterMinutes: 1440 }));
  });

  it("goes back, with the server's words, when it refuses", async () => {
    const update = vi.fn(async () => {
      throw new ApiError("invalid_request", "O limite deve ficar entre 5 minutos e 1 semana.", 400);
    });
    setup({ approvalSettings: { get: async () => settingsOf(), update } });
    await waitFor(() => expect(staleButton().textContent).toBe("1 h"));
    fireEvent.click(staleButton());
    pressOption(await screen.findByRole("option", { name: "15 min" }));
    await waitFor(() => expect(screen.getByRole("note").textContent).toContain("entre 5 minutos"));
    expect(staleButton().textContent).toBe("1 h");
  });
});

describe("Permissões: the rules you write", () => {
  const api = {
    approvalSettings: { get: async () => settingsOf(), update: async () => settingsOf() },
  };

  it("three groups in the owner's order, each with its rules as rows: sentence, whom it is for, switch, Editar, Remover", async () => {
    const [nova] = [makeBot({ name: "Nova" })];
    const rules = [
      makeWrittenRule({ kind: "allow", text: "E-mails para minha equipe em acme.com" }),
      makeWrittenRule({ kind: "never", text: "Apagar a pasta notas", botId: nova.id }),
      makeWrittenRule({ kind: "ask", text: "Qualquer coisa que gaste dinheiro", enabled: false }),
    ];
    const { bots } = setup(api, rules);
    // The rule bound to a bot shows that bot's name; one for every bot says so.
    await screen.findByText("Apagar a pasta notas");
    const groups = ["never", "ask", "allow"].map((k) => screen.getByTestId(`rules-${k}`));
    expect(groups.map((g) => g.querySelector("h3")?.textContent)).toEqual([
      "Nunca permitir",
      "Sempre perguntar",
      "Permitir sem perguntar",
    ]);
    const all = screen.getAllByTestId("written-rule");
    expect(all.map((r) => r.getAttribute("data-kind"))).toEqual(["never", "ask", "allow"]);
    const ask = all[1] as HTMLElement;
    expect(within(ask).getByTestId("written-rule-for").textContent).toBe(
      "Todos os bots · desligada",
    );
    expect(within(ask).getByTestId("written-rule-toggle").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(within(all[0] as HTMLElement).getByTestId("written-rule-edit").textContent).toBe(
      "Editar",
    );
    expect(within(all[0] as HTMLElement).getByTestId("written-rule-delete").textContent).toBe(
      "Remover",
    );
    expect(bots.length).toBe(2);
  });

  it("'Adicionar regra' asks for a sentence: disabled while empty, sent trimmed with the chosen bot, server errors shown as they come", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new ApiError("conflict", "Você já tem 100 regras escritas.", 409))
      .mockImplementation(
        async (body: { kind: WrittenRule["kind"]; text: string; botId: string | null }) =>
          makeWrittenRule({ ...body }),
      );
    const { bots } = setup({ ...api, writtenRules: { list: async () => [], create } });
    fireEvent.click(await screen.findByTestId("rule-new-never"));
    const dialog = await screen.findByTestId("written-rule-form");
    expect(dialog.getAttribute("data-kind")).toBe("never");
    const save = screen.getByTestId("written-rule-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.textContent).toBe("Adicionar regra");
    const text = screen.getByTestId("written-rule-text") as HTMLTextAreaElement;
    expect(text.placeholder).toBe("Apagar a pasta notas");
    expect(screen.getByText("Diga qual é a ação e quem ou o que ela afeta.")).toBeTruthy();
    expect(screen.queryByTestId("written-rule-counter")).toBeNull();
    // "Para qual bot" is the one other control, and starts on every bot.
    expect(screen.getByTestId("written-rule-bot").textContent).toBe("Todos os bots");
    expect(screen.getByLabelText("Aplica-se a")).toBe(text);
    fireEvent.change(text, { target: { value: "  Apagar a pasta notas \n" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(screen.getByTestId("written-rule-bot"));
    pressOption(await screen.findByRole("option", { name: "Cookie" }));
    fireEvent.click(save);
    // The server's own words, and nothing was closed.
    expect((await screen.findByTestId("written-rule-error")).textContent).toBe(
      "Você já tem 100 regras escritas.",
    );
    expect(create).toHaveBeenLastCalledWith({
      kind: "never",
      text: "Apagar a pasta notas",
      botId: bots[1]?.id,
    });
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByTestId("written-rule-form")).toBeNull());
    expect(create).toHaveBeenCalledTimes(2);
    // The new rule is a row at once.
    expect(screen.getByTestId("rules-never").textContent).toContain("Apagar a pasta notas");
  });

  it("the counter shows only near the limit", async () => {
    setup(api);
    fireEvent.click(await screen.findByTestId("rule-new-ask"));
    const text = (await screen.findByTestId("written-rule-text")) as HTMLTextAreaElement;
    expect(text.placeholder).toBe("Qualquer coisa que gaste dinheiro");
    fireEvent.change(text, { target: { value: "a".repeat(430) } });
    expect(screen.getByTestId("written-rule-counter").textContent).toBe("430/500");
  });

  it("edit changes only the text; the switch and Remover talk to the server", async () => {
    const rule = makeWrittenRule({ kind: "allow", text: "Antes" });
    const patch = vi.fn(async (id: string, body: Partial<WrittenRule>) => ({
      ...rule,
      ...body,
      id,
    }));
    const remove = vi.fn(async () => undefined);
    setup({ ...api, writtenRules: { list: async () => [rule], update: patch, remove } }, [rule]);
    const row = await screen.findByTestId("written-rule");
    fireEvent.click(within(row).getByTestId("written-rule-toggle"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(rule.id, { enabled: false }));
    fireEvent.click(within(row).getByTestId("written-rule-edit"));
    const text = (await screen.findByTestId("written-rule-text")) as HTMLTextAreaElement;
    expect(text.value).toBe("Antes");
    // A rule's bot cannot be changed (the server takes no such field): the menu is off.
    expect((screen.getByTestId("written-rule-bot") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(text, { target: { value: "Depois" } });
    fireEvent.click(screen.getByTestId("written-rule-save"));
    await waitFor(() => expect(patch).toHaveBeenCalledWith(rule.id, { text: "Depois" }));
    await waitFor(() => expect(screen.queryByTestId("written-rule-form")).toBeNull());
    expect(screen.getByTestId("written-rule-sentence").textContent).toBe("Depois");
    fireEvent.click(screen.getByTestId("written-rule-delete"));
    fireEvent.click(await screen.findByTestId("written-rule-delete-confirm"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(rule.id));
    await waitFor(() => expect(screen.queryByTestId("written-rule")).toBeNull());
  });
});

describe("Permissões: the old exact rules", () => {
  const api = {
    approvalSettings: { get: async () => settingsOf(), update: async () => settingsOf() },
  };

  it("no row at all when there are none", async () => {
    setup(api);
    await screen.findByTestId("rules-never");
    expect(screen.queryByTestId("rules-exact")).toBeNull();
  });

  it("one quiet row at the end with the count; it opens the old list to read and remove", async () => {
    const exact = makeRule({
      tool: "write_file",
      effect: "deny",
      matchers: [{ field: "path", value: "a.txt" }],
    });
    const remove = vi.fn(async () => undefined);
    const { store } = setup({ ...api, rules: { list: async () => [exact], remove } });
    act(() => update(store, (s) => setRules(s, [exact])));
    const row = await screen.findByTestId("rules-exact");
    expect(row.textContent).toContain("Regras exatas (avançado)");
    expect(row.textContent).toContain("1 regra");
    fireEvent.click(screen.getByTestId("rules-exact-open"));
    const list = await screen.findByTestId("rules-exact-list");
    expect(within(list).getByTestId("rule-sentence").textContent).toContain("“a.txt”");
    // Read and remove only: no way to add or edit one.
    expect(screen.queryByTestId("rule-new-deny")).toBeNull();
    expect(within(list).queryByTestId("rule-edit")).toBeNull();
    fireEvent.click(within(list).getByTestId("rule-delete"));
    fireEvent.click(await screen.findByTestId("rule-delete-confirm"));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(exact.id));
  });
});

describe("the settings dialog's way back", () => {
  it("selecting a section, even the selected one, lands on its first view; closing forgets the connector", () => {
    const ui = useUi.getState();
    ui.openSettings("connectors");
    ui.setSettingsConnector("fake");
    expect(useUi.getState().settingsConnector).toBe("fake");
    useUi.getState().setSettingsTab("connectors");
    expect(useUi.getState().settingsConnector).toBeNull();
    useUi.getState().setSettingsConnector("fake");
    useUi.getState().closeSettings();
    expect(useUi.getState().settingsConnector).toBeNull();
    useUi.getState().openSettings("connectors");
    expect(useUi.getState().settingsConnector).toBeNull();
    useUi.getState().closeSettings();
  });
});
