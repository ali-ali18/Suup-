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
  it("shows the summary, the risk, who asks, and the exact content with the buttons underneath", () => {
    show({
      approval: makeApproval({
        summary: "Shell em repo: git push origin main",
        args: { command: "git push origin main", cwd: "/repo" },
      }),
    });
    const card = screen.getByTestId("approval-card");
    expect(card.getAttribute("data-state")).toBe("needs-action");
    expect(within(card).getByText("Shell em repo: git push origin main")).toBeTruthy();
    expect(within(card).getByText("Externa ou irreversível")).toBeTruthy();
    // The tool in human words, in the header.
    expect(within(card).getByText("Aprovação · Terminal")).toBeTruthy();
    expect(within(card).getByText(/Ajudante quer rodar um comando/)).toBeTruthy();
    const fields = within(card).getAllByTestId("arg-field");
    expect(fields.map((f) => f.getAttribute("data-key"))).toEqual(["command", "cwd"]);
    expect(within(fields[0] as HTMLElement).getByTestId("arg-value").textContent).toBe(
      "git push origin main",
    );
    expect(within(card).getByTestId("approval-why").textContent).toContain(
      "o nível desta ação pede sua permissão",
    );
    const buttons = within(card)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(buttons).toEqual(["Negar", "Aprovar e sempre permitir…", "Aprovar"]);
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
    expect(screen.getByTestId("approval-connector").textContent).toBe(
      "Conector fake · ferramenta write_thing",
    );
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
    expect((screen.getByTestId("approval-reason") as HTMLInputElement).disabled).toBe(true);
    // Still a pending card: nothing was assumed.
    expect(card.getAttribute("data-state")).toBe("needs-action");
    await act(async () => finish(ok()));
    expect(screen.getByTestId("approval-approve").textContent).toBe("Aprovar");
  });

  it("Negar sends the reason (trimmed), or none when it is empty", () => {
    const { onDecide } = show();
    fireEvent.change(screen.getByTestId("approval-reason"), { target: { value: "  não agora  " } });
    fireEvent.click(screen.getByTestId("approval-deny"));
    expect(onDecide).toHaveBeenLastCalledWith({ decision: "deny", reason: "não agora" });
  });

  it("Negar without a reason sends no reason", () => {
    const { onDecide } = show();
    fireEvent.click(screen.getByTestId("approval-deny"));
    expect(onDecide).toHaveBeenCalledExactlyOnceWith({ decision: "deny" });
  });

  it("Aprovar e sempre permitir: choose the scope and what it matches, read what the rule does, then confirm", () => {
    const { onDecide } = show({
      approval: makeApproval({ args: { command: "git push origin main" } }),
      defaultScope: "bot",
    });
    const toggle = screen.getByTestId("approval-always-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("always-scope-bot").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("always-sentence").textContent).toContain("o bot Ajudante");
    expect(screen.getByTestId("always-sentence").textContent).toContain(
      "command = “git push origin main”",
    );
    fireEvent.click(screen.getByTestId("always-scope-global"));
    expect(screen.getByTestId("always-sentence").textContent).toContain("todos os bots");
    fireEvent.click(screen.getByTestId("approval-always-confirm"));
    expect(onDecide).toHaveBeenLastCalledWith({ decision: "approve", always: { scope: "global" } });
  });

  it("'qualquer uso' sends an empty list of conditions, and the settings choose the scope that is proposed", () => {
    const { onDecide } = show({ defaultScope: "global" });
    fireEvent.click(screen.getByTestId("approval-always-toggle"));
    expect(screen.getByTestId("always-scope-global").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("always-match-any"));
    expect(screen.getByTestId("always-sentence").textContent).toContain("qualquer uso de Terminal");
    fireEvent.click(screen.getByTestId("approval-always-confirm"));
    expect(onDecide).toHaveBeenLastCalledWith({
      decision: "approve",
      always: { scope: "global", matchers: [] },
    });
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
    ["denied", "Negado", "stopped"],
    ["expired", "Expirou", "stopped"],
    ["cancelled", "Cancelado", "stopped"],
  ] as const)(
    "%s is one line: '%s · summary', closed until it is clicked",
    (status, word, state) => {
      const onToggle = vi.fn();
      show({
        approval: makeApproval({
          status,
          summary: "Shell em repo: ls",
          decidedAt: new Date().toISOString(),
        }),
        onToggle,
      });
      const card = screen.getByTestId("approval-card");
      expect(card.getAttribute("data-state")).toBe(state);
      expect(card.textContent).toContain(`${word} · Shell em repo: ls`);
      const row = within(card).getByRole("button");
      expect(row.getAttribute("aria-expanded")).toBe("false");
      expect(within(card).queryByTestId("approval-args")).toBeNull();
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
    expect(within(card).getByTestId("approval-detail").textContent).toContain("Você negou");
    expect(within(card).getByTestId("approval-denial").textContent).toContain("agora não");
    expect(within(card).getByTestId("arg-value").textContent).toBe("rm -rf build");
    expect(within(card).getByTestId("approval-rule").textContent).toContain(
      "Libera Terminal para todos os bots em qualquer uso.",
    );
    expect(within(card).queryByTestId("approval-deny")).toBeNull();
  });
});
