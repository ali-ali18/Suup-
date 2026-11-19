import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDataStore } from "../data/store.js";
import type { SecretOutcome } from "../lib/secret-form.js";
import { SecretRequestCard, type SecretRequestCardProps } from "./secret-request-card.js";

const VALUE = "ghp_Super_Secret_Value_12345";
const noop = () => {};
const good: SecretOutcome<unknown> = { ok: true, result: { name: "GH_TOKEN", provided: true } };

function show(over: Partial<SecretRequestCardProps> = {}) {
  const onSubmit = vi.fn<SecretRequestCardProps["onSubmit"]>().mockResolvedValue(good);
  const onDecline = vi.fn<SecretRequestCardProps["onDecline"]>().mockResolvedValue(good);
  render(
    <SecretRequestCard
      name="GH_TOKEN"
      reason="para dar push"
      botName="Ajudante"
      state="open"
      expanded={false}
      onToggle={noop}
      onSubmit={onSubmit}
      onDecline={onDecline}
      {...over}
    />,
  );
  return { onSubmit, onDecline };
}

const field = () => screen.getByTestId("secret-input") as HTMLInputElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });

describe("the secure form", () => {
  it("is a hidden password field, told not to complete or spell-check, with the reason the bot gave", () => {
    show();
    expect(field().type).toBe("password");
    expect(field().getAttribute("autocomplete")).toBe("off");
    expect(field().getAttribute("spellcheck")).toBe("false");
    expect(field().getAttribute("autocapitalize")).toBe("off");
    expect(field().hasAttribute("name")).toBe(false);
    expect(screen.getByText("Ajudante pede o segredo GH_TOKEN")).toBeTruthy();
    expect(screen.getByText("Motivo dado pelo bot: para dar push")).toBeTruthy();
  });

  it("the reveal button is off by default and only changes how the field is drawn", () => {
    show();
    const reveal = screen.getByRole("button", { name: "Mostrar o valor" });
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    type(VALUE);
    fireEvent.click(reveal);
    expect(field().type).toBe("text");
    expect(field().value).toBe(VALUE);
    expect(
      screen.getByRole("button", { name: "Esconder o valor" }).getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Esconder o valor" }));
    expect(field().type).toBe("password");
  });

  it("Guardar sends the value once and the field is empty the moment it is sent (before the answer)", async () => {
    let answer: (o: SecretOutcome<unknown>) => void = noop;
    const onSubmit = vi.fn(
      () =>
        new Promise<SecretOutcome<unknown>>((resolve) => {
          answer = resolve;
        }),
    );
    show({ onSubmit });
    type(VALUE);
    fireEvent.click(screen.getByTestId("secret-save"));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(VALUE);
    expect(field().value).toBe("");
    expect(field().type).toBe("password");
    // On its way: everything waits.
    expect((screen.getByTestId("secret-save") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("secret-decline") as HTMLButtonElement).disabled).toBe(true);
    expect(field().disabled).toBe(true);
    answer(good);
    await waitFor(() =>
      expect(screen.getByTestId("secret-card").textContent).toContain(
        "segredo GH_TOKEN disponível",
      ),
    );
  });

  it("the value is nowhere in the page: not in the markup, not in an attribute, not after it is sent", async () => {
    show();
    type(VALUE);
    expect(document.documentElement.outerHTML).not.toContain(VALUE);
    fireEvent.click(screen.getByTestId("secret-save"));
    await waitFor(() =>
      expect(screen.getByTestId("secret-card").textContent).toContain("disponível"),
    );
    expect(document.documentElement.outerHTML).not.toContain(VALUE);
    expect(document.body.textContent).not.toContain(VALUE);
  });

  it("Enter in the field saves too; a message about the value (too short...) is shown without echoing it", async () => {
    const onSubmit = vi.fn<SecretRequestCardProps["onSubmit"]>().mockResolvedValue({
      ok: false,
      conflict: false,
      message: "O valor precisa ter pelo menos 8 caracteres.",
    });
    show({ onSubmit });
    type("curto");
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("curto");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("pelo menos 8"));
    expect(screen.getByRole("alert").textContent).not.toContain("curto");
    expect(field().value).toBe("");
  });

  it("a refusal shows the (already cleaned) message, keeps the form, and never the value", async () => {
    const onSubmit = vi
      .fn<SecretRequestCardProps["onSubmit"]>()
      .mockResolvedValue({ ok: false, conflict: false, message: "O servidor recusou o valor." });
    show({ onSubmit });
    type(VALUE);
    fireEvent.click(screen.getByTestId("secret-save"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe("O servidor recusou o valor."),
    );
    expect(screen.getByTestId("secret-card").getAttribute("data-state")).toBe("needs-action");
    expect(document.documentElement.outerHTML).not.toContain(VALUE);
    expect(field().disabled).toBe(false);
  });

  it("Recusar sends no value and the card becomes one line that says so", async () => {
    const { onSubmit, onDecline } = show();
    type(VALUE);
    fireEvent.click(screen.getByTestId("secret-decline"));
    expect(onDecline).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field().value).toBe("");
    await waitFor(() =>
      expect(screen.getByTestId("secret-card").textContent).toContain(
        "você recusou o segredo GH_TOKEN",
      ),
    );
  });

  it("the field is not a controlled input: typing changes no React state a store could hold", () => {
    // The data store and the settings are what the app keeps; the value is in neither, at any point.
    const store = createDataStore();
    show();
    type(VALUE);
    expect(JSON.stringify(store.getState())).not.toContain(VALUE);
    expect(JSON.stringify(localStorage)).not.toContain(VALUE);
    expect(JSON.stringify(sessionStorage)).not.toContain(VALUE);
  });
});

describe("a request already answered", () => {
  it.each([
    ["provided", "segredo GH_TOKEN disponível"],
    ["declined", "você recusou o segredo GH_TOKEN"],
    ["closed", "pedido do segredo GH_TOKEN encerrado"],
  ] as const)("%s is one line: '%s'", (state, line) => {
    show({ state });
    const card = screen.getByTestId("secret-card");
    expect(card.textContent).toContain(line);
    expect(screen.queryByTestId("secret-input")).toBeNull();
  });

  it("opens on click to say what the bot knows: only that it is available", () => {
    const onToggle = vi.fn();
    show({ state: "provided", onToggle, expanded: true });
    expect(screen.getByRole("region").textContent).toContain(
      "só o aviso de que GH_TOKEN está disponível",
    );
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
