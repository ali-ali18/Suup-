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
    expect(el.innerHTML.toLowerCase()).toContain("#ff6700");
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

describe("Mascot: animated", () => {
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
