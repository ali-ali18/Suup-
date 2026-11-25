import { createPixelClock, type TickerEnv } from "@suup/avatar";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Avatar } from "./avatar.js";
import { type MascotHost, MascotHostContext } from "./mascot.js";
import { PixelMascot, type PixelMascotProps } from "./pixel-mascot.js";

/** Um navegador de mentira: o rAF só anda quando o teste manda. */
function fakeEnv() {
  let now = 1000;
  let nextId = 1;
  const rafs = new Map<number, (ts: number) => void>();
  const env: TickerEnv = {
    now: () => now,
    raf(cb) {
      const id = nextId++;
      rafs.set(id, cb);
      return id;
    },
    caf: (id) => void rafs.delete(id),
    setTimer: () => 0,
    clearTimer: () => {},
    isHidden: () => false,
    onVisibilityChange: () => () => {},
    onPointerMove: () => () => {},
    onPointerLeave: () => () => {},
    observeVisible: () => () => {},
  };
  return {
    env,
    run(ms: number) {
      act(() => {
        for (let spent = 0; spent < ms; spent += 40) {
          now += 40;
          const due = [...rafs];
          rafs.clear();
          for (const [, cb] of due) cb(now);
        }
      });
    },
  };
}

type Call = { style: string; x: number; y: number; w: number; h: number };

/** O canvas do jsdom não desenha: um contexto que anota cada retângulo pintado. */
function stubCanvas() {
  const draws: Call[][] = [];
  let current: Call[] = [];
  let fill = "";
  const ctx = {
    imageSmoothingEnabled: true,
    get fillStyle() {
      return fill;
    },
    set fillStyle(v: string) {
      fill = v;
    },
    clearRect() {
      if (current.length > 0) draws.push(current);
      current = [];
    },
    fillRect(x: number, y: number, w: number, h: number) {
      current.push({ style: fill, x, y, w, h });
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ width: 38, height: 38, top: 0, left: 0, right: 38, bottom: 38 }) as DOMRect,
  );
  return {
    ctx,
    /** Desenhos terminados mais o que está sendo desenhado. */
    all: () => (current.length > 0 ? [...draws, current] : draws),
    last: () => (current.length > 0 ? current : (draws.at(-1) ?? [])),
  };
}

function setup(host: MascotHost = {}) {
  const clock = fakeEnv();
  const pixelClock = createPixelClock(clock.env);
  const value: MascotHost = { pixelClock, reducedMotion: false, ...host };
  const ui = (props: Partial<PixelMascotProps> = {}) => (
    <MascotHostContext.Provider value={value}>
      <PixelMascot character="folha" color={null} seed="bot-1" size="md" {...props} />
    </MascotHostContext.Provider>
  );
  return { clock, pixelClock, ui };
}

const root = (c: HTMLElement) => c.querySelector("[data-mascot-style]") as HTMLElement;

beforeEach(() => {
  document.documentElement.removeAttribute("data-motion");
});
afterEach(() => {
  // Desmonta antes de soltar o canvas de mentira: o que sobra na tela não pode desenhar de verdade.
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute("data-motion");
});

