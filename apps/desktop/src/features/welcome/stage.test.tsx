import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CONNECT_THINK_MS,
  STAGE_FAILED_MS,
  STAGE_POKE_EVERY_MS,
  STAGE_SURPRISED_MS,
  STAGE_THINK_EVERY_MS,
  STAGE_TRAVEL_MS,
  WELCOME_DANCE_MS,
  WELCOME_EXIT_MS,
  WELCOME_STEP_AT,
} from "../../lib/welcome.js";
import { TipProvider } from "../../ui/tooltip.js";
import { ConnectScreen } from "../connect/ConnectScreen.js";
import { FirstRunScreen } from "../connect/FirstRunScreen.js";
import { Stage } from "./Stage.js";
import { WelcomeScreen } from "./WelcomeScreen.js";

const bot = () => screen.getByTestId("stage-bot");

beforeEach(() => {
  vi.useFakeTimers();
  document.documentElement.removeAttribute("data-motion");
});
afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-motion");
});

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

/** Types a name and presses "Continuar" (the field is born once the sequence has run). */
function continueWith(name: string) {
  advance(WELCOME_STEP_AT.button + 50);
  fireEvent.change(screen.getByLabelText("Como você quer ser chamado?"), {
    target: { value: name },
  });
  fireEvent.click(screen.getByTestId("welcome-continue"));
}

describe("the welcome, then the same bot goes to the corner", () => {
  it("dances smiling, then turns and travels while the words fade, then the next screen comes", () => {
    const done = vi.fn();
    render(
      <Stage startsAt="welcome">
        <WelcomeScreen onDone={done} />
      </Stage>,
    );
    // One bot, in the middle.
    expect(screen.getAllByTestId("stage-bot")).toHaveLength(1);
    expect(bot().dataset.mode).toBe("welcome");
    continueWith("Ana");
    expect(bot().dataset.state).toBe("cheering");
    expect(bot().dataset.spin).toBe("0");

    // The dance lasts its time; at the end the trip and the turn start together.
    advance(WELCOME_DANCE_MS - 1);
    expect(bot().dataset.mode).toBe("welcome");
    advance(1);
    expect(bot().dataset.mode).toBe("corner");
    expect(bot().dataset.traveling).toBe("true");
    expect(bot().dataset.spin).toBe("1");
    expect(bot().dataset.state).toBe("smiling");
    expect(bot().style.transition).toContain("scale var(--duration-travel) linear");
    expect(bot().style.transition).toContain("translate var(--duration-travel) var(--ease-bot-in)");
    // The words and the field fade out, not vanish.
    expect(screen.getByTestId("welcome").className).toContain("animate-welcome-out");
    expect(done).not.toHaveBeenCalled();

    advance(WELCOME_EXIT_MS);
    expect(done).toHaveBeenCalledWith("Ana");

    // It arrives after the same time as the turn, and stops smiling for no reason.
    advance(STAGE_TRAVEL_MS - WELCOME_EXIT_MS);
    expect(bot().dataset.traveling).toBe("false");
    expect(bot().dataset.state).toBe("idle");
    expect(screen.getAllByTestId("stage-bot")).toHaveLength(1);
  });

  it("keeps the same bot through the next screen (it does not vanish and come back)", () => {
    const tree = (inner: "welcome" | "first-run") => (
      <TipProvider>
        <Stage startsAt="welcome">
          {inner === "welcome" ? (
            <WelcomeScreen onDone={() => undefined} />
          ) : (
            <FirstRunScreen onLocal={() => undefined} onVps={() => undefined} />
          )}
        </Stage>
      </TipProvider>
    );
    const { rerender } = render(tree("welcome"));
    const before = bot();
    continueWith("Ana");
    advance(WELCOME_DANCE_MS + WELCOME_EXIT_MS);
    rerender(tree("first-run"));
    expect(bot()).toBe(before);
    expect(screen.getByTestId("first-run")).toBeTruthy();
    expect(bot().dataset.mode).toBe("corner");
  });

  it("reduced motion: no dance, no trip, no turn; the bot is already in the corner", () => {
    document.documentElement.dataset.motion = "reduce";
    const done = vi.fn();
    render(
      <Stage startsAt="welcome">
        <WelcomeScreen onDone={done} />
      </Stage>,
    );
    continueWith("Ana");
    expect(done).toHaveBeenCalledWith("Ana");
    expect(bot().dataset.mode).toBe("corner");
    expect(bot().dataset.traveling).toBe("false");
    expect(bot().dataset.spin).toBe("0");
    expect(bot().style.transition).toBe("none");
  });
});

/** Presses "Continuar" on the address and lets the bot's thinking (and the check) finish. */
async function passAddress() {
  fireEvent.click(screen.getByTestId("connect-next"));
  await act(async () => {
    vi.advanceTimersByTime(CONNECT_THINK_MS);
  });
}

