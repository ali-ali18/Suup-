import { describe, expect, it } from "vitest";
import type { TickerEnv } from "../runtime/ticker.js";
import { AVATAR_STATES } from "../states.js";
import { createPixelCharacter, defaultPixelCharacter, PIXEL_CHARACTER_IDS } from "./character.js";
import { createPixelClock } from "./clock.js";
import { paletteFor, parseHexColor } from "./palette.js";
import { createPixelPlayer } from "./player.js";
import {
  isPixelOnlyState,
  PIXEL_ONLY_STATES,
  PIXEL_POSE_OF,
  PIXEL_POSES,
  poseOf,
} from "./states.js";
import { cubicBezier, cycleMs, sampleTimeline } from "./timeline.js";

describe("mapa de estados", () => {
  it("todo estado do app tem uma pose desenhada", () => {
    for (const state of AVATAR_STATES) expect(PIXEL_POSES).toContain(PIXEL_POSE_OF[state]);
  });

  it("as 10 poses do Figma são alcançadas (8 pelos estados do app, 2 só do pixel)", () => {
    const reached = new Set([...AVATAR_STATES.map(poseOf), ...PIXEL_ONLY_STATES.map(poseOf)]);
    expect([...reached].sort()).toEqual([...PIXEL_POSES].sort());
    expect(PIXEL_ONLY_STATES.every(isPixelOnlyState)).toBe(true);
    expect(isPixelOnlyState("idle")).toBe(false);
  });

  it("o que cada estado mostra", () => {
    expect(poseOf("idle")).toBe("parado");
    expect(poseOf("thinking")).toBe("pensando");
    expect(poseOf("working")).toBe("trabalhando");
    expect(poseOf("asking")).toBe("duvida");
    expect(poseOf("waiting")).toBe("permissao");
    expect(poseOf("done")).toBe("concluiu");
    expect(poseOf("failed")).toBe("falhou");
    expect(poseOf("paused")).toBe("pausado");
    // sem arte própria no Figma
    expect(poseOf("sleeping")).toBe("parado");
    expect(poseOf("celebrating")).toBe("concluiu");
    expect(poseOf("scolded")).toBe("bronca");
    expect(poseOf("idea")).toBe("ideia");
  });
});

