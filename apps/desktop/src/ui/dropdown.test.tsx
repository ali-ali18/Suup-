import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { pressOption } from "../test-fixtures.js";
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

const button = () => screen.getByRole("combobox", { name: "Escolha" });

describe("Dropdown (the base-maia select on Base UI)", () => {
  it("shows the current value, and a button that has a listbox", async () => {
    render(<Harness />);
    expect(button().tagName).toBe("BUTTON");
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
    await waitFor(() => expect(document.activeElement).toBe(options[0]));
    expect(screen.queryByLabelText("Filtrar: Escolha")).toBeNull();
  });

  it("ArrowDown opens it; arrows, Home and End move; Enter chooses and the focus goes back", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    button().focus();
    fireEvent.keyDown(button(), { key: "ArrowDown" });
    const list = await screen.findByRole("listbox");
    const options = within(list).getAllByRole("option");
    await waitFor(() => expect(document.activeElement).toBe(options[0]));
    fireEvent.keyDown(options[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1] as HTMLElement, { key: "End" });
    expect(document.activeElement).toBe(options[2]);
    fireEvent.keyDown(options[2] as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0] as HTMLElement, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("b");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(button().textContent).toBe("Beta");
    expect(document.activeElement).toBe(button());
  });

  it("a press on an option chooses it", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(button());
    pressOption(screen.getByRole("option", { name: "Gama" }));
    expect(onChange).toHaveBeenCalledWith("c");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("Escape closes it without choosing and gives the focus back, without closing the dialog around", async () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    render(
      <Dialog title="Janela" onClose={onClose}>
        <Harness onChange={onChange} />
      </Dialog>,
    );
    fireEvent.click(button());
    fireEvent.keyDown(screen.getAllByRole("option")[1] as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(document.activeElement).toBe(button());
    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a long list has a filter: a case-insensitive substring of the labels, Enter takes the first", async () => {
    const onChange = vi.fn();
    render(<Harness options={MANY} onChange={onChange} />);
    fireEvent.click(button());
    const filter = await screen.findByLabelText("Filtrar: Escolha");
    await waitFor(() => expect(document.activeElement).toBe(filter));
    expect(screen.getAllByRole("option")).toHaveLength(12);
    fireEvent.change(filter, { target: { value: "VIÇO" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Serviço especial"]);
    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nada com “zzz”.")).toBeTruthy();
    fireEvent.change(filter, { target: { value: "item 1" } });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Item 1",
      "Item 10",
      "Item 11",
    ]);
    fireEvent.keyDown(filter, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("v1");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("a click outside closes it", async () => {
    render(<Harness />);
    fireEvent.click(button());
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    fireEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });
});
