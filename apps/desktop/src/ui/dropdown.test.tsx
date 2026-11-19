import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Dropdown, type DropdownOption } from "./dropdown.js";
import { Dialog } from "./primitives.js";

const THREE: DropdownOption[] = [
  { value: "a", label: "Alfa" },
  { value: "b", label: "Beta" },
  { value: "c", label: "Gama" },
];
const MANY: DropdownOption[] = Array.from({ length: 12 }, (_, i) => ({
  value: `v${i}`,
  label: i === 7 ? "Serviço especial" : `Item ${i}`,
}));

function Harness({
  options = THREE,
  onChange,
}: {
  options?: DropdownOption[];
  onChange?(v: string): void;
}) {
  const [value, setValue] = useState(options[0]?.value ?? "");
  return (
    <Dropdown
      label="Escolha"
      value={value}
      options={options}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

const button = () => screen.getByRole("button", { name: "Escolha" });

describe("Dropdown", () => {
  it("shows the current value, and a button that has a listbox", () => {
    render(<Harness />);
    expect(button().textContent).toBe("Alfa");
    expect(button().getAttribute("aria-haspopup")).toBe("listbox");
    expect(button().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    const options = within(screen.getByRole("listbox", { name: "Escolha" })).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Alfa", "Beta", "Gama"]);
    expect(options.map((o) => o.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
    // The chosen option has the focus, and there is no filter for a short list.
    expect(document.activeElement).toBe(options[0]);
    expect(screen.queryByLabelText("Filtrar: Escolha")).toBeNull();
  });

  it("ArrowDown opens it; arrows, Home and End move; Enter chooses and the focus goes back", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    button().focus();
    fireEvent.keyDown(button(), { key: "ArrowDown" });
    const list = screen.getByRole("listbox");
    const options = within(list).getAllByRole("option");
    fireEvent.keyDown(options[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(options[2]);
    fireEvent.keyDown(options[2] as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0] as HTMLElement, { key: "ArrowDown" });
    fireEvent.click(document.activeElement as HTMLElement); // Enter on a button is a click
    expect(onChange).toHaveBeenCalledWith("b");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(button().textContent).toBe("Beta");
    expect(document.activeElement).toBe(button());
  });

  it("Escape closes it without choosing and gives the focus back, without closing the dialog around", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <Dialog title="Janela" onClose={onClose}>
        <Harness onChange={onChange} />
      </Dialog>,
    );
    fireEvent.click(button());
    fireEvent.keyDown(screen.getAllByRole("option")[1] as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a long list has a filter: a case-insensitive substring of the labels, Enter takes the first", () => {
    const onChange = vi.fn();
    render(<Harness options={MANY} onChange={onChange} />);
    fireEvent.click(button());
    const filter = screen.getByLabelText("Filtrar: Escolha");
    expect(document.activeElement).toBe(filter);
    expect(screen.getAllByRole("option")).toHaveLength(12);
    fireEvent.change(filter, { target: { value: "VIÇO" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Serviço especial"]);
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    fireEvent.change(filter, { target: { value: "item 1" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Item 1",
      "Item 10",
      "Item 11",
    ]);
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("v1");
  });

  it("a click outside closes it", () => {
    render(<Harness />);
    fireEvent.click(button());
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
