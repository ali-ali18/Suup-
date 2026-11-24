import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TextField } from "./primitives.js";

describe("TextField on Field and Input", () => {
  it("ties the label to the control and says the hint through aria-describedby", () => {
    render(<TextField label="Nome" value="" onChange={() => {}} hint="Letras minúsculas." />);
    const input = screen.getByLabelText("Nome");
    expect(input.tagName).toBe("INPUT");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText("Letras minúsculas.").id);
  });

  it("the error comes from the screen: aria-invalid, an alert, described by it", () => {
    render(<TextField label="Nome" value="x" onChange={() => {}} error="Nome inválido." />);
    const input = screen.getByLabelText("Nome");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Nome inválido.");
    expect(input.getAttribute("aria-describedby")).toContain(alert.id);
  });

  it("types, and Enter calls onEnter; a text area is a textbox too", () => {
    const onChange = vi.fn();
    const onEnter = vi.fn();
    render(<TextField label="Texto" value="" onChange={onChange} onEnter={onEnter} />);
    const input = screen.getByLabelText("Texto");
    fireEvent.change(input, { target: { value: "abc" } });
    expect(onChange).toHaveBeenCalledWith("abc");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onEnter).toHaveBeenCalledTimes(1);
    render(<TextField label="Longo" value="" onChange={onChange} multiline />);
    expect(screen.getByLabelText("Longo").tagName).toBe("TEXTAREA");
  });
});
