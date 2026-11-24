import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Popover } from "./popover.js";
import { RoundButton } from "./primitives.js";
import { Toggle } from "./switch.js";
import { Tip } from "./tooltip.js";

function Harness({ onChange, disabled }: { onChange?(v: boolean): void; disabled?: boolean }) {
  const [on, setOn] = useState(false);
  return (
    <Toggle
      label="Ligado"
      checked={on}
      disabled={disabled ?? false}
      testId="the-switch"
      onChange={(v) => {
        setOn(v);
        onChange?.(v);
      }}
    />
  );
}

describe("Toggle (the base-maia switch on Base UI)", () => {
  it("is a native button with the switch role, its name and its state", () => {
    render(<Harness />);
    const sw = screen.getByRole("switch", { name: "Ligado" });
    expect(sw.tagName).toBe("BUTTON");
    expect(sw).toBe(screen.getByTestId("the-switch"));
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(sw.hasAttribute("data-unchecked")).toBe(true);
  });

  it("a click flips it and tells the screen the new value", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const sw = screen.getByRole("switch", { name: "Ligado" });
    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(true);
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(sw.hasAttribute("data-checked")).toBe(true);
    fireEvent.click(sw);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it("disabled does nothing and is the button's own disabled", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} disabled />);
    const sw = screen.getByRole("switch", { name: "Ligado" });
    expect((sw as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(sw);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the hidden checkbox Base UI keeps beside it is not seen by assistive technology", () => {
    render(<Harness />);
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});

describe("Tip (the base-maia tooltip on Base UI)", () => {
  it("shows the label beside the control on hover, and the control keeps its own name", async () => {
    vi.useFakeTimers();
    try {
      render(
        <Tip label="Rodar agora" testId="tip">
          <button type="button" aria-label="Rodar">
            x
          </button>
        </Tip>,
      );
      const button = screen.getByRole("button", { name: "Rodar" });
      expect(screen.queryByTestId("tip")).toBeNull();
      fireEvent.pointerEnter(button, { pointerType: "mouse" });
      fireEvent.mouseEnter(button);
      fireEvent.mouseMove(button);
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(screen.getByTestId("tip").textContent).toBe("Rodar agora");
    } finally {
      vi.useRealTimers();
    }
  });

  it("RoundButton has no native title any more: its name is the aria-label and the tip", () => {
    render(
      <RoundButton label="Fechar">
        <span>x</span>
      </RoundButton>,
    );
    const button = screen.getByRole("button", { name: "Fechar" });
    expect(button.hasAttribute("title")).toBe(false);
  });
});

describe("Popover (the base-maia popover on Base UI)", () => {
  it("opens from its trigger with a named panel, and Escape closes it back to the trigger", async () => {
    render(
      <Popover
        title="Sobre isto"
        testId="pop"
        trigger={
          <button type="button" aria-label="Saber mais">
            ?
          </button>
        }
      >
        Uma frase.
      </Popover>,
    );
    const trigger = screen.getByRole("button", { name: "Saber mais" });
    fireEvent.click(trigger);
    const panel = await screen.findByTestId("pop");
    expect(panel.getAttribute("role")).toBe("dialog");
    expect(panel.textContent).toContain("Sobre isto");
    expect(panel.textContent).toContain("Uma frase.");
    fireEvent.keyDown(panel, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("pop")).toBeNull());
  });
});
