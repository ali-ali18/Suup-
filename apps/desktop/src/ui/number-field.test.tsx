import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NumberField } from "./number-field.js";

afterEach(cleanup);

function show(value = 15) {
  const onCommit = vi.fn();
  const onInvalid = vi.fn();
  render(
    <NumberField
      label="Turnos"
      value={value}
      suffix="min"
      testId="n"
      onCommit={onCommit}
      onInvalid={onInvalid}
    />,
  );
  return { onCommit, onInvalid, input: screen.getByLabelText("Turnos") as HTMLInputElement };
}

describe("NumberField", () => {
  it("shows the value with its unit and sends nothing while it is being typed", () => {
    const { input, onCommit } = show();
    expect(input.value).toBe("15");
    expect(screen.getByText("min")).toBeTruthy();
    fireEvent.change(input, { target: { value: "20" } });
    expect(input.value).toBe("20");
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("commits on Enter and on blur, once, as a number", () => {
    const { input, onCommit } = show();
    fireEvent.change(input, { target: { value: " 20 " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith(20);
    fireEvent.change(input, { target: { value: "30" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenLastCalledWith(30);
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("does not send what did not change, and Escape drops what was typed", () => {
    const { input, onCommit } = show();
    fireEvent.change(input, { target: { value: "15" } });
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "99" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("15");
    fireEvent.blur(input);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("says so when it is not a number; the range is left to the server", () => {
    const { input, onCommit, onInvalid } = show();
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(onInvalid).toHaveBeenCalledWith("Digite um número.");
    expect(input.value).toBe("15");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(onInvalid).toHaveBeenCalledTimes(2);
    // 9999 is far out of any range here; it is sent and the server says so.
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.blur(input);
    expect(onCommit).toHaveBeenCalledWith(9999);
  });
});