describe("the bot in the corner", () => {
  const connect = (
    props: {
      busy?: boolean;
      error?: string;
      check?: (url: string) => Promise<string | undefined>;
    } = {},
  ) => (
    <TipProvider>
      <Stage startsAt="corner">
        <ConnectScreen
          initial={null}
          error={props.error}
          busy={props.busy ?? false}
          onCheckAddress={props.check ?? (async () => undefined)}
          onSubmit={() => undefined}
          onBack={() => undefined}
        />
      </Stage>
    </TipProvider>
  );

  it("is born in the corner when the welcome was already seen: no trip, smiling on hover", () => {
    render(connect());
    expect(bot().dataset.mode).toBe("corner");
    expect(bot().dataset.traveling).toBe("false");
    expect(bot().dataset.state).toBe("idle");
    fireEvent.pointerEnter(bot());
    expect(bot().dataset.state).toBe("smiling");
    fireEvent.pointerLeave(bot());
    expect(bot().dataset.state).toBe("idle");
  });

  it("a click pokes it lightly, and quick clicks do not pile up the wobble", () => {
    render(connect());
    fireEvent.click(bot(), { clientX: 10, clientY: 10 });
    fireEvent.click(bot(), { clientX: 10, clientY: 10 });
    expect(bot().dataset.poke).toBe("1");
    advance(STAGE_POKE_EVERY_MS);
    fireEvent.click(bot(), { clientX: 10, clientY: 10 });
    expect(bot().dataset.poke).toBe("2");
  });

  it("typing in a field makes it curious, and it calms down when the typing stops", () => {
    render(connect());
    fireEvent.input(screen.getByLabelText("Endereço do servidor"), { target: { value: "abc" } });
    expect(bot().dataset.state).toBe("asking");
    advance(2000);
    expect(bot().dataset.state).toBe("idle");
  });

  it("one step at a time: it thinks over the address, then asks for the token", async () => {
    const check = vi.fn(async () => undefined);
    render(connect({ check }));
    expect(screen.queryByLabelText("Token")).toBeNull();
    fireEvent.click(screen.getByTestId("connect-next"));
    expect(bot().dataset.state).toBe("pondering");
    // Thinking shows: the eyes go up and wander from one side to the other, not after the pointer.
    expect(bot().dataset.thinking).toBe("0");
    advance(STAGE_THINK_EVERY_MS);
    expect(bot().dataset.thinking).toBe("1");
    expect(check).toHaveBeenCalledWith("http://127.0.0.1:8787");
    // Even a server that answers at once leaves the bot its moment to think.
    expect(screen.queryByLabelText("Token")).toBeNull();
    await act(async () => {
      vi.advanceTimersByTime(CONNECT_THINK_MS);
    });
    expect(screen.getByLabelText("Token")).toBeTruthy();
    expect(screen.queryByLabelText("Endereço do servidor")).toBeNull();
    // Confirmed: the eyes go wide for a moment, then calm.
    expect(bot().dataset.state).toBe("surprised");
    advance(STAGE_SURPRISED_MS);
    expect(bot().dataset.state).toBe("idle");
    // The arrow goes back ONE step: to the address, not out of the screen.
    fireEvent.click(screen.getByTestId("connect-back"));
    expect(screen.getByLabelText("Endereço do servidor")).toBeTruthy();
  });

  it("goes on to the token in React's development mode too (the screen is mounted twice)", async () => {
    render(<StrictMode>{connect()}</StrictMode>);
    await passAddress();
    expect(screen.getByLabelText("Token")).toBeTruthy();
  });

  it("an address with no Suup behind it: sorry for a moment, the reason under the field, still on the address", async () => {
    render(connect({ check: async () => "Não consegui falar com o servidor." }));
    await passAddress();
    expect(screen.getByTestId("connect-error").textContent).toBe(
      "Não consegui falar com o servidor.",
    );
    expect(screen.queryByLabelText("Token")).toBeNull();
    expect(bot().dataset.state).toBe("failed");
    advance(STAGE_FAILED_MS);
    expect(bot().dataset.state).toBe("idle");
  });

  it("on the token it ponders while connecting and is sorry for a moment when it could not", async () => {
    const { rerender } = render(connect());
    await passAddress();
    rerender(connect({ busy: true }));
    expect(bot().dataset.state).toBe("pondering");
    rerender(connect({ error: "O servidor recusou o token." }));
    expect(bot().dataset.state).toBe("failed");
    expect(screen.getByLabelText("Token")).toBeTruthy();
    advance(STAGE_FAILED_MS);
    expect(bot().dataset.state).toBe("idle");
  });

  it("is the only bot of the screen: the form has no mascot of its own", () => {
    const { container } = render(connect());
    expect(container.querySelectorAll("[data-mascot]")).toHaveLength(1);
    expect(bot().querySelector("[data-mascot]")).not.toBeNull();
  });
});

describe('"Voltar" is an arrow at the top left, not a pill under "Conectar"', () => {
  it("is a round icon button named Voltar that goes back, and waits while connecting", () => {
    const back = vi.fn();
    const props = {
      initial: null,
      error: undefined,
      onCheckAddress: async () => undefined,
      onSubmit: () => undefined,
      onBack: back,
    };
    const { rerender } = render(
      <TipProvider>
        <ConnectScreen {...props} busy={false} />
      </TipProvider>,
    );
    const button = screen.getByTestId("connect-back");
    expect(button.getAttribute("aria-label")).toBe("Voltar");
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.className).toContain("absolute");
    expect(button.className).toContain("top-6");
    expect(button.className).toContain("left-6");
    // Not after the step's button.
    const submit = screen.getByRole("button", { name: "Continuar" });
    expect(submit.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    fireEvent.click(button);
    expect(back).toHaveBeenCalledTimes(1);
    rerender(
      <TipProvider>
        <ConnectScreen {...props} busy />
      </TipProvider>,
    );
    expect((screen.getByTestId("connect-back") as HTMLButtonElement).disabled).toBe(true);
  });

  it("has no arrow where there is nowhere to go back to (the first-run choice)", () => {
    render(<FirstRunScreen onLocal={() => undefined} onVps={() => undefined} />);
    expect(screen.queryByTestId("connect-back")).toBeNull();
  });
});
