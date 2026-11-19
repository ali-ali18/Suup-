import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mayTakeFocus } from "../lib/focus.js";
import { makeApproval } from "../test-fixtures.js";
import { ApprovalCard } from "./approval-card.js";
import { Composer } from "./composer.js";
import { Dialog } from "./primitives.js";
import { QuestionCard } from "./question-card.js";
import { SecretRequestCard } from "./secret-request-card.js";

// The rule (docs/DESIGN.md, "Foco"): an open modal surface (palette, dialog) keeps the focus.
// Nothing in the chat that takes the focus by itself when it appears (the composer, a decision
// card, a secure form, a question) may take it while a modal is open.

const noop = () => {};

function ModalWithField() {
  return (
    <div role="dialog" aria-modal="true" aria-label="Busca e ações">
      <input aria-label="Campo da busca" autoFocus />
    </div>
  );
}

describe("a modal surface keeps the focus when the chat appears behind it", () => {
  it("the palette's field has the focus, and the composer mounting afterwards does not take it", () => {
    render(<ModalWithField />);
    expect(document.activeElement).toBe(screen.getByLabelText("Campo da busca"));
    render(<Composer placeholder="Mensagem" onSend={noop} autoFocus />);
    expect(document.activeElement).toBe(screen.getByLabelText("Campo da busca"));
  });

  it("a decision card, a secure form and a question appearing do not take it either", () => {
    render(<ModalWithField />);
    render(
      <ApprovalCard
        approval={makeApproval()}
        botName="Ajudante"
        expanded={false}
        onToggle={noop}
        onDecide={vi.fn()}
        autoFocus
      />,
    );
    render(
      <SecretRequestCard
        name="GH_TOKEN"
        reason={null}
        botName="Ajudante"
        state="open"
        expanded={false}
        onToggle={noop}
        onSubmit={vi.fn()}
        onDecline={vi.fn()}
        autoFocus
      />,
    );
    render(
      <QuestionCard
        questions={[{ question: "Qual?", options: [{ label: "A" }, { label: "B" }] }]}
        answer={undefined}
        autoFocus
        onSubmit={noop}
      />,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Campo da busca"));
  });

  it("without a modal they still take it (the composer, the decision card)", () => {
    render(<Composer placeholder="Mensagem" onSend={noop} autoFocus />);
    expect(document.activeElement).toBe(screen.getByLabelText("Mensagem"));
    render(
      <ApprovalCard
        approval={makeApproval()}
        botName="Ajudante"
        expanded={false}
        onToggle={noop}
        onDecide={vi.fn()}
        autoFocus
      />,
    );
    expect(document.activeElement).toBe(screen.getByTestId("approval-card"));
  });

  it("a dialog (the primitive) opened over the chat takes the focus into itself", () => {
    render(<Composer placeholder="Mensagem" onSend={noop} autoFocus />);
    render(
      <Dialog title="Atalhos" onClose={noop}>
        <button type="button">Fechar</button>
      </Dialog>,
    );
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);
  });
});

describe("a dialog opened from another dialog is the modal that keeps the focus", () => {
  it("the topmost modal may take the focus, the one under it may not", () => {
    render(
      <div role="dialog" aria-modal="true" aria-label="Configurações">
        <input aria-label="Do diálogo de baixo" />
      </div>,
    );
    render(
      <div role="dialog" aria-modal="true" aria-label="Nova regra">
        <input aria-label="Da janela de cima" />
      </div>,
    );
    expect(mayTakeFocus(screen.getByLabelText("Da janela de cima"))).toBe(true);
    expect(mayTakeFocus(screen.getByLabelText("Do diálogo de baixo"))).toBe(false);
  });
});
