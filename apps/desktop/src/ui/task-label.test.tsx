import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TaskLabel } from "./task-label.js";
import { TaskLink } from "./task-link.js";

describe("the label and the link of a task (KOD-68)", () => {
  it('the label says the state, or "Novas respostas" in the unread colour while there are replies to read', () => {
    const onOpen = vi.fn();
    const { rerender } = render(
      <TaskLabel taskId="t1" title="Revisar o projeto" state="waiting_user" onOpen={onOpen} />,
    );
    expect(screen.getByTestId("task-label-state").textContent).toContain("Aguardando sua resposta");
    expect(screen.getByTestId("task-label-state").className).not.toContain("text-status-unread");
    rerender(
      <TaskLabel
        taskId="t1"
        title="Revisar o projeto"
        state="waiting_user"
        unread
        onOpen={onOpen}
      />,
    );
    const state = screen.getByTestId("task-label-state");
    expect(state.textContent).toContain("Novas respostas");
    expect(state.className).toContain("text-status-unread");
    expect(screen.getByTestId("task-label").getAttribute("aria-label")).toBe(
      "Abrir a tarefa: Revisar o projeto · Novas respostas",
    );
    fireEvent.click(screen.getByTestId("task-label"));
    expect(onOpen).toHaveBeenCalledWith("t1");
  });

  it("the link is a button with the outline chat icon and the name, underlined, in the text colour", () => {
    const onOpen = vi.fn();
    render(<TaskLink taskId="t9" title="Gravar o relatório" onOpen={onOpen} />);
    const link = screen.getByTestId("task-link");
    expect(link.tagName).toBe("BUTTON");
    expect(link.className).toContain("text-inherit");
    expect(link.querySelector("svg")).not.toBeNull();
    expect(link.querySelector("span")?.className).toContain("underline");
    expect(link.className).not.toContain("blue");
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("t9");
  });
});
