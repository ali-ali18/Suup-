import type { TeamProposal } from "@suup/api";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TeamCard, type TeamCardProps } from "./team-card.js";

const noop = () => {};
const ITEMS = [
  { name: "Tutor faculdade", description: "Estudo e prazos.", personality: "Você é um tutor." },
  { name: "Finanças", description: "Contas e gastos.", personality: "Você cuida das finanças." },
  { name: "Casa", description: "Rotina de casa.", personality: "Você organiza a casa." },
];
const pending: TeamProposal = { items: ITEMS, status: "pending", created: [] };

function show(over: Partial<TeamCardProps> = {}) {
  const onDecide = vi.fn<TeamCardProps["onDecide"]>().mockResolvedValue({ ok: true });
  render(
    <TeamCard
      seed="msg-1"
      team={pending}
      botName="Principal"
      expanded={false}
      onToggle={noop}
      onDecide={onDecide}
      {...over}
    />,
  );
  return { onDecide };
}

const create = () => screen.getByTestId("team-create") as HTMLButtonElement;

describe("the team card", () => {
  it("is one decision card: a title, one light line, a row per bot, and the two buttons", () => {
    show();
    const card = screen.getByTestId("team-card");
    expect(card.getAttribute("data-state")).toBe("needs-action");
    expect(screen.getByTestId("decision-category").textContent).toBe("Equipe");
    expect(screen.getByTestId("decision-title").textContent).toBe("Montei uma equipe para você");
    expect(screen.getByTestId("decision-lede").textContent).toBe(
      "Marque os bots que quiser criar. Nada é criado sem a sua escolha.",
    );
    const rows = screen.getAllByTestId("team-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.textContent).toContain("Tutor faculdade");
    expect(rows[0]?.textContent).toContain("Estudo e prazos.");
    // A tick per row, nothing ticked at the start.
    const ticks = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(ticks).toHaveLength(3);
    expect(ticks.every((t) => !t.checked)).toBe(true);
    expect(screen.getByTestId("team-dismiss").textContent).toBe("Agora não");
    expect(create().textContent).toBe("Criar selecionados");
  });

  it("'Criar selecionados' stays off until something is ticked", () => {
    show();
    expect(create().disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Criar Finanças"));
    expect(create().disabled).toBe(false);
    fireEvent.click(screen.getByLabelText("Criar Finanças"));
    expect(create().disabled).toBe(true);
  });

  it("sends only the ticked positions, with the mascot and colour the card showed", async () => {
    const { onDecide } = show();
    fireEvent.click(screen.getByLabelText("Criar Casa"));
    fireEvent.click(screen.getByLabelText("Criar Tutor faculdade"));
    fireEvent.click(create());
    await waitFor(() => expect(onDecide).toHaveBeenCalledTimes(1));
    const body = onDecide.mock.calls[0]?.[0] as {
      create: { index: number; avatar?: string; color?: string }[];
    };
    expect(body.create.map((c) => c.index)).toEqual([0, 2]);
    for (const pick of body.create) {
      expect(pick.avatar).toMatch(/^mascot:/);
      expect(pick.color).toEqual(expect.any(String));
    }
  });

  it("the same message always shows the same looks (they come from the message, not from chance)", async () => {
    const first = show();
    fireEvent.click(screen.getByLabelText("Criar Casa"));
    fireEvent.click(create());
    await waitFor(() => expect(first.onDecide).toHaveBeenCalled());
    const body = first.onDecide.mock.calls[0]?.[0];
    document.body.innerHTML = "";
    const second = show();
    fireEvent.click(screen.getByLabelText("Criar Casa"));
    fireEvent.click(create());
    await waitFor(() => expect(second.onDecide).toHaveBeenCalled());
    expect(second.onDecide.mock.calls[0]?.[0]).toEqual(body);
  });

  it("'Agora não' sends the dismissal, and nothing is ticked on its behalf", async () => {
    const { onDecide } = show();
    fireEvent.click(screen.getByLabelText("Criar Casa"));
    fireEvent.click(screen.getByTestId("team-dismiss"));
    await waitFor(() => expect(onDecide).toHaveBeenCalledWith({ dismiss: true }));
  });

  it("is nothing optimistic: while the server has not answered the card is busy and unchanged", async () => {
    let answer: (v: { ok: true }) => void = noop;
    const onDecide = vi.fn<TeamCardProps["onDecide"]>(
      () => new Promise((resolve) => (answer = resolve)),
    );
    show({ onDecide });
    fireEvent.click(screen.getByLabelText("Criar Casa"));
    fireEvent.click(create());
    await waitFor(() => expect(create().textContent).toBe("Criando…"));
    expect(screen.getByTestId("team-card").getAttribute("aria-busy")).toBe("true");
    expect((screen.getByTestId("team-dismiss") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("team-card").getAttribute("data-state")).toBe("needs-action");
    answer({ ok: true });
    await waitFor(() =>
      expect(screen.getByTestId("team-card").getAttribute("aria-busy")).toBeNull(),
    );
  });

  it("shows the server's refusal and lets the person try again", async () => {
    const onDecide = vi
      .fn<TeamCardProps["onDecide"]>()
      .mockResolvedValue({ ok: false, message: "Esta proposta de equipe já foi decidida." });
    show({ onDecide });
    fireEvent.click(screen.getByLabelText("Criar Casa"));
    fireEvent.click(create());
    expect(await screen.findByText("Esta proposta de equipe já foi decidida.")).toBeTruthy();
    expect(create().disabled).toBe(false);
  });

  it("decided, it is one line: who was created, or that it was dismissed", () => {
    show({
      team: {
        items: ITEMS,
        status: "created",
        created: [
          { index: 0, botId: "7b4c1e2a-0000-4000-8000-000000000001" },
          { index: 2, botId: "7b4c1e2a-0000-4000-8000-000000000002" },
        ],
      },
    });
    expect(screen.getByTestId("team-card").getAttribute("data-state")).toBe("done");
    expect(screen.getByText("Criou 2 bots: Tutor faculdade, Casa")).toBeTruthy();
    expect(screen.queryByTestId("team-create")).toBeNull();
    document.body.innerHTML = "";
    show({ team: { items: ITEMS, status: "dismissed", created: [] } });
    expect(screen.getByText("Agora não")).toBeTruthy();
    expect(screen.getByTestId("team-card").getAttribute("data-state")).toBe("stopped");
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
  });
});