describe("linha do tempo (tempos do protótipo)", () => {
  it("o ciclo de parado dura 3720 ms (1400+600, 900+600, 120+100)", () => {
    expect(cycleMs("parado")).toBe(3720);
    expect(cycleMs("pensando")).toBe(1800);
    expect(cycleMs("trabalhando")).toBe(1000);
    expect(cycleMs("pausado")).toBe(4600);
  });

  it("parado: espera, sobe um terço de célula, desce e pisca", () => {
    expect(sampleTimeline("parado", 0)).toEqual({ cells: 0, dy: 0 });
    expect(sampleTimeline("parado", 1399)).toEqual({ cells: 0, dy: 0 });
    const mid = sampleTimeline("parado", 1700);
    expect(mid.dy).toBeLessThan(0);
    expect(mid.dy).toBeGreaterThan(-4);
    expect(sampleTimeline("parado", 2000)).toEqual({ cells: 1, dy: -4 });
    expect(sampleTimeline("parado", 2899)).toEqual({ cells: 1, dy: -4 });
    expect(sampleTimeline("parado", 3500)).toEqual({ cells: 2, dy: 0 });
    expect(sampleTimeline("parado", 3619).cells).toBe(2);
    // fecha o ciclo e recomeça
    expect(sampleTimeline("parado", 3720)).toEqual({ cells: 0, dy: 0 });
    expect(sampleTimeline("parado", 3720 * 5 + 10)).toEqual({ cells: 0, dy: 0 });
  });

  it("a troca de células acontece no meio da transição", () => {
    expect(sampleTimeline("parado", 1400 + 299).cells).toBe(0);
    expect(sampleTimeline("parado", 1400 + 301).cells).toBe(1);
  });

  it("trabalhando troca de uma vez a cada 500 ms", () => {
    expect(sampleTimeline("trabalhando", 499).cells).toBe(0);
    expect(sampleTimeline("trabalhando", 500).cells).toBe(1);
    expect(sampleTimeline("trabalhando", 999).cells).toBe(1);
    expect(sampleTimeline("trabalhando", 1000).cells).toBe(0);
  });

  it("pensando acende os pontos a cada 450 + 150 ms", () => {
    expect(sampleTimeline("pensando", 100).cells).toBe(0);
    expect(sampleTimeline("pensando", 700).cells).toBe(1);
    expect(sampleTimeline("pensando", 1300).cells).toBe(2);
  });

  it("o balanço fica sempre entre 0 e -4 unidades e a curva é monótona", () => {
    for (let t = 0; t < 3720; t += 7) {
      const { dy } = sampleTimeline("parado", t);
      expect(dy).toBeLessThanOrEqual(0);
      expect(dy).toBeGreaterThanOrEqual(-4);
    }
    const ease = cubicBezier(0.42, 0, 0.58, 1);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = ease(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(ease(0.5)).toBeCloseTo(0.5, 2);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
  });
});

describe("cor", () => {
  it("sem cor do bot vale a cor do desenho do dono", () => {
    const c = createPixelCharacter({ id: "a", character: "gota" });
    expect(c.color).toBe("#377fe6");
    expect(c.tinted).toBe(false);
    expect(c.palette.eye).toBe("#ffffff");
    expect(c.palette.dark).toBe("#1b1f3b");
  });

  it("a cor do bot pinta o corpo; o resto do desenho não muda", () => {
    const c = createPixelCharacter({ id: "a", character: "gota", color: "#FF7A00" });
    expect(c.color).toBe("#ff7a00");
    expect(c.tinted).toBe(true);
    expect(c.palette.lamp).toBe("#ffd23f");
    expect(c.palette.eye).toBe("#ffffff");
  });

  it("corpo muito claro troca o olho para escuro; muito escuro, o olho fechado para claro", () => {
    expect(paletteFor("#000000", "#ffffff").eye).toBe("#1b1f3b");
    expect(paletteFor("#000000", "#0b0b0b").eyeClosed).toBe("#ffffff");
    expect(paletteFor("#000000", "#e8e8e8").eye).toBe("#1b1f3b");
    expect(paletteFor("#000000", "#2d2d2d").eye).toBe("#ffffff");
  });

  it("só aceita #rrggbb; o resto é ignorado (nada vira atributo de SVG)", () => {
    expect(parseHexColor("#12abEF")).toEqual([0x12, 0xab, 0xef]);
    for (const bad of ["red", "#12", "#12345g", '#123456"/>', "", null, undefined, "rgb(1,2,3)"])
      expect(parseHexColor(bad)).toBeNull();
    expect(createPixelCharacter({ id: "a", character: "gato", color: 'red"/>' }).tinted).toBe(
      false,
    );
  });
});

describe("personagem", () => {
  it("sem escolha, o id decide e sempre dá o mesmo", () => {
    expect(defaultPixelCharacter("bot-1")).toBe(defaultPixelCharacter("bot-1"));
    expect(PIXEL_CHARACTER_IDS).toContain(createPixelCharacter({ id: "x" }).character);
    expect(createPixelCharacter({ id: "x", character: "inexistente" }).character).toBe(
      defaultPixelCharacter("x"),
    );
  });
});

describe("player e movimento reduzido", () => {
  it("conta a pose a partir do primeiro quadro depois de mudar de estado", () => {
    const player = createPixelPlayer(createPixelCharacter({ id: "p", character: "folha" }), {
      state: "thinking",
    });
    const a = player.frameAt(10_000);
    expect(a.key).toContain("pensando|0");
    expect(player.frameAt(10_700).key).toContain("pensando|1");
    player.setState("working");
    expect(player.frameAt(50_000).key).toContain("trabalhando|0");
  });

  it("movimento reduzido: sempre a pose parada do Figma, sem balanço", () => {
    const player = createPixelPlayer(createPixelCharacter({ id: "p", character: "polvo" }), {
      state: "thinking",
      reducedMotion: true,
    });
    expect(player.animated).toBe(false);
    const a = player.frameAt(0);
    const b = player.frameAt(9999);
    expect(a).toEqual(b);
    expect(a.dyCells).toBe(0);
    expect(a.key.startsWith("s|")).toBe(true);
  });
});

/** Ambiente de mentira: relógio e rAF controlados pelo teste. */
function fakeEnv() {
  let hidden = false;
  let id = 0;
  const frames = new Map<number, (ts: number) => void>();
  const visibility: (() => void)[] = [];
  const observers = new Map<unknown, (v: boolean) => void>();
  const env: TickerEnv = {
    now: () => 0,
    raf: (cb) => {
      frames.set(++id, cb);
      return id;
    },
    caf: (n) => void frames.delete(n),
    setTimer: () => 0,
    clearTimer: () => {},
    isHidden: () => hidden,
    onVisibilityChange(cb) {
      visibility.push(cb);
      return () => visibility.splice(visibility.indexOf(cb), 1);
    },
    onPointerMove: () => () => {},
    onPointerLeave: () => () => {},
    observeVisible(el, cb) {
      observers.set(el, cb);
      return () => observers.delete(el);
    },
  };
  return {
    env,
    frames,
    run(ts: number) {
      const due = [...frames.entries()];
      frames.clear();
      for (const [, cb] of due) cb(ts);
    },
    hide(value: boolean) {
      hidden = value;
      for (const cb of [...visibility]) cb();
    },
    see(el: unknown, visible: boolean) {
      observers.get(el)?.(visible);
    },
  };
}

describe("relógio compartilhado", () => {
  it("um único laço de rAF para todos, com ~30 quadros por segundo", () => {
    const f = fakeEnv();
    const clock = createPixelClock(f.env);
    const seen: number[] = [];
    const a = clock.register({ paint: (t) => seen.push(t) });
    const b = clock.register({ paint: () => {} });
    expect(f.frames.size).toBe(1);
    f.run(100);
    f.run(110); // cedo demais: não pinta
    f.run(140);
    expect(seen).toEqual([0, 100, 140]);
    expect(clock.stats()).toEqual({ entries: 2, looping: true });
    a.unregister();
    b.unregister();
    expect(clock.stats()).toEqual({ entries: 0, looping: false });
    expect(f.frames.size).toBe(0);
  });

  it("pausa com a aba oculta e fora da tela, e volta sozinho", () => {
    const f = fakeEnv();
    const clock = createPixelClock(f.env);
    const el = {};
    let paints = 0;
    clock.register({ paint: () => paints++, element: el });
    expect(f.frames.size).toBe(1);
    f.hide(true);
    expect(f.frames.size).toBe(0);
    f.hide(false);
    expect(f.frames.size).toBe(1);
    f.see(el, false);
    f.run(100);
    const painted = paints;
    expect(f.frames.size).toBe(0);
    f.run(200);
    expect(paints).toBe(painted);
    f.see(el, true);
    expect(f.frames.size).toBe(1);
  });
});
