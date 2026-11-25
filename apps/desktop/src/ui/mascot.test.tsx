import { createTicker, type TickerEnv } from "@suup/avatar";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Mascot, type MascotHost, MascotHostContext, type MascotProps } from "./mascot.js";

/** Um navegador de mentira: o rAF e os timers só andam quando o teste manda. */
function fakeEnv() {
  let now = 1000;
  let nextId = 1;
  const rafs = new Map<number, (ts: number) => void>();
  const timers = new Map<number, { at: number; cb: () => void }>();
  const env: TickerEnv = {
    now: () => now,
    raf(cb) {
      const id = nextId++;
      rafs.set(id, cb);
      return id;
    },
    caf: (id) => void rafs.delete(id),
    setTimer(cb, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, cb });
      return id;
    },
    clearTimer: (id) => void timers.delete(id),
    isHidden: () => false,
    onVisibilityChange: () => () => {},
    onPointerMove: () => () => {},
    onPointerLeave: () => () => {},
    observeVisible: () => () => {},
  };
  return {
    env,
    /** Passa `ms` de relógio em quadros de ~17 ms (timers vencidos disparam antes de cada um). */
    run(ms: number) {
      act(() => {
        for (let spent = 0; spent < ms; spent += 17) {
          now += 17;
          for (const [id, t] of [...timers]) {
            if (t.at <= now) {
              timers.delete(id);
              t.cb();
            }
          }
          const due = [...rafs];
          rafs.clear();
          for (const [, cb] of due) cb(now);
        }
      });
    },
  };
}

function setup(host: MascotHost = {}) {
  const clock = fakeEnv();
  const ticker = createTicker(clock.env);
  const hostValue: MascotHost = { ticker, reducedMotion: false, ...host };
  const ui = (props: Partial<MascotProps> = {}) => (
    <MascotHostContext.Provider value={hostValue}>
      <Mascot shape="leaf" color="azul" seed="bot-1" {...props} />
    </MascotHostContext.Provider>
  );
  return { clock, ticker, ui };
}

const root = (container: HTMLElement) => container.querySelector("[data-mascot]") as HTMLElement;
const circles = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("svg g > circle"));

beforeEach(() => {
  document.documentElement.removeAttribute("data-motion");
});
afterEach(() => {
  vi.useRealTimers();
  document.documentElement.removeAttribute("data-motion");
});

