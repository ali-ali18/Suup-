import { BOT_COLORS, BOT_PALETTE } from "@suup/api";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toggle } from "./switch.js";

afterEach(cleanup);

describe("Toggle: the switch of a specific bot (owner, 24/11/2026)", () => {
  const style = () => screen.getByRole("switch").style.getPropertyValue("--bot-fill");

  it("takes the colour of the bot when on, for every colour but white", () => {
    for (const color of BOT_COLORS) {
      if (color === "branco") continue;
      const { unmount } = render(
        <Toggle checked onChange={() => {}} label="Supervisor" color={color} />,
      );
      expect(style(), color).toBe(BOT_PALETTE[color].fill);
      expect(screen.getByRole("switch").className).toContain("data-checked:bg-bot-fill");
      unmount();
    }
  });

  it("is blue when the bot is white (white on white would vanish)", () => {
    render(<Toggle checked onChange={() => {}} label="Supervisor" color="branco" />);
    expect(style()).toBe(BOT_PALETTE.azul.fill);
    expect(screen.getByRole("switch").getAttribute("data-color")).toBe("azul");
  });

  it("is still a switch: Space and click flip it, and the general ones are not painted", () => {
    const onChange = vi.fn();
    render(<Toggle checked={false} onChange={onChange} label="Supervisor" color="rosa" />);
    fireEvent.click(screen.getByRole("switch"));
    expect(onChange).toHaveBeenCalledWith(true);
    cleanup();
    render(<Toggle checked onChange={() => {}} label="Geral" />);
    expect(screen.getByRole("switch").style.getPropertyValue("--bot-fill")).toBe("");
    expect(screen.getByRole("switch").className).toContain("data-checked:bg-bg-inverse");
  });
});
