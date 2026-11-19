import type { Question } from "@suup/api";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuestionCard, userIsTyping } from "./question-card.js";

const single: Question[] = [
  {
    question: "Qual banco?",
    options: [{ label: "Postgres", description: "robusto" }, { label: "SQLite" }],
  },
];
const multi: Question[] = [
  {
    question: "Em que você quer foco?",
    options: [{ label: "Faculdade" }, { label: "Curso" }, { label: "Projeto" }],
    multiple: true,
  },
];
const quiz: Question[] = [
  { question: "Qual banco?", options: [{ label: "Postgres" }, { label: "SQLite" }] },
  { question: "Quais extras?", options: [{ label: "Cache" }, { label: "Fila" }], multiple: true },
  { question: "Algo mais?", options: [{ label: "Não" }, { label: "Sim" }], allowOther: true },
];

const options = () => screen.getAllByTestId("question-option");

describe("QuestionCard: one choice", () => {
  it("shows the question, letter chips and no footer; a click answers", () => {
    const onSubmit = vi.fn();
    render(<QuestionCard questions={single} onSubmit={onSubmit} />);
    expect(screen.getByText("Qual banco?")).toBeTruthy();
    expect(options().map((o) => o.textContent)).toEqual(["APostgresrobusto", "BSQLite"]);
    expect(screen.queryByRole("button", { name: /Pular|Avançar|Enviar|Voltar/ })).toBeNull();
    fireEvent.click(options()[1] as HTMLElement);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("SQLite");
  });

  it("is a radiogroup; the letters A to F choose, the arrows move", () => {
    const onSubmit = vi.fn();
    render(<QuestionCard questions={single} onSubmit={onSubmit} />);
    expect(screen.getByRole("radiogroup", { name: "Qual banco?" })).toBeTruthy();
    const [a] = options();
    (a as HTMLElement).focus();
    fireEvent.keyDown(a as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options()[1]);
    fireEvent.keyDown(options()[1] as HTMLElement, { key: "a" });
    expect(onSubmit).toHaveBeenCalledWith("Postgres");
  });

  it("'Outra resposta' (allowOther) takes typed text and sends it", () => {
    const onSubmit = vi.fn();
    render(
      <QuestionCard
        questions={[{ ...(single[0] as Question), allowOther: true }]}
        onSubmit={onSubmit}
      />,
    );
    expect(options().map((o) => o.textContent?.slice(0, 1))).toEqual(["A", "B", "C"]);
    fireEvent.click(options()[2] as HTMLElement);
    expect(onSubmit).not.toHaveBeenCalled();
    const input = screen.getByLabelText(/Sua resposta para/);
    expect((screen.getByRole("button", { name: "Enviar" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(input, { target: { value: "  MySQL  " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("MySQL");
  });
});

describe("QuestionCard: several choices in one question", () => {
  it("is a group of checkboxes with a helper line; Pular sends the skip, Enviar the picks", () => {
    const onSubmit = vi.fn();
    const { unmount } = render(<QuestionCard questions={multi} onSubmit={onSubmit} />);
    expect(screen.getByText("Selecione todas as opções aplicáveis")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Em que você quer foco?" })).toBeTruthy();
    fireEvent.click(options()[0] as HTMLElement);
    fireEvent.click(options()[2] as HTMLElement);
    expect(options().map((o) => o.getAttribute("aria-checked"))).toEqual(["true", "false", "true"]);
    fireEvent.click(options()[0] as HTMLElement); // toggles off
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("Projeto");
    unmount();
    const skip = vi.fn();
    render(<QuestionCard questions={multi} onSubmit={skip} />);
    fireEvent.click(options()[1] as HTMLElement);
    fireEvent.click(screen.getByRole("button", { name: "Pular" }));
    expect(skip).toHaveBeenCalledExactlyOnceWith("(pulou)");
  });
});

describe("QuestionCard: a questionnaire", () => {
  it("pages with dots, Pular/Avançar then Voltar/Avançar, Enviar on the last page", () => {
    const onSubmit = vi.fn();
    render(<QuestionCard questions={quiz} onSubmit={onSubmit} />);
    expect(screen.getByRole("img", { name: "Pergunta 1 de 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pular" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Voltar" })).toBeNull();
    fireEvent.click(options()[0] as HTMLElement); // Postgres: no auto-advance in a questionnaire
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Avançar" }));
    expect(screen.getByRole("img", { name: "Pergunta 2 de 3" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Voltar" })).toBeTruthy();
    // skip the second question by advancing without choosing
    fireEvent.click(screen.getByRole("button", { name: "Avançar" }));
    expect(screen.getByRole("img", { name: "Pergunta 3 de 3" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Avançar" })).toBeNull();
    fireEvent.click(options()[2] as HTMLElement); // Outra resposta
    fireEvent.change(screen.getByLabelText(/Sua resposta para/), {
      target: { value: "Revisar o contrato" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enviar" }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith(
      "1. Qual banco? → Postgres\n2. Quais extras? → (pulou)\n3. Algo mais? → Revisar o contrato",
    );
  });

  it("Voltar keeps what was chosen; Pular clears the page and moves on", () => {
    const onSubmit = vi.fn();
    render(<QuestionCard questions={quiz} onSubmit={onSubmit} />);
    fireEvent.click(options()[1] as HTMLElement); // SQLite
    fireEvent.click(screen.getByRole("button", { name: "Avançar" }));
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(options()[1]?.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Pular" }));
    expect(screen.getByRole("img", { name: "Pergunta 2 de 3" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Voltar" }));
    expect(options()[1]?.getAttribute("aria-checked")).toBe("false");
  });
});

describe("QuestionCard: answered", () => {
  it("is dimmed and inert, and marks the chosen options (read back from the reply text)", () => {
    const { container } = render(
      <QuestionCard
        questions={quiz}
        answer={
          "1. Qual banco? → Postgres\n2. Quais extras? → Cache; Fila\n3. Algo mais? → (pulou)"
        }
        onSubmit={vi.fn()}
      />,
    );
    const card = screen.getByTestId("question-card");
    expect(card.getAttribute("data-state")).toBe("answered");
    expect(card.hasAttribute("inert")).toBe(true);
    expect(screen.queryByRole("button", { name: /Pular|Avançar|Enviar/ })).toBeNull();
    const on = Array.from(container.querySelectorAll(".qcard__option--on")).map(
      (o) => o.textContent,
    );
    expect(on).toEqual(["APostgres", "ACache", "BFila"]);
    expect(within(card).getAllByTestId("question-block")).toHaveLength(3);
  });

  it("answered by typing instead: dimmed, nothing marked", () => {
    const { container } = render(
      <QuestionCard questions={quiz} answer="um de escrita também" onSubmit={vi.fn()} />,
    );
    expect(screen.getByTestId("question-card").getAttribute("data-state")).toBe("answered");
    expect(container.querySelectorAll(".qcard__option--on")).toHaveLength(0);
  });

  it("a single question answered shows its chosen option", () => {
    const { container } = render(
      <QuestionCard questions={single} answer="SQLite" onSubmit={vi.fn()} />,
    );
    expect(
      Array.from(container.querySelectorAll(".qcard__option--on")).map((o) => o.textContent),
    ).toEqual(["BSQLite"]);
  });
});

describe("focus", () => {
  it("moves into the card when it appears, unless the user is typing", () => {
    const first = render(<QuestionCard questions={single} autoFocus onSubmit={vi.fn()} />);
    expect(document.activeElement).toBe(options()[0]);
    first.unmount();
    const box = document.createElement("textarea");
    document.body.append(box);
    box.focus();
    box.value = "estou escrevendo";
    expect(userIsTyping()).toBe(true);
    render(<QuestionCard questions={single} autoFocus onSubmit={vi.fn()} />);
    expect(document.activeElement).toBe(box);
    box.value = "";
    expect(userIsTyping()).toBe(false);
    box.remove();
  });
});
