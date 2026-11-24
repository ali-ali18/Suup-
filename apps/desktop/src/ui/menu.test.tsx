import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Inbox, LogOut } from "lucide-react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { MenuButton, type MenuItem, PopupMenu } from "./menu.js";

const items = (onSelect: (id: string) => void = () => {}): MenuItem[] => [
  { id: "a", label: "Pendências", icon: Inbox, onSelect: () => onSelect("a") },
  { id: "b", label: "Sair", icon: LogOut, danger: true, onSelect: () => onSelect("b") },
];

describe("MenuButton (the base-maia dropdown menu on Base UI)", () => {
  it("a button with a menu: the ARIA menu button, the icons as data, a press runs the item and closes", async () => {
    const onSelect = vi.fn();
    render(<MenuButton label="Sua conta" items={items(onSelect)} />);
    const trigger = screen.getByRole("button", { name: "Sua conta" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Sua conta" });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(menu.querySelectorAll('[data-testid="menu-icon"]')).toHaveLength(2);
    const entries = screen.getAllByRole("menuitem");
    expect(entries.map((e) => e.textContent)).toEqual(["Pendências", "Sair"]);
    expect(entries[1]?.className).toContain("text-danger-text");
    fireEvent.click(entries[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("a");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("a custom trigger gets the props and keeps its own name and test id", async () => {
    render(
      <MenuButton
        label="Sua conta"
        items={items()}
        placement="above"
        align="start"
        trigger={(props) => (
          <button type="button" {...props} aria-label="Menu da sua conta" data-testid="owner-menu">
            V
          </button>
        )}
      />,
    );
    const trigger = screen.getByTestId("owner-menu");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    fireEvent.click(trigger);
    expect(await screen.findByRole("menu", { name: "Sua conta" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

function Harness({ onSelect }: { onSelect(id: string): void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Abrir
      </button>
      {open && (
        <PopupMenu
          x={40}
          y={40}
          label="Opções de Nova"
          items={items(onSelect)}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

describe("PopupMenu (a menu at a point: the context menu)", () => {
  it("opens where it was asked, runs an item, and is gone after (the screen hears onClose)", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    expect(await screen.findByRole("menu", { name: "Opções de Nova" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sair" }));
    expect(onSelect).toHaveBeenCalledWith("b");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it("Escape closes it without running anything", async () => {
    const onSelect = vi.fn();
    render(<Harness onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: "Abrir" }));
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(onSelect).not.toHaveBeenCalled();
  });
});
