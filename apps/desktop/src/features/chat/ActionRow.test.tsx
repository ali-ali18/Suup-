import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { actionsOf, mergeApprovals } from "../../data/actions.js";
import { makeApproval, makeEvent } from "../../test-fixtures.js";
import { ActionRow } from "./ActionRow.js";

const item = (name: string, args: Record<string, unknown>, content?: string, isError = false) => {
  const events = [makeEvent(1, "tool_call", { callId: "c", name, args })];
  if (content !== undefined)
    events.push(
      makeEvent(2, "tool_result", {
        callId: "c",
        content,
        isError,
        truncated: false,
        durationMs: 10,
      }),
    );
  return actionsOf("r", events)[0] as NonNullable<ReturnType<typeof actionsOf>[number]>;
};

describe("ActionRow: what an expanded action says, as plain text", () => {
  it("a terminal action: the command, then its output; collapsed by default", () => {
    render(
      <ActionRow
        item={item("shell", { command: "pnpm test" }, "48 testes passaram")}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(screen.queryByTestId("action-output")).toBeNull();
    render(
      <ActionRow
        item={item("shell", { command: "pnpm test" }, "48 testes passaram")}
        expanded
        onToggle={() => {}}
      />,
    );
    expect(screen.getByText("$ pnpm test")).toBeTruthy();
    expect(screen.getByTestId("action-output").textContent).toBe("48 testes passaram");
  });

  it("an edit shows a plain-text diff with + and - prefixes coloured by text only", () => {
    const { container } = render(
      <ActionRow
        item={item(
          "edit_file",
          { path: "a.ts", old_string: "x\nfoo\ny", new_string: "x\nbar\ny" },
          "ok",
        )}
        expanded
        onToggle={() => {}}
      />,
    );
    expect(screen.getByTestId("diff").textContent).toBe("  x\n- foo\n+ bar\n  y\n");
    expect(container.querySelector('[data-testid="action-line-removed"]')?.textContent).toContain(
      "foo",
    );
    expect(container.querySelector('[data-testid="action-line-added"]')?.textContent).toContain(
      "bar",
    );
  });

  it("a failed action shows its error; a web action its address and an excerpt (cut when long)", () => {
    render(
      <ActionRow
        item={item("read_file", { path: "x" }, "arquivo não existe", true)}
        expanded
        onToggle={() => {}}
      />,
    );
    expect(screen.getByRole("button").textContent).toContain("Falhou · Ler x");
    expect(screen.getByTestId("action-output").getAttribute("data-error")).toBe("true");
    const web = render(
      <ActionRow
        item={item("web_fetch", { url: "https://example.com/a" }, "y".repeat(3000))}
        expanded
        onToggle={() => {}}
      />,
    );
    expect(web.getAllByTestId("action-output").at(-1)?.textContent?.length).toBeLessThan(1600);
  });

  it("toggles from the row", () => {
    let toggled = 0;
    render(
      <ActionRow
        item={item("recall", {}, "nada")}
        expanded={false}
        onToggle={() => (toggled += 1)}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(toggled).toBe(1);
  });

  describe("a call that had an approval is one row", () => {
    const merged = (status: "approved" | "denied", result?: string, isError = false) => {
      const events = [
        makeEvent(1, "tool_call", {
          callId: "c",
          name: "write_file",
          args: { path: "aprovado.txt", content: "conteúdo aprovado" },
        }),
      ];
      if (result !== undefined)
        events.push(
          makeEvent(2, "tool_result", {
            callId: "c",
            content: result,
            isError,
            truncated: false,
            durationMs: 5,
          }),
        );
      const approval = makeApproval({
        runId: "r",
        callId: "c",
        tool: "write_file",
        args: { path: "aprovado.txt", content: "conteúdo aprovado" },
        status,
        reason: status === "denied" ? "agora não" : null,
        decidedAt: "2026-11-18T12:00:05.000Z",
      });
      return mergeApprovals(actionsOf("r", events), [approval]).calls[0] as NonNullable<
        ReturnType<typeof actionsOf>[number]
      >;
    };

    it("collapsed: the category once, the decision and the execution together, then what it did", () => {
      render(
        <ActionRow item={merged("approved", "escrito")} expanded={false} onToggle={() => {}} />,
      );
      expect(screen.getByRole("button").textContent).toBe(
        "ArquivoAprovado e concluído · Escrever aprovado.txt",
      );
    });

    it('approved too late, collapsed: "Aprovado depois de N h · <ação>", no buttons beyond the row', () => {
      const item = merged("approved", "Aviso do sistema");
      const late = {
        ...item,
        approval: {
          ...(item.approval as NonNullable<typeof item.approval>),
          stale: true,
          waitedMs: 5 * 3_600_000,
        },
      };
      render(<ActionRow item={late} expanded={false} onToggle={() => {}} />);
      expect(screen.getByRole("button").textContent).toBe(
        "ArquivoAprovado depois de 5 h · Escrever aprovado.txt",
      );
      expect(screen.getAllByRole("button")).toHaveLength(1);
    });

    it("opened: what was approved, exactly, and what happened", () => {
      render(<ActionRow item={merged("approved", "escrito")} expanded onToggle={() => {}} />);
      expect(screen.getByTestId("approval-detail").textContent).toContain("Você aprovou");
      expect(screen.getAllByTestId("arg-value").map((v) => v.textContent)).toEqual([
        "aprovado.txt",
        "conteúdo aprovado",
      ]);
      expect(screen.getByTestId("action-output").textContent).toBe("escrito");
    });

    it("approved and failed: says so and shows the error", () => {
      render(
        <ActionRow item={merged("approved", "disco cheio", true)} expanded onToggle={() => {}} />,
      );
      expect(screen.getByRole("button").textContent).toContain("Aprovado, mas falhou · Escrever");
      expect(screen.getByTestId("action-output").getAttribute("data-error")).toBe("true");
    });

    it("denied: no execution, the reason, and no result block", () => {
      render(
        <ActionRow
          item={merged("denied", "O usuário recusou.", true)}
          expanded
          onToggle={() => {}}
        />,
      );
      expect(screen.getByRole("button").textContent).toContain("Recusado · Escrever aprovado.txt");
      expect(screen.getByTestId("approval-denial").textContent).toContain("agora não");
      expect(screen.queryByTestId("action-output")).toBeNull();
    });

    it("allowed by a rule with no card: just the action, with a discreet line when opened", () => {
      const events = [
        makeEvent(1, "tool_call", { callId: "c", name: "write_file", args: { path: "a.txt" } }),
        makeEvent(2, "policy_checked", {
          callId: "c",
          tool: "write_file",
          level: "write_reversible",
          outcome: "allow",
          source: "rule",
        }),
        makeEvent(3, "tool_result", {
          callId: "c",
          content: "ok",
          isError: false,
          truncated: false,
        }),
      ];
      render(<ActionRow item={actionsOf("r", events)[0] as never} expanded onToggle={() => {}} />);
      expect(screen.getByRole("button").textContent).toBe("ArquivoConcluído · Escrever a.txt");
      expect(screen.getByTestId("action-rule-allowed").textContent).toContain("regra");
      expect(screen.queryByTestId("approval-detail")).toBeNull();
    });
  });
});
