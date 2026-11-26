import type { Task } from "@suup/api";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { costText } from "../../data/task-text.js";

describe("the data of a task (KOD-68, preview)", () => {
  it("says the cost in dollars as the server counted it", () => {
    expect(costText("0.034100")).toBe("US$ 0,03");
    expect(costText("0.003800")).toBe("US$ 0,0038");
    expect(costText("0.000000")).toBe("US$ 0,00");
    expect(costText("12.5")).toBe("US$ 12,50");
  });
});

describe("task type", () => {
  it("the Task schema carries the request quoted by the task view", () => {
    const task = { sourceMessages: [{ id: "m1", text: "Revise o projeto." }] } as Pick<
      Task,
      "sourceMessages"
    >;
    render(<p>{task.sourceMessages[0]?.text}</p>);
    expect(screen.getByText("Revise o projeto.")).toBeTruthy();
  });
});
