import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DecideOutcome } from "../data/sync.js";
import { makeApproval, makeRule } from "../test-fixtures.js";
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
    expect(buttons).toEqual(["Recusar", "Aprovar", "Mais opções de aprovação"]);
    expect(within(card).queryByRole("textbox")).toBeNull();
  });

  it("an unknown tool falls back to the server's summary, with the generic category", () => {
    show({ approval: makeApproval({ tool: "tool_nova", summary: "Faz algo novo" }) });
    expect(screen.getByText("Faz algo novo")).toBeTruthy();
    expect(screen.getByText("Aprovação")).toBeTruthy();
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

  const openMenu = () => {
    fireEvent.click(screen.getByTestId("approval-more"));
    return screen.getByRole("menu", { name: "Mais opções de aprovação" });
  };

  it("the chevron opens the menu: four 'Sempre permitir' variants, 'Precisa de aprovação' checked, 'Gerenciar regras'", () => {
    const onManageRules = vi.fn();
    show({ onManageRules });
    const trigger = screen.getByTestId("approval-more");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const menu = openMenu();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = Array.from(menu.querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    expect(items.map((i) => i.querySelector(".ui-menu__label")?.textContent)).toEqual([
      "Sempre permitir isto, neste bot",
      "Sempre permitir esta ferramenta, neste bot",
      "Sempre permitir isto, em todos os bots",
      "Sempre permitir esta ferramenta, em todos os bots",
      "Precisa de aprovação",
      "Gerenciar regras",
    ]);
    // Each variant says in one muted line what it does.
    expect(items[0]?.textContent).toContain("Só quando o conteúdo for idêntico a este.");
    expect(items[1]?.textContent).toContain("Qualquer uso de Terminal");
    expect(screen.getByTestId("approval-needs").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("approval-manage-rules"));
    expect(onManageRules).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("'Sempre permitir' approves and sends the scope and what it matches; the settings order the scopes", () => {
    const { onDecide } = show({ defaultScope: "global" });
    openMenu();
    const first = screen.getAllByRole("menuitem")[0] as HTMLElement;
    expect(first.textContent).toContain("em todos os bots");
    fireEvent.click(screen.getByTestId("always-global-exact"));
    expect(onDecide).toHaveBeenLastCalledWith({ decision: "approve", always: { scope: "global" } });
  });

  it("'Sempre permitir esta ferramenta' sends an empty list of conditions", async () => {
    const { onDecide } = show();
    openMenu();
    fireEvent.click(screen.getByTestId("always-bot-any"));
    expect(onDecide).toHaveBeenLastCalledWith({
      decision: "approve",
      always: { scope: "bot", matchers: [] },
    });
    await waitFor(() =>
      expect((screen.getByTestId("approval-approve") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  it("turning 'Precisa de aprovação' off makes Aprovar create the rule, and says which one before", () => {
    const { onDecide } = show({
      approval: makeApproval({ args: { command: "git push origin main" } }),
    });
    openMenu();
    fireEvent.click(screen.getByTestId("approval-needs"));
    expect(screen.getByTestId("always-sentence").textContent).toContain("o bot Ajudante");
    expect(screen.getByTestId("always-sentence").textContent).toContain(
      "command = “git push origin main”",
    );
    expect(screen.getByTestId("approval-approve").textContent).toBe("Aprovar e permitir");
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(onDecide).toHaveBeenLastCalledWith({ decision: "approve", always: { scope: "bot" } });
  });

  it("the menu works from the keyboard: arrows move, Escape closes and gives the focus back", () => {
    show();
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
      expect(card.querySelector(".ui-action__chevron")).not.toBeNull();
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
      "Libera Terminal para todos os bots em qualquer uso.",
    );
    expect(within(card).queryByTestId("approval-deny")).toBeNull();
    expect(within(card).queryByTestId("approval-more")).toBeNull();
  });
});