describe("Mascot: still image", () => {
  it("`still` draws the engine's SVG in the bot's colour and never starts an animation", () => {
    const { ticker, ui } = setup();
    const { container } = render(ui({ still: true, color: "laranja" }));
    const el = root(container);
    expect(el.dataset.mode).toBe("still");
    expect(el.dataset.mascot).toBe("leaf");
    expect(el.dataset.color).toBe("laranja");
    expect(el.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(el.innerHTML.toLowerCase()).toContain("#ff6a13");
    expect(ticker.stats().entries).toBe(0);
  });

  it("the smallest size is always a still image", () => {
    const { ticker, ui } = setup();
    const { container } = render(ui({ size: "xs" }));
    expect(root(container).dataset.mode).toBe("still");
    expect(ticker.stats().entries).toBe(0);
  });

  it("reduced motion (the app's setting): still, with the face of the state", () => {
    const { ticker, ui } = setup({ reducedMotion: true });
    const { container, rerender } = render(ui({ state: "idle" }));
    const idle = root(container).innerHTML;
    expect(root(container).dataset.mode).toBe("still");
    rerender(ui({ state: "asking" }));
    expect(root(container).dataset.state).toBe("asking");
    expect(root(container).innerHTML).not.toBe(idle);
    expect(ticker.stats().entries).toBe(0);
  });

  it("follows the app's `data-motion` live, without a host override", async () => {
    const clock = fakeEnv();
    const ticker = createTicker(clock.env);
    const { container } = render(
      <MascotHostContext.Provider value={{ ticker }}>
        <Mascot shape="leaf" color="azul" />
      </MascotHostContext.Provider>,
    );
    expect(root(container).dataset.mode).toBe("animated");
    expect(ticker.stats().entries).toBe(1);
    await act(async () => {
      document.documentElement.dataset.motion = "reduce";
      await Promise.resolve();
    });
    await waitFor(() => expect(root(container).dataset.mode).toBe("still"));
    expect(ticker.stats().entries).toBe(0);
  });
});

describe("Mascot: the colour changes while the bot is on screen (`repaint`)", () => {
  const body = (container: HTMLElement) => container.querySelector("svg > g > use");

  it("repaints the body only: the SVG, the character and its running animation stay", () => {
    const { clock, ticker, ui } = setup();
    const { container, rerender } = render(
      ui({ size: "xl", color: "branco", state: "smiling", repaint: true }),
    );
    clock.run(400);
    const svg = container.querySelector("svg");
    expect(body(container)?.getAttribute("fill")).toBe("#ffffff");
    for (const [color, fill] of [
      ["turquesa", "#13b8a6"],
      ["rosa", "#ff3d97"],
      ["marrom", "#a3683e"],
    ] as const) {
      rerender(ui({ size: "xl", color, state: "smiling", repaint: true }));
      // The very same SVG (nothing was recreated) in the new colour, still smiling and registered.
      expect(container.querySelector("svg")).toBe(svg);
      expect(body(container)?.getAttribute("fill")).toBe(fill);
      expect(root(container).dataset.color).toBe(color);
      expect(root(container).dataset.state).toBe("smiling");
      expect(ticker.stats().entries).toBe(1);
      clock.run(100);
    }
  });

  it("without `repaint` a new colour is a new character (the SVG is drawn again)", () => {
    const { clock, ui } = setup();
    const { container, rerender } = render(ui({ size: "xl", color: "azul" }));
    clock.run(200);
    const svg = container.querySelector("svg");
    rerender(ui({ size: "xl", color: "rosa" }));
    expect(container.querySelector("svg")).not.toBe(svg);
    expect(root(container).innerHTML.toLowerCase()).toContain("#ff3d97");
  });

  it("a still mascot is drawn in its colour from the start", () => {
    const { ui } = setup({ reducedMotion: true });
    const { container, rerender } = render(ui({ color: "verde", repaint: true }));
    expect(root(container).innerHTML.toLowerCase()).toContain("#12c46a");
    rerender(ui({ color: "roxo", repaint: true }));
    expect(root(container).innerHTML.toLowerCase()).toContain("#9b5cf6");
  });
});

describe("Mascot: animated", () => {
  it("`spin` turns the body once per new key and `poke` pokes it (the stage's bot)", () => {
    const { clock, ui } = setup();
    const { container, rerender } = render(
      ui({ size: "xl", breathe: false, gaze: { x: 0, y: 0 } }),
    );
    clock.run(600);
    const at = () => root(container).innerHTML;
    // Key 0 is "none yet": nothing turns.
    rerender(ui({ size: "xl", breathe: false, gaze: { x: 0, y: 0 }, spin: { key: 0, ms: 1400 } }));
    clock.run(300);
    const before = at();
    rerender(ui({ size: "xl", breathe: false, gaze: { x: 0, y: 0 }, spin: { key: 1, ms: 1400 } }));
    clock.run(300);
    expect(at()).not.toBe(before);
    // Still turning past the engine's own 0.9 s: the asked time is the one that counts.
    clock.run(600);
    const turning = at();
    clock.run(100);
    expect(at()).not.toBe(turning);
    clock.run(1500);
    const settled = at();
    clock.run(300);
    expect(at()).toBe(settled);
    rerender(
      ui({
        size: "xl",
        breathe: false,
        gaze: { x: 0, y: 0 },
        spin: { key: 1, ms: 1400 },
        poke: { key: 1, x: 0.5, y: 0 },
      }),
    );
    clock.run(60);
    expect(at()).not.toBe(settled);
  });

  it("registers in the shared ticker, moves, and leaves it on unmount", () => {
    const { clock, ticker, ui } = setup();
    const { container, unmount } = render(ui({ size: "xl", state: "thinking" }));
    expect(root(container).dataset.mode).toBe("animated");
    expect(ticker.stats().entries).toBe(1);
    // The indicator slots exist (five), hidden until a state shows them.
    expect(circles(container)).toHaveLength(5);
    const before = root(container).innerHTML;
    clock.run(2000);
    expect(root(container).innerHTML).not.toBe(before);
    expect(circles(container).some((c) => c.getAttribute("opacity") !== "0")).toBe(true);
    unmount();
    expect(ticker.stats().entries).toBe(0);
    expect(ticker.stats().looping).toBe(false);
  });

  it("a state change reaches the running avatar", () => {
    const { clock, ui } = setup();
    const { container, rerender } = render(ui({ size: "lg", state: "idle" }));
    clock.run(500);
    const idle = root(container).innerHTML;
    rerender(ui({ size: "lg", state: "asking" }));
    expect(root(container).dataset.state).toBe("asking");
    clock.run(1500);
    expect(root(container).innerHTML).not.toBe(idle);
  });

  it("works with cut-out eyes (a colour) and with painted eyes (white)", () => {
    const { clock, ui } = setup();
    for (const color of ["azul", "branco"] as const) {
      const { container, unmount } = render(ui({ size: "lg", color, state: "thinking" }));
      expect(circles(container)).toHaveLength(5);
      const before = root(container).innerHTML;
      clock.run(1500);
      expect(root(container).innerHTML).not.toBe(before);
      unmount();
    }
  });

  it("two faces of the same bot do not share mask ids", () => {
    const { ui } = setup();
    const { container } = render(
      <>
        {ui({ size: "lg", state: "idle" })}
        {ui({ size: "lg", state: "asking" })}
      </>,
    );
    const ids = Array.from(container.querySelectorAll("[id]")).map((e) => e.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("an unknown shape from an old bot still draws something", () => {
    const { ui } = setup();
    const { container } = render(ui({ shape: "inexistente" as never, still: true }));
    expect(container.querySelector("svg path")).not.toBeNull();
  });
});

describe("Mascot: done is brief", () => {
  it("shows done for a moment after the work, then rests", () => {
    vi.useFakeTimers();
    const { ui } = setup({ doneHoldMs: 3000 });
    const { container, rerender } = render(ui({ size: "lg", state: "thinking" }));
    rerender(ui({ size: "lg", state: "done" }));
    expect(root(container).dataset.state).toBe("done");
    act(() => {
      vi.advanceTimersByTime(2900);
    });
    expect(root(container).dataset.state).toBe("done");
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(root(container).dataset.state).toBe("idle");
  });

  it("a run that was already done when the face appeared is just rest", () => {
    const { ui } = setup();
    const { container, rerender } = render(ui({ size: "lg", state: "done" }));
    expect(root(container).dataset.state).toBe("idle");
    // ...but the next run that finishes is celebrated.
    rerender(ui({ size: "lg", state: "thinking" }));
    rerender(ui({ size: "lg", state: "done" }));
    expect(root(container).dataset.state).toBe("done");
  });

  it("failed stays until something else happens", () => {
    vi.useFakeTimers();
    const { ui } = setup();
    const { container } = render(ui({ size: "lg", state: "failed" }));
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(root(container).dataset.state).toBe("failed");
  });
});