describe("PixelMascot", () => {
  it("parado: desenha uma vez, em células inteiras, na cor do desenho do dono, sem registrar no relógio", () => {
    const canvas = stubCanvas();
    const { pixelClock, ui } = setup();
    const { container } = render(ui({ still: true }));
    const el = root(container);
    expect(el.dataset).toMatchObject({
      mascot: "folha",
      mascotStyle: "pixel",
      mode: "still",
      color: "original",
    });
    expect(pixelClock.stats().entries).toBe(0);
    const rects = canvas.last();
    expect(rects.length).toBeGreaterThan(5);
    expect(rects.some((r) => r.style === "#2fb36b")).toBe(true);
    for (const r of rects)
      for (const n of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(n)).toBe(true);
    // 38 px a 1x: 2 px por célula
    expect(rects.every((r) => r.h === 2)).toBe(true);
    const canvasEl = container.querySelector("canvas") as HTMLCanvasElement;
    expect(canvasEl.width).toBe(38);
    expect(canvasEl.style.imageRendering).toBe("pixelated");
  });

  it("pixel3d (opção): grade de 25, só retângulos inteiros; parado é a vista de frente", () => {
    const canvas = stubCanvas();
    const { ui } = setup();
    const { container } = render(ui({ still: true, pixel3d: true }));
    expect(root(container).dataset.pixel3d).toBe("true");
    const rects = canvas.last();
    expect(rects.length).toBeGreaterThan(5);
    for (const r of rects)
      for (const n of [r.x, r.y, r.w, r.h]) expect(Number.isInteger(n)).toBe(true);
    expect(rects.some((r) => r.style === "#2fb36b")).toBe(true);
    const canvasEl = container.querySelector("canvas") as HTMLCanvasElement;
    // 38 px a 1x: a célula do 3D tem o MESMO tamanho da do desenho plano (2 px, 38 / 19), para o
    // mascote não encolher no 3D (dono, 23/11/2026); o canvas cresce na proporção da margem do giro
    // (25 / 19) e transborda a caixa por igual.
    expect(rects.every((r) => r.h === 2)).toBe(true);
    expect(canvasEl.width).toBe(50);
  });

  it("sem a opção, não há 3D", () => {
    stubCanvas();
    const { ui } = setup();
    const { container } = render(ui({ still: true }));
    expect(root(container).dataset.pixel3d).toBeUndefined();
  });

  it("a cor do bot pinta o corpo", () => {
    const canvas = stubCanvas();
    const { ui } = setup();
    const { container } = render(ui({ still: true, color: "azul" }));
    expect(root(container).dataset.color).toBe("azul");
    const fills = new Set(canvas.last().map((r) => r.style));
    expect(fills.has("#1a84ff")).toBe(true);
    expect(fills.has("#2fb36b")).toBe(false);
  });

  it("animado: um registro no relógio compartilhado, mexe com o tempo e sai ao desmontar", () => {
    const canvas = stubCanvas();
    const { clock, pixelClock, ui } = setup();
    const { container, unmount } = render(ui({ state: "thinking", seed: "a" }));
    expect(root(container).dataset.mode).toBe("animated");
    expect(pixelClock.stats().entries).toBe(1);
    const before = canvas.all().length;
    clock.run(1400);
    expect(canvas.all().length).toBeGreaterThan(before);
    unmount();
    expect(pixelClock.stats().entries).toBe(0);
  });

  it("não redesenha quando nada mudou (muitos avatares na barra)", () => {
    const canvas = stubCanvas();
    const { clock, ui } = setup();
    render(ui({ state: "idle", seed: "a" }));
    clock.run(200);
    const n = canvas.all().length;
    clock.run(400); // ainda na espera do primeiro quadro (1400 ms), salvo a fase do id
    expect(canvas.all().length - n).toBeLessThanOrEqual(3);
  });

  it("movimento reduzido (ajuste do app): parado, sem relógio, e o estado ainda muda a pose", () => {
    const canvas = stubCanvas();
    const { pixelClock, ui } = setup({ reducedMotion: true });
    const { container, rerender } = render(ui({ state: "idle" }));
    const idle = JSON.stringify(canvas.last());
    expect(root(container).dataset.mode).toBe("still");
    rerender(ui({ state: "asking" }));
    expect(root(container).dataset.state).toBe("asking");
    expect(JSON.stringify(canvas.last())).not.toBe(idle);
    expect(pixelClock.stats().entries).toBe(0);
  });

  it("segue o `data-motion` do app ao vivo", async () => {
    stubCanvas();
    const clock = fakeEnv();
    const pixelClock = createPixelClock(clock.env);
    const { container } = render(
      <MascotHostContext.Provider value={{ pixelClock }}>
        <PixelMascot character="gato" color={null} />
      </MascotHostContext.Provider>,
    );
    expect(root(container).dataset.mode).toBe("animated");
    expect(pixelClock.stats().entries).toBe(1);
    await act(async () => {
      document.documentElement.dataset.motion = "reduce";
      await Promise.resolve();
    });
    await waitFor(() => expect(root(container).dataset.mode).toBe("still"));
    expect(pixelClock.stats().entries).toBe(0);
  });

  it("o menor tamanho é sempre imagem parada", () => {
    stubCanvas();
    const { pixelClock, ui } = setup();
    const { container } = render(ui({ size: "xs" }));
    expect(root(container).dataset.mode).toBe("still");
    expect(pixelClock.stats().entries).toBe(0);
  });

  it("dois estados só do pixel: pose 'bronca' e 'ideia'", () => {
    stubCanvas();
    const { ui } = setup({ reducedMotion: true });
    const { container } = render(ui({ pose: "scolded" }));
    expect(root(container).dataset.state).toBe("scolded");
  });
});

describe("Avatar escolhe a família", () => {
  it("avatarStyle=pixel desenha o mascote pixel; sem ele, as formas", () => {
    stubCanvas();
    const { container } = render(
      <MascotHostContext.Provider value={{ reducedMotion: true }}>
        <Avatar avatar="mascot:gato" avatarStyle="pixel" seed="b1" still />
        <Avatar avatar="mascot:gato" seed="b2" still />
        <Avatar avatar="mascot:blob" seed="b3" still />
      </MascotHostContext.Provider>,
    );
    expect(container.querySelectorAll("[data-mascot-style='pixel']")).toHaveLength(1);
    expect(
      (container.querySelector("[data-mascot-style='pixel']") as HTMLElement).dataset.mascot,
    ).toBe("gato");
    expect(container.querySelectorAll("svg")).toHaveLength(2);
  });

  it("Avatar repassa o 3D só ao mascote pixel (e as formas ignoram)", () => {
    stubCanvas();
    const { container } = render(
      <MascotHostContext.Provider value={{ reducedMotion: true }}>
        <Avatar avatar="mascot:gato" avatarStyle="pixel" pixel3d seed="b1" still />
        <Avatar avatar="mascot:gato" avatarStyle="pixel" seed="b2" still />
        <Avatar avatar="mascot:blob" pixel3d seed="b3" still />
      </MascotHostContext.Provider>,
    );
    const pixels = [...container.querySelectorAll<HTMLElement>("[data-mascot-style='pixel']")];
    expect(pixels.map((p) => p.dataset.pixel3d)).toEqual(["true", undefined]);
    expect(container.querySelectorAll("svg")).toHaveLength(1);
  });

  it("pixel sem personagem válido: o id do bot escolhe um, sempre o mesmo", () => {
    stubCanvas();
    const pick = (avatar: string | null) => {
      const { container, unmount } = render(
        <MascotHostContext.Provider value={{ reducedMotion: true }}>
          <Avatar avatar={avatar} avatarStyle="pixel" seed="bot-xyz" still />
        </MascotHostContext.Provider>,
      );
      const id = (container.querySelector("[data-mascot-style='pixel']") as HTMLElement).dataset
        .mascot;
      unmount();
      return id;
    };
    expect(pick(null)).toBe(pick("mascot:inexistente"));
    expect(pick(null)).toBeTruthy();
  });
});
