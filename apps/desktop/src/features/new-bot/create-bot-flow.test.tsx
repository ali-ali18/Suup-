import type { ModelInfo, SuupClient, ToolInfo } from "@suup/api";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Services, ServicesProvider } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { createDataStore } from "../../data/store.js";
import { Sync } from "../../data/sync.js";
import { makeBot } from "../../test-fixtures.js";
import { TipProvider } from "../../ui/tooltip.js";
import { Stage } from "../welcome/Stage.js";
import { CreateBotFlow } from "./CreateBotFlow.js";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-motion");
});
beforeEach(() => {
  // Reduced motion: the made bot goes to the app at once, nothing waits on a timer.
  document.documentElement.dataset.motion = "reduce";
  useUi.setState({ supervisorOfferBotId: null, selectedBotId: null });
});

const MODEL = { id: "m-1", name: "Modelo", provider: "p", available: true } as unknown as ModelInfo;
const TOOLS = [{ name: "shell" }, { name: "read_file" }] as unknown as ToolInfo[];
const MADE_ID = "11111111-1111-4111-8111-111111111111";

function setup() {
  const created = makeBot({ id: MADE_ID, name: "Duda" });
  const api = {
    models: { list: vi.fn(async () => [MODEL]) },
    tools: { list: vi.fn(async () => ({ items: TOOLS })) },
    bots: {
      draft: vi.fn(async () => ({ personality: "Calma e direto." })),
      create: vi.fn(async () => created),
      setDefault: vi.fn(async () => ({ ...created, isDefault: true })),
    },
  };
  const store = createDataStore();
  const sync = new Sync({ api: api as unknown as SuupClient, store });
  const services = { api, sync, data: store, mode: "local" } as unknown as Services;
  const onCreated = vi.fn();
  render(
    <TipProvider>
      <ServicesProvider services={services}>
        <Stage startsAt="create">
          <CreateBotFlow onCreated={onCreated} />
        </Stage>
      </ServicesProvider>
    </TipProvider>,
  );
  return { api, onCreated };
}

const next = () => fireEvent.click(screen.getByTestId("create-next"));
const back = () => fireEvent.click(screen.getByTestId("connect-back"));
const stageBot = () => screen.getByTestId("stage-bot");
const dots = () => screen.getByTestId("step-dots").dataset.step;
const typeName = (value: string) =>
  fireEvent.change(screen.getByLabelText("Nome do bot"), { target: { value } });
const colour = (name: string) =>
  within(screen.getByRole("radiogroup", { name: "Cor" })).getByRole("radio", { name });

describe("'Crie seu bot': three steps, one at a time", () => {
  it("starts on the looks, with no way back; each step shows its own question and dot", () => {
    setup();
    expect(screen.getByRole("heading", { name: "Como ele é?" })).toBeTruthy();
    expect(dots()).toBe("1");
    expect(screen.queryByTestId("connect-back")).toBeNull();
    expect(within(screen.getByTestId("newbot-mascots")).getAllByRole("radio")).toHaveLength(25);
    next();
    expect(screen.getByRole("heading", { name: "Como ele se chama?" })).toBeTruthy();
    expect(dots()).toBe("2");
    expect(screen.queryByTestId("create-step-look")).toBeNull();
  });

  it("the name is needed to go on; 'Voltar' goes back one step and keeps what was chosen", () => {
    setup();
    fireEvent.click(colour("Rosa"));
    next();
    const go = screen.getByTestId("create-next") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    typeName("Duda");
    expect(go.disabled).toBe(false);
    next();
    expect(screen.getByRole("heading", { name: "O que ele faz para você?" })).toBeTruthy();
    expect(dots()).toBe("3");
    back();
    expect(dots()).toBe("2");
    expect((screen.getByLabelText("Nome do bot") as HTMLInputElement).value).toBe("Duda");
    back();
    expect(dots()).toBe("1");
    expect(colour("Rosa").getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByTestId("connect-back")).toBeNull();
  });

  it("the bot of the stage IS the bot being made: its colour follows the choice", () => {
    setup();
    expect(stageBot().dataset.mode).toBe("create");
    expect(stageBot().dataset.faceColor).toBe("branco");
    fireEvent.click(colour("Turquesa"));
    expect(stageBot().dataset.faceColor).toBe("turquesa");
    fireEvent.click(colour("Marrom"));
    expect(stageBot().dataset.faceColor).toBe("marrom");
  });

  it("a colour only repaints and smiles (no hop, nothing restarts); a new shape hops", () => {
    // The reaction is a motion: this one runs with motion on.
    document.documentElement.removeAttribute("data-motion");
    setup();
    const pokes = stageBot().dataset.poke;
    fireEvent.click(colour("Rosa"));
    expect(stageBot().dataset.state).toBe("smiling");
    fireEvent.click(colour("Azul"));
    fireEvent.click(colour("Verde"));
    // Three colours in a row: still the same smile, and no hop for any of them.
    expect(stageBot().dataset.state).toBe("smiling");
    expect(stageBot().dataset.poke).toBe(pokes);
    const shapes = within(screen.getByTestId("newbot-mascots")).getAllByRole("radio");
    fireEvent.click(shapes[3] as HTMLElement);
    expect(stageBot().dataset.poke).not.toBe(pokes);
  });
});

