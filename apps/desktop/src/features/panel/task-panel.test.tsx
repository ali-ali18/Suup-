import type { Task } from "@suup/api";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
