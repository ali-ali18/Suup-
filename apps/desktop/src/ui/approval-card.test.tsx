import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DecideOutcome } from "../data/sync.js";
import { makeApproval, makeMessageApproval, makeRule } from "../test-fixtures.js";
import { ApprovalCard, type ApprovalCardProps } from "./approval-card.js";

const noop = () => {};
const ok = (over = {}): DecideOutcome => ({
  ok: true,
  approval: makeApproval({ status: "approved" }),
  rule: null,
  ...over,
});

function show(over: Partial<ApprovalCardProps> = {}) {
  const onDecide = vi.fn<ApprovalCardProps["onDecide"]>().mockResolvedValue(ok());
  const props: ApprovalCardProps = {
    approval: makeApproval(),
    botName: "Ajudante",
    expanded: false,
    onToggle: noop,
    onDecide,
    ...over,
  };
  const view = render(<ApprovalCard {...props} />);
  return { onDecide, props, view };
}

describe("ApprovalCard waiting for you", () => {
  it("is a calm card: category, bold title in pt-BR, one muted paragraph, the exact content, buttons at the right", () => {
    show({
      approval: makeApproval({
        summary: "Shell in repo: git push origin main",
        args: { command: "git push origin main", cwd: "/repo" },
      }),
    });
    const card = screen.getByTestId("approval-card");
    expect(card.getAttribute("data-state")).toBe("needs-action");
    // The header: the category, and the risk as quiet text with an accessible prefix.
    expect(within(card).getByText("Terminal")).toBeTruthy();
    expect(within(card).getByTestId("approval-risk").textContent).toBe(
      "Risco: Externa ou irreversível",
    );
    // The title is ours (the server's summary may be in English); one paragraph says who and why.
    expect(within(card).getByText("Rodar git push origin main")).toBeTruthy();
    expect(within(card).queryByText(/Shell in repo/)).toBeNull();
    expect(within(card).getByTestId("approval-why").textContent).toBe(
      "Ajudante quer rodar um comando. Está perguntando porque o nível desta ação pede sua permissão.",
    );
    const fields = within(card).getAllByTestId("arg-field");
    expect(fields.map((f) => f.getAttribute("data-key"))).toEqual(["command", "cwd"]);
    // Monospace only for what is code-like.
    expect(fields.map((f) => f.getAttribute("data-code"))).toEqual(["true", "false"]);
    expect(within(fields[0] as HTMLElement).getByTestId("arg-value").textContent).toBe(
      "git push origin main",
    );
    // Recusar (plain), Aprovar and the chevron of the split button; no reason field any more.
    const buttons = within(card)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(buttons).toEqual(["Recusar", "Aprovar"]);
    expect(within(card).queryByRole("textbox")).toBeNull();
  });

  it("an unknown tool falls back to the server's summary, with the generic category", () => {
    show({ approval: makeApproval({ tool: "tool_nova", summary: "Faz algo novo" }) });
    expect(screen.getByText("Faz algo novo")).toBeTruthy();
    expect(screen.getByText("Ferramenta")).toBeTruthy();
  });

  it("a secret is only its placeholder, with a seal", () => {
    show({
      approval: makeApproval({
        args: {
          command: "curl -H 'Authorization: Bearer {{secret:GH_TOKEN}}' https://api.github.com",
        },
        secrets: ["GH_TOKEN"],
      }),
    });
    const seals = screen.getAllByTestId("secret-seal");
    expect(seals).toHaveLength(1);
    expect(seals[0]?.textContent).toBe("{{secret:GH_TOKEN}}");
    expect(screen.getByTestId("arg-value").textContent).toContain(
      "Authorization: Bearer {{secret:GH_TOKEN}}' https://api.github.com",
    );
  });

  it("long content is collapsed and opens with a button; the setting can show it whole", () => {
    const content = Array.from({ length: 30 }, (_, i) => `linha ${i + 1}`).join("\n");
    const approval = makeApproval({ tool: "write_file", args: { path: "a.txt", content } });
    const { view } = show({ approval });
    const value = () =>
      screen.getAllByTestId("arg-value").find((v) => v.textContent?.includes("linha 1"))
        ?.textContent ?? "";
    expect(value()).not.toContain("linha 30");
    const more = screen.getByRole("button", { name: /Mostrar tudo \(mais 22 linhas\)/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(value()).toContain("linha 30");
    view.unmount();
    render(
      <ApprovalCard
        approval={approval}
        botName="x"
        expanded={false}
        onToggle={noop}
        collapseLong={false}
        onDecide={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /Mostrar tudo/ })).toBeNull();
    expect(
      screen.getAllByTestId("arg-value").some((v) => v.textContent?.includes("linha 30")),
    ).toBe(true);
  });

  it("a connector tool shows the connector and the tool apart, and says the content leaves the computer", () => {
    show({
      approval: makeApproval({
        tool: "conn_fake__write_thing",
        summary: "Conector fake → write_thing",
        args: { name: "x", body: "y" },
      }),
      connectors: [
        { name: "fake", tools: [{ name: "conn_fake__write_thing", tool: "write_thing" }] },
      ],
    });
    expect(screen.getByTestId("approval-connector").textContent).toBe("Conectorfake");
    expect(screen.getByText("write_thing", { selector: ".ui-args__body" })).toBeTruthy();
    // The category of a connector tool is the connector.
    expect(document.querySelector(".ui-decision__category")?.textContent).toBe("fake");
    expect(screen.getByText(/sai deste computador para um servidor externo/)).toBeTruthy();
  });

  it("Aprovar sends the decision and every button waits, with a pending label, until the server answers", async () => {
    let finish: (outcome: DecideOutcome) => void = noop;
    const onDecide = vi.fn(
      () =>
        new Promise<DecideOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    show({ onDecide });
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ decision: "approve" });
    const card = screen.getByTestId("approval-card");
    expect(card.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("approval-approve").textContent).toContain("Aprovando…");
    for (const button of within(card).getAllByRole("button")) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    // Still a pending card: nothing was assumed.
    expect(card.getAttribute("data-state")).toBe("needs-action");
    await act(async () => finish(ok()));
    expect(screen.getByTestId("approval-approve").textContent).toBe("Aprovar");
  });

  it("Recusar is one click: no reason field, and no reason is sent", () => {
    const { onDecide } = show();
    fireEvent.click(screen.getByTestId("approval-deny"));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ decision: "deny" });
  });

  it("a normal action has ONLY Recusar and Aprovar: no split button, no menu, no 'sempre permitir'", () => {
    for (const approval of [
      makeApproval(),
      makeApproval({ tool: "write_file", args: { path: "a.txt", content: "x" } }),
      makeApproval({ tool: "web_fetch", args: { url: "https://exemplo.com" } }),
      makeApproval({ tool: "remember", args: { layer: "note", text: "x" } }),
      // A connector tool that merely LOOKS like a mail tool: nothing declared it a message.
      makeApproval({ tool: "conn_gmail__send_email", args: { to: "a@b.com" } }),
    ]) {
      const { view } = show({ approval, onManageRules: vi.fn() });
      const card = screen.getByTestId("approval-card");
      expect(
        within(card)
          .getAllByRole("button")
          .map((b) => b.textContent),
      ).toEqual(["Recusar", "Aprovar"]);
      expect(card.querySelector(".ui-split")).toBeNull();
      expect(within(card).queryByTestId("approval-more")).toBeNull();
      expect(card.querySelector('[aria-haspopup="menu"]')).toBeNull();
      expect(card.textContent).not.toMatch(/sempre permitir|Permitir destinat/i);
      view.unmount();
    }
  });

  const openMenu = () => {
    fireEvent.click(screen.getByTestId("approval-more"));
    return screen.getByRole("menu", { name: "Mais opções de envio" });
  };

  it("a message to another person (declared) has Descartar and a split button Enviar", () => {
    show({ approval: makeMessageApproval() });
    const card = screen.getByTestId("approval-card");
    expect(document.querySelector(".ui-decision__category")?.textContent).toBe("Mensagem");
    expect(within(card).getByTestId("approval-deny").textContent).toBe("Descartar");
    expect(within(card).getByTestId("approval-approve").textContent).toBe("Enviar");
    expect(card.querySelector(".ui-split")).not.toBeNull();
    expect(within(card).getByTestId("approval-more")).toBeTruthy();
  });

  it("the chevron opens the recipient menu: Permitir destinatário, Precisa de aprovação (checked), Gerenciar regras", () => {
    const onManageRules = vi.fn();
    show({ approval: makeMessageApproval(), onManageRules });
    const trigger = screen.getByTestId("approval-more");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const menu = openMenu();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    expect(items.map((i) => i.querySelector(".ui-menu__label")?.textContent)).toEqual([
      "Permitir destinatário",
      "Precisa de aprovação",
      "Gerenciar regras",
    ]);
    expect(items[0]?.textContent).toContain("libera este destinatário, neste bot");
    expect(screen.getByTestId("approval-needs").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("approval-manage-rules"));
    expect(onManageRules).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("'Permitir destinatário' sends the approval with allowRecipient (the server pins exactly the recipient)", async () => {
    const { onDecide } = show({ approval: makeMessageApproval() });
    openMenu();
    fireEvent.click(screen.getByTestId("allow-recipient"));
    expect(onDecide).toHaveBeenLastCalledWith({ decision: "approve", allowRecipient: true });
    await waitFor(() =>
      expect((screen.getByTestId("approval-approve") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("turning 'Precisa de aprovação' off makes Enviar also allow the recipient, and says which rule before", () => {
    const { onDecide } = show({ approval: makeMessageApproval() });
    openMenu();
    fireEvent.click(screen.getByTestId("approval-needs"));
    const sentence = screen.getByTestId("allow-recipient-sentence").textContent ?? "";
    expect(sentence).toContain("o bot Ajudante");
    expect(sentence).toContain("to = “ana@exemplo.com”");
    expect(sentence).toContain("Qualquer outro destinatário continua pedindo");
    expect(screen.getByTestId("approval-approve").textContent).toBe("Enviar e permitir");
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(onDecide).toHaveBeenLastCalledWith({ decision: "approve", allowRecipient: true });
  });

  it("without one exact recipient the menu cannot allow a recipient, and Enviar only sends", () => {
    const base = makeMessageApproval();
    const { onDecide } = show({
      approval: makeMessageApproval({
        args: { to: ["a@x.com", "b@x.com"] },
        outbound: { ...(base.outbound as NonNullable<typeof base.outbound>), recipients: null },
      }),
    });
    openMenu();
    expect((screen.getByTestId("allow-recipient") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("approval-needs") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("approval-more"));
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(onDecide).toHaveBeenLastCalledWith({ decision: "approve" });
  });

  it("Descartar is one click and sends no reason", () => {
    const { onDecide } = show({ approval: makeMessageApproval() });
    fireEvent.click(screen.getByTestId("approval-deny"));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ decision: "deny" });
  });

  it("the menu works from the keyboard: arrows move, Escape closes and gives the focus back", () => {
    show({ approval: makeMessageApproval() });
    const trigger = screen.getByTestId("approval-more");
    openMenu();
    const items = Array.from(
      screen.getByRole("menu").querySelectorAll<HTMLElement>('[role^="menuitem"]'),
    );
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(items.at(-1) as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0] as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("a failure keeps the card pending and says why, next to the buttons", async () => {
    const onDecide = vi
      .fn<ApprovalCardProps["onDecide"]>()
      .mockResolvedValue({ ok: false, reason: "error", message: "Servidor fora do ar." });
    show({ onDecide });
    fireEvent.click(screen.getByTestId("approval-approve"));
    await waitFor(() =>
      expect(screen.getByTestId("approval-error").textContent).toBe("Servidor fora do ar."),
    );
    expect(screen.getByTestId("approval-card").getAttribute("data-state")).toBe("needs-action");
    expect((screen.getByTestId("approval-approve") as HTMLButtonElement).disabled).toBe(false);
  });

  it("already decided elsewhere: the card tells its owner, which shows how it stands now", async () => {
    const decided = makeApproval({ status: "denied" });
    const onDecide = vi
      .fn<ApprovalCardProps["onDecide"]>()
      .mockResolvedValue({ ok: false, reason: "decided_elsewhere", approval: decided });
    const onDecidedElsewhere = vi.fn();
    show({ onDecide, onDecidedElsewhere });
    fireEvent.click(screen.getByTestId("approval-approve"));
    await waitFor(() => expect(onDecidedElsewhere).toHaveBeenCalledExactlyOnceWith(decided));
    expect(screen.queryByTestId("approval-error")).toBeNull();
  });

  it("the card takes the focus when it appears, not a button; but not while the person types", () => {
    const { view } = show({ autoFocus: true });
    expect(document.activeElement).toBe(screen.getByTestId("approval-card"));
    expect(screen.getByRole("group").getAttribute("aria-label")).toContain("Ajudante");
    view.unmount();
    const typing = document.createElement("input");
    document.body.append(typing);
    typing.focus();
    typing.value = "escrevendo";
    render(
      <ApprovalCard
        approval={makeApproval()}
        botName="x"
        expanded={false}
        onToggle={noop}
        autoFocus
        onDecide={vi.fn()}
      />,
    );
    expect(document.activeElement).toBe(typing);
    typing.remove();
  });

  it("a card that expires says how long is left", () => {
    const now = Date.parse("2026-11-18T12:00:00Z");
    show({
      approval: makeApproval({ expiresAt: new Date(now + 12 * 60_000).toISOString() }),
      now: () => now,
    });
    expect(screen.getByTestId("approval-expiry").textContent).toContain("Expira em 12 min");
  });
});

describe("ApprovalCard asking for network access: only what is not repeated gets a row", () => {
  it("an argument the card does not state in its own words keeps its row", () => {
    show({
      approval: makeApproval({
        tool: "request_network_access",
        args: { host: "api.novo.com", reason: "baixar", port: 8443 },
      }),
    });
    const content = screen.getByTestId("approval-content");
    expect(
      within(content)
        .getAllByTestId("arg-field")
        .map((f) => f.getAttribute("data-key")),
    ).toEqual(["port"]);
  });

  it("a host that is not in the title keeps its row", () => {
    show({
      approval: makeApproval({
        tool: "request_network_access",
        args: { host: "   ", reason: "baixar" },
      }),
    });
    expect(
      within(screen.getByTestId("approval-content")).queryAllByTestId("arg-field"),
    ).toHaveLength(1);
  });

  it("other tools are untouched: no disclosure, every argument is a row", () => {
    show({ approval: makeApproval({ tool: "shell", args: { command: "ls" } }) });
    expect(screen.queryByTestId("approval-raw")).toBeNull();
    expect(screen.getAllByTestId("arg-field")).toHaveLength(1);
  });
});

describe("ApprovalCard asking for network access", () => {
  const network = (over = {}) =>
    makeApproval({
      tool: "request_network_access",
      args: { host: "api.novo.com", reason: "preciso baixar o relatório do mês" },
      summary: "Allow network access to api.novo.com until the end of this run. Reason: x",
      ...over,
    });

  it("is a normal decision card: 'Rede', 'Acessar <host>', the bot's words, only Recusar and Aprovar", () => {
    show({ approval: network() });
    const card = screen.getByTestId("approval-card");
    expect(card.getAttribute("data-state")).toBe("needs-action");
    expect(card.querySelector(".ui-decision__category")?.textContent).toBe("Rede");
    expect(card.querySelector(".ui-decision__title")?.textContent).toBe("Acessar api.novo.com");
    // One paragraph, and it says the words are the bot's own.
    expect(within(card).getByTestId("approval-why").textContent).toBe(
      "Motivo dado pelo bot: “preciso baixar o relatório do mês”",
    );
    expect(card.querySelectorAll(".ui-decision__lede")).toHaveLength(1);
    // The rows do not repeat what the title (host) and the paragraph (reason) already say...
    expect(
      within(screen.getByTestId("approval-content")).queryAllByTestId("arg-field"),
    ).toHaveLength(0);
    expect(within(card).queryByText("Esta ação não leva argumentos.")).toBeNull();
    // ...and the exact content stays inspectable, all of it, under a disclosure.
    const raw = within(card).getByTestId("approval-raw");
    expect(raw.querySelector("summary")?.textContent).toBe("Ver o conteúdo exato");
    expect(
      within(raw)
        .getAllByTestId("arg-field")
        .map((f) => f.getAttribute("data-key")),
    ).toEqual(["host", "reason"]);
    expect(within(raw).getAllByTestId("arg-value")[1]?.textContent).toBe(
      "preciso baixar o relatório do mês",
    );
    // The muted note: an approval reaches only this execution.
    expect(within(card).getByTestId("network-scope").textContent).toBe(
      "Aprovar vale só para esta execução.",
    );
    // No split button, no menu: a normal action.
    expect(
      within(card)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Recusar", "Aprovar"]);
    expect(card.querySelector(".ui-split")).toBeNull();
  });

  it("decides like any card: Aprovar sends an approval, Recusar a denial, nothing else", async () => {
    const { onDecide } = show({ approval: network() });
    fireEvent.click(screen.getByTestId("approval-approve"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith({ decision: "approve" }));
    fireEvent.click(screen.getByTestId("approval-deny"));
    await waitFor(() => expect(onDecide).toHaveBeenLastCalledWith({ decision: "deny" }));
  });

  it("decided, it is the standard single collapsed row", () => {
    show({ approval: network({ status: "approved", decidedAt: "2026-11-18T12:00:00.000Z" }) });
    const row = screen.getByTestId("approval-card");
    expect(row.getAttribute("data-state")).toBe("done");
    expect(row.textContent).toContain("Rede");
    expect(row.textContent).toContain("Aprovado · Acessar api.novo.com");
    expect(row.querySelector(".ui-decision__footer")).toBeNull();
    cleanup();
    show({ approval: network({ status: "denied", decidedAt: "2026-11-18T12:00:00.000Z" }) });
    expect(screen.getByTestId("approval-card").textContent).toContain(
      "Recusado · Acessar api.novo.com",
    );
  });
});

describe("ApprovalCard decided", () => {
  it.each([
    ["approved", "Aprovado", "done"],
    ["denied", "Recusado", "stopped"],
    ["expired", "Expirou", "stopped"],
    ["cancelled", "Cancelado", "stopped"],
  ] as const)(
    "%s is one line: category, '%s · title', closed until it is clicked",
    (status, word, state) => {
      const onToggle = vi.fn();
      show({
        approval: makeApproval({
          status,
          tool: "shell",
          args: { command: "ls" },
          summary: "Shell in repo: ls",
          decidedAt: new Date().toISOString(),
        }),
        onToggle,
      });
      const card = screen.getByTestId("approval-card");
      expect(card.getAttribute("data-state")).toBe(state);
      expect(card.textContent).toBe(`Terminal${word} · Rodar ls`);
      const row = within(card).getByRole("button");
      expect(row.getAttribute("aria-expanded")).toBe("false");
      expect(within(card).queryByTestId("approval-args")).toBeNull();
      // No buttons but the row itself, and the chevron is only drawn on hover/focus (CSS).
      expect(within(card).getAllByRole("button")).toHaveLength(1);
      expect(card.querySelector(".ui-action__chevron.lucide-chevrons-up-down")).not.toBeNull();
      fireEvent.click(row);
      expect(onToggle).toHaveBeenCalledTimes(1);
    },
  );

  it("opened, it shows what was decided, the exact content, the denial reason and the rule it created", () => {
    const rule = makeRule({ tool: "shell", botId: null, matchers: [] });
    show({
      approval: makeApproval({
        status: "denied",
        reason: "agora não",
        args: { command: "rm -rf build" },
        ruleId: rule.id,
      }),
      rule,
      expanded: true,
    });
    const card = screen.getByTestId("approval-card");
    expect(within(card).getByTestId("approval-detail").textContent).toContain("Você recusou");
    expect(within(card).getByTestId("approval-denial").textContent).toContain("agora não");
    expect(within(card).getByTestId("arg-value").textContent).toBe("rm -rf build");
    expect(within(card).getByTestId("approval-rule").textContent).toContain(
      "Libera Terminal para todos os bots em QUALQUER uso da ferramenta, com quaisquer argumentos.",
    );
    expect(within(card).queryByTestId("approval-deny")).toBeNull();
    expect(within(card).queryByTestId("approval-more")).toBeNull();
  });
});