describe("'Crie seu bot': making the bot", () => {
  async function toTheLastStep(t: ReturnType<typeof setup>) {
    await waitFor(() => expect(t.api.tools.list).toHaveBeenCalled());
    fireEvent.click(colour("Rosa"));
    next();
    typeName("Duda");
    next();
    fireEvent.change(screen.getByLabelText("O que ele faz para você?"), {
      target: { value: "Organiza a minha agenda." },
    });
    await waitFor(() =>
      expect((screen.getByTestId("first-bot-create") as HTMLButtonElement).disabled).toBe(false),
    );
  }

  it("asks the model for the personality, makes the bot with its looks and opens the app", async () => {
    const t = setup();
    await toTheLastStep(t);
    expect(screen.getByTestId("first-bot-supervisor").getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(screen.getByTestId("first-bot-create"));
    });
    await waitFor(() => expect(t.onCreated).toHaveBeenCalledTimes(1));
    expect(t.api.bots.draft).toHaveBeenCalledWith(
      expect.objectContaining({ description: "Organiza a minha agenda." }),
    );
    expect(t.api.bots.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Duda",
        description: "Organiza a minha agenda.",
        personality: "Calma e direto.",
        color: "rosa",
        modelId: "m-1",
        allowedTools: ["shell", "read_file"],
      }),
    );
    // Without the switch the team gets no supervisor now: the offer comes with the app.
    expect(t.api.bots.setDefault).not.toHaveBeenCalled();
    expect(useUi.getState().supervisorOfferBotId).toBe(MADE_ID);
  });

  it("while it creates, the button is off and busy, and a second click does not make a second bot", async () => {
    const t = setup();
    await toTheLastStep(t);
    let finish: (value: unknown) => void = () => undefined;
    const draft = t.api.bots.draft as unknown as { getMockImplementation(): unknown };
    const original = draft.getMockImplementation() as (...args: unknown[]) => Promise<unknown>;
    (
      t.api.bots.draft as unknown as { mockImplementationOnce(f: () => Promise<unknown>): void }
    ).mockImplementationOnce(
      () =>
        new Promise((done) => {
          finish = (value) => done(value);
        }),
    );
    const button = () => screen.getByTestId("first-bot-create");
    await act(async () => {
      fireEvent.click(button());
    });
    expect(button().getAttribute("aria-busy")).toBe("true");
    expect(
      button().getAttribute("aria-disabled") ?? String((button() as HTMLButtonElement).disabled),
    ).toBe("true");
    expect(button().textContent).toBe("Criando…");
    await act(async () => {
      fireEvent.click(button());
    });
    await act(async () => {
      finish(await original({ description: "x" }));
    });
    await waitFor(() => expect(t.onCreated).toHaveBeenCalledTimes(1));
    expect(t.api.bots.create).toHaveBeenCalledTimes(1);
  });

  it("with the switch on, the bot is the team's supervisor and no offer comes later", async () => {
    const t = setup();
    await toTheLastStep(t);
    fireEvent.click(screen.getByTestId("first-bot-supervisor"));
    // The switch wears the bot's colour while on.
    expect(screen.getByTestId("first-bot-supervisor").getAttribute("data-color")).toBe("rosa");
    await act(async () => {
      fireEvent.click(screen.getByTestId("first-bot-create"));
    });
    await waitFor(() => expect(t.onCreated).toHaveBeenCalledTimes(1));
    expect(t.api.bots.setDefault).toHaveBeenCalledTimes(1);
    expect(useUi.getState().supervisorOfferBotId).toBeNull();
  });

  it("the switch of a white bot is blue", () => {
    setup();
    next();
    typeName("Duda");
    next();
    expect(screen.getByTestId("first-bot-supervisor").getAttribute("data-color")).toBe("azul");
  });
});
