import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { actionsOf } from "../../data/actions.js";
import { makeEvent } from "../../test-fixtures.js";
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
    expect(container.querySelector(".ui-action__line--removed")?.textContent).toContain("foo");
    expect(container.querySelector(".ui-action__line--added")?.textContent).toContain("bar");
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
    expect(screen.getByTestId("action-output").className).toContain("ui-action__pre--error");
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
});
