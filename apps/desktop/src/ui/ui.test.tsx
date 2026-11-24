import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ActionCard } from "./action-card.js";
import { EndedLine, WorkingIndicator } from "./chat-lines.js";
import { Composer } from "./composer.js";
import { UserMessage } from "./message.js";
import { Tabs } from "./primitives.js";

describe("Composer", () => {
  const type = (value: string) =>
    fireEvent.change(screen.getByLabelText("Mensagem"), { target: { value } });

  it("Enter sends and clears; Shift+Enter does not send", () => {
    const onSend = vi.fn();
    render(<Composer placeholder="Mensagem para Nova" onSend={onSend} />);
    type("olá");
    fireEvent.keyDown(screen.getByLabelText("Mensagem"), { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText("Mensagem"), { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("olá");
    expect((screen.getByLabelText("Mensagem") as HTMLTextAreaElement).value).toBe("");
  });

  it("never sends blank text: with no text there is no send button (the call ornament is in its place)", () => {
    const onSend = vi.fn();
    render(<Composer placeholder="x" onSend={onSend} />);
    type("   ");
    fireEvent.keyDown(screen.getByLabelText("Mensagem"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Enviar mensagem" })).toBeNull();
    expect(screen.getByTestId("ornament-call").getAttribute("aria-hidden")).toBe("true");
  });

  it("the send button takes the call's place when there is text, and the call comes back when it is cleared", () => {
    const onSend = vi.fn();
    render(<Composer placeholder="x" onSend={onSend} />);
    expect(screen.getByTestId("ornament-call")).toBeTruthy();
    type("oi");
    expect(screen.queryByTestId("ornament-call")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    expect(onSend).toHaveBeenCalledWith("oi");
    expect(screen.getByTestId("ornament-call")).toBeTruthy();
  });

  it("disabled: cannot type or send, and says why", () => {
    render(<Composer placeholder="x" disabled disabledReason="Bot arquivado" onSend={vi.fn()} />);
    const input = screen.getByLabelText("Mensagem") as HTMLTextAreaElement;
    expect(input.disabled).toBe(true);
    expect(input.placeholder).toBe("Bot arquivado");
  });

  it("the dictation and the call are ornaments, never buttons that pretend to work", () => {
    render(<Composer placeholder="x" onSend={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /microfone|áudio|ditar|ligar|call/i })).toBeNull();
    for (const id of ["ornament-dictation", "ornament-call"])
      expect(screen.getByTestId(id).getAttribute("aria-hidden")).toBe("true");
  });

  it("restores a draft after a failed send, but never over what is being typed", () => {
    const { rerender } = render(
      <Composer placeholder="x" onSend={vi.fn()} restore={{ text: "de volta", nonce: 1 }} />,
    );
    expect((screen.getByLabelText("Mensagem") as HTMLTextAreaElement).value).toBe("de volta");
    type("novo");
    rerender(<Composer placeholder="x" onSend={vi.fn()} restore={{ text: "outro", nonce: 2 }} />);
    expect((screen.getByLabelText("Mensagem") as HTMLTextAreaElement).value).toBe("novo");
  });
});

describe("Tabs", () => {
  it("arrow keys move between tabs and wrap around", () => {
    const onChange = vi.fn();
    render(
      <Tabs
        label="Painel"
        value="a"
        onChange={onChange}
        tabs={[
          { id: "a", label: "A" },
          { id: "b", label: "B" },
        ]}
      />,
    );
    fireEvent.keyDown(screen.getByRole("tab", { name: "A" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    fireEvent.keyDown(screen.getByRole("tab", { name: "A" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("b");
    expect(screen.getByRole("tab", { name: "B" }).getAttribute("tabindex")).toBe("-1");
  });
});

describe("messages and lines", () => {
  it("a user message has no text about delivery: the state is data, and a pending one is dimmer", () => {
    const { rerender, container } = render(<UserMessage text="oi" state="sent" />);
    expect(screen.getByTestId("message-user").getAttribute("data-state")).toBe("sent");
    expect(container.textContent).toBe("oi");
    expect(container.querySelector('[data-pending="true"]')).not.toBeNull();
    rerender(<UserMessage text="oi" state="delivered" />);
    expect(screen.getByTestId("message-user").getAttribute("data-state")).toBe("delivered");
    expect(container.querySelector('[data-pending="true"]')).toBeNull();
    expect(container.textContent).toBe("oi");
  });

  it("an ended line expands in place, with the details under it", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <EndedLine
        text="Não consegui terminar: um limite foi atingido"
        expanded={false}
        onToggle={onToggle}
      >
        <p>Origem: Limite</p>
      </EndedLine>,
    );
    const line = screen.getByTestId("ended-line");
    expect(line.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("ended-detail")).toBeNull();
    fireEvent.click(line);
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(
      <EndedLine text="Não consegui terminar: um limite foi atingido" expanded onToggle={onToggle}>
        <p>Origem: Limite</p>
      </EndedLine>,
    );
    expect(screen.getByRole("region", { name: "Detalhes da execução" }).textContent).toBe(
      "Origem: Limite",
    );
  });

  it("the working indicator is a status with the bot's face and the phrase (no dots)", () => {
    const { container, rerender } = render(
      <WorkingIndicator phrase="Pensando" activity="thinking" face={<i data-testid="face" />} />,
    );
    expect(screen.getByRole("status").textContent).toBe("Pensando…");
    expect(screen.getByTestId("face")).not.toBeNull();
    expect(container.querySelector('[data-testid="dots-dot"]')).toBeNull();
    // A pause is not "going on": no ellipsis.
    rerender(<WorkingIndicator phrase="Pausado" activity="paused" face={<i />} />);
    expect(screen.getByRole("status").textContent).toBe("Pausado");
  });

  it("leaving, it closes smoothly, is no longer announced, and says when its fade ended", () => {
    const onLeft = vi.fn();
    const { container } = render(
      <WorkingIndicator phrase="Pronto" activity="done" face={<i />} leaving onLeft={onLeft} />,
    );
    expect(screen.queryByRole("status")).toBeNull();
    const wrap = container.querySelector('[data-testid="working-wrap"]') as HTMLElement;
    expect(wrap.dataset.leaving).toBe("true");
    expect(wrap.className).toContain("grid-rows-[0fr]");
    expect(wrap.className).toContain("duration-(--duration-leave)");
    fireEvent.transitionEnd(wrap, { propertyName: "grid-template-rows" });
    expect(onLeft).not.toHaveBeenCalled();
    fireEvent.transitionEnd(wrap, { propertyName: "opacity" });
    expect(onLeft).toHaveBeenCalledOnce();
  });
});

describe("ActionCard", () => {
  const card = (over: Partial<Parameters<typeof ActionCard>[0]> = {}) => (
    <ActionCard
      icon={<span />}
      kind="Terminal"
      state="done"
      summary="Rodar o comando pnpm test"
      expanded={false}
      onToggle={() => {}}
      {...over}
    >
      <pre>saída do comando</pre>
    </ActionCard>
  );

  it("collapsed it is one row: bold kind, muted state and summary; a button with aria-expanded", () => {
    render(card());
    const row = screen.getByRole("button", { name: /Terminal/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toBe("TerminalConcluído · Rodar o comando pnpm test");
    expect(screen.queryByText("saída do comando")).toBeNull();
  });

  it("the chevron is drawn (CSS shows it only on hover and focus); a card with no details is a plain row", () => {
    const { container, rerender } = render(card());
    expect(container.querySelector('[data-testid="action-chevron"]')).not.toBeNull();
    // The expand affordance is the stacked chevrons, and the matching collapse glyph when open.
    expect(
      container.querySelector('[data-testid="action-chevron"].lucide-chevrons-up-down'),
    ).not.toBeNull();
    rerender(card({ expanded: true }));
    expect(
      container.querySelector('[data-testid="action-chevron"].lucide-chevrons-down-up'),
    ).not.toBeNull();
    expect(container.querySelector(".lucide-chevron-down, .lucide-chevron-up")).toBeNull();
    rerender(
      <ActionCard
        icon={<span />}
        kind="Segredos"
        state="done"
        stateLabel=""
        summary="Segredo X disponível"
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.querySelector('[data-testid="action-chevron"]')).toBeNull();
    expect(screen.getByTestId("action-card").textContent).toBe("SegredosSegredo X disponível");
  });

  it("clicking toggles; expanded shows a labelled region with the details in place", () => {
    const onToggle = vi.fn();
    const { rerender } = render(card({ onToggle }));
    fireEvent.click(screen.getByRole("button", { name: /Terminal/ }));
    expect(onToggle).toHaveBeenCalledOnce();
    rerender(card({ onToggle, expanded: true }));
    expect(screen.getByRole("button", { name: /Terminal/ }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const region = screen.getByRole("region", { name: /Detalhes: Terminal/ });
    expect(within(region).getByText("saída do comando")).toBeTruthy();
    expect(screen.getByTestId("action-card").contains(region)).toBe(true);
  });

  it("the three states say so in words; a running card has a spinner instead of the chevron", () => {
    const { container, rerender } = render(card({ state: "running" }));
    expect(screen.getByRole("button").textContent).toContain("Rodando · ");
    expect(container.querySelector(".animate-spin")).not.toBeNull();
    rerender(card({ state: "failed" }));
    expect(screen.getByRole("button").textContent).toContain("Falhou · ");
    expect(container.querySelector(".animate-spin")).toBeNull();
  });

  it("the variant that needs the user: title, instruction, a preview and the pills; no collapse row", () => {
    const onTake = vi.fn();
    render(
      <ActionCard
        icon={<span />}
        kind="Computador"
        state="needs-action"
        summary=""
        expanded={false}
        onToggle={() => {}}
        needsAction={{
          title: "Ação necessária",
          instruction: "Faça o login e me devolva a tela",
          preview: (
            <img alt="Tela do computador do bot" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
          ),
          actions: (
            <>
              <button type="button">Pular</button>
              <button type="button">Terminei</button>
              <button type="button" onClick={onTake}>
                Assumir
              </button>
            </>
          ),
        }}
      />,
    );
    expect(screen.getByText("Ação necessária")).toBeTruthy();
    expect(screen.getByText("Faça o login e me devolva a tela")).toBeTruthy();
    expect(screen.getByAltText("Tela do computador do bot")).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Pular",
      "Terminei",
      "Assumir",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Assumir" }));
    expect(onTake).toHaveBeenCalledOnce();
    expect(screen.getByTestId("action-card").getAttribute("data-state")).toBe("needs-action");
  });

  it("once resolved it is the ordinary collapsed row, and expanded it offers to open the computer", () => {
    render(
      <ActionCard
        icon={<span />}
        kind="Computador"
        state="done"
        summary="Faça o login no ChatGPT"
        expanded
        onToggle={() => {}}
      >
        <p>Faça o login no ChatGPT</p>
        <button type="button">Abrir computador</button>
      </ActionCard>,
    );
    expect(screen.getByRole("button", { name: /Computador/ }).textContent).toBe(
      "ComputadorConcluído · Faça o login no ChatGPT",
    );
    expect(screen.getByRole("button", { name: "Abrir computador" })).toBeTruthy();
  });
});
