import { describe, expect, it } from "vitest";
import { animatedCells, inGlyphRegion, staticCells } from "./cells.js";
import { createPixelCharacter, PIXEL_CHARACTER_IDS } from "./character.js";
import {
  bobPixels,
  drawPixelFrame,
  layoutPixels,
  type PixelCanvasContext,
  pixelRuns,
  pixelStillSvg,
} from "./draw.js";
import { pixelFrameAt, pixelStill } from "./frame.js";
import { PIXEL_POSES } from "./states.js";

/** Canvas de mentira: um buffer RGBA em memória, para conferir pixel por pixel. */
function bufferContext(side: number) {
  const pixels = new Array<string>(side * side).fill("");
  let fill = "";
  const calls = { fillRect: 0, nonInteger: 0 };
  const ctx: PixelCanvasContext = {
    imageSmoothingEnabled: true,
    get fillStyle() {
      return fill;
    },
    set fillStyle(v: unknown) {
      fill = String(v);
    },
    clearRect(x, y, w, h) {
      for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) pixels[j * side + i] = "";
    },
    fillRect(x, y, w, h) {
      calls.fillRect++;
      if (![x, y, w, h].every(Number.isInteger)) calls.nonInteger++;
      for (let j = y; j < y + h; j++)
        for (let i = x; i < x + w; i++)
          if (i >= 0 && j >= 0 && i < side && j < side) pixels[j * side + i] = fill;
    },
  };
  return { ctx, pixels, calls };
}

describe("escala inteira", () => {
  it("a célula é inteira e a grade fica centralizada", () => {
    expect(layoutPixels(38, 1)).toEqual({ buffer: 38, cell: 2, offset: 0, side: 38 });
    expect(layoutPixels(24, 2)).toEqual({ buffer: 48, cell: 2, offset: 5, side: 38 });
    expect(layoutPixels(28, 2.5)).toMatchObject({ buffer: 70, cell: 3, offset: 6 });
    expect(layoutPixels(16, 1)).toMatchObject({ cell: 1 });
    expect(layoutPixels(5, 1)).toMatchObject({ cell: 1, buffer: 5 });
    expect(layoutPixels(120, 2)).toMatchObject({ buffer: 240, cell: 12, offset: 6 });
    expect(layoutPixels(40, Number.NaN)).toMatchObject({ buffer: 40 });
  });

  it("o balanço é de um terço de célula, arredondado para pixels inteiros", () => {
    const frame = { cells: [], dyCells: -4 / 12, key: "k" };
    expect(bobPixels(frame, layoutPixels(114, 1))).toBe(-2);
    expect(bobPixels(frame, layoutPixels(228, 1))).toBe(-4);
    expect(bobPixels(frame, layoutPixels(38, 1))).toBe(-1);
    expect(bobPixels(frame, layoutPixels(19, 1))).toBe(0);
  });
});

describe("desenho pixel a pixel", () => {
  it("a folha parada, a 3 px por célula, sai igual à grade do Figma", () => {
    const character = createPixelCharacter({ id: "t", character: "folha" });
    const frame = pixelStill(character, "idle");
    const layout = layoutPixels(57, 1);
    const { ctx, pixels, calls } = bufferContext(layout.buffer);
    drawPixelFrame(ctx, character, frame, layout);
    expect(ctx.imageSmoothingEnabled).toBe(false);
    expect(calls.nonInteger).toBe(0);
    expect(layout.cell).toBe(3);
    const colors: Record<string, string> = { B: "#2fb36b", E: "#ffffff" };
    staticCells("folha", "parado").forEach((row, y) => {
      [...row].forEach((letter, x) => {
        for (let j = 0; j < 3; j++)
          for (let i = 0; i < 3; i++)
            expect(pixels[(y * 3 + j) * layout.buffer + x * 3 + i], `${x},${y}`).toBe(
              colors[letter] ?? "",
            );
      });
    });
    // nada além das células da grade foi pintado
    const cellsOn = staticCells("folha", "parado").join("").replaceAll(".", "").length;
    expect(cellsOn).toBe(75);
    expect(pixels.filter((p) => p !== "").length).toBe(cellsOn * 9);
  });

  it("células vizinhas da mesma cor viram uma faixa só", () => {
    const character = createPixelCharacter({ id: "t", character: "folha" });
    const runs = pixelRuns(staticCells("folha", "parado"), character.palette);
    expect(runs.find((r) => r.y === 6)).toEqual({ x: 9, y: 6, width: 2, color: "#2fb36b" });
    expect(runs.length).toBeLessThan(75);
  });

  it("o balanço desloca a grade inteira, sem sobrar linha no lugar de antes", () => {
    const character = createPixelCharacter({ id: "t", character: "folha" });
    const layout = layoutPixels(114, 1);
    const still = bufferContext(layout.buffer);
    const bob = bufferContext(layout.buffer);
    drawPixelFrame(still.ctx, character, pixelStill(character, "idle"), layout);
    drawPixelFrame(
      bob.ctx,
      character,
      { ...pixelStill(character, "idle"), dyCells: -4 / 12 },
      layout,
    );
    // 114/19 = 6 px por célula; um terço = 2 px
    expect(layout.cell).toBe(6);
    for (let y = 2; y < layout.buffer; y++)
      for (let x = 0; x < layout.buffer; x++)
        expect(bob.pixels[(y - 2) * layout.buffer + x]).toBe(still.pixels[y * layout.buffer + x]);
  });

  it("o SVG parado tem uma faixa por grupo de células, bordas nítidas e só cores da paleta", () => {
    const character = createPixelCharacter({ id: "t", character: "gato", color: "#112233" });
    const svg = pixelStillSvg(character, pixelStill(character, "done"), { size: 40 });
    expect(svg).toContain('viewBox="0 0 19 19"');
    expect(svg).toContain('shape-rendering="crispEdges"');
    expect(svg).toContain('width="40"');
    expect(svg).toContain('fill="#112233"');
    expect(svg).not.toContain("NaN");
  });
});

describe("quadros animados", () => {
  it("o quadro 1 de cada pose é o desenho estático, menos o símbolo (que cresce na animação)", () => {
    for (const id of PIXEL_CHARACTER_IDS)
      for (const pose of PIXEL_POSES) {
        const stat = staticCells(id, pose);
        const frames = [0, 1].map((i) => animatedCells(id, pose, i));
        for (const f of frames) {
          expect(f).toHaveLength(19);
          stat.forEach((row, y) => {
            [...row].forEach((ch, x) => {
              if (!inGlyphRegion(x, y)) expect(f[y]?.[x], `${id}/${pose} ${x},${y}`).toBe(ch);
            });
          });
        }
      }
  });

  it("o quadro de piscar fecha só a linha de cima de cada olho, em todos os 17", () => {
    for (const id of PIXEL_CHARACTER_IDS) {
      const open = animatedCells(id, "parado", 0);
      const blink = animatedCells(id, "parado", 2);
      let changed = 0;
      open.forEach((row, y) => {
        [...row].forEach((ch, x) => {
          const now = blink[y]?.[x];
          if (now !== ch) {
            changed++;
            expect(ch).toBe("E");
            expect(now).toBe("B");
            expect(open[y + 1]?.[x]).toBe("E");
          }
        });
      });
      expect(changed, id).toBeGreaterThan(0);
    }
  });

  it("os pontos de 'pensando' acendem em 3 quadros e o último é o desenho do dono", () => {
    const dots = (i: number) =>
      animatedCells("folha", "pensando", i).join("").split("B").length - 1;
    const body = staticCells("folha", "pensando").join("").split("B").length - 1;
    expect(dots(2)).toBe(body);
    expect(dots(0)).toBe(body - 5);
    expect(dots(1)).toBe(body - 4);
    expect(animatedCells("folha", "pensando", 2)).toEqual(staticCells("folha", "pensando"));
  });

  it("o símbolo é o mesmo em todos os personagens", () => {
    for (const pose of [
      "trabalhando",
      "duvida",
      "permissao",
      "concluiu",
      "falhou",
      "pausado",
    ] as const) {
      const glyph = (id: (typeof PIXEL_CHARACTER_IDS)[number]) =>
        animatedCells(id, pose, 0).map((row, y) =>
          [...row].map((ch, x) => (inGlyphRegion(x, y) ? ch : ".")).join(""),
        );
      for (const id of PIXEL_CHARACTER_IDS)
        expect(glyph(id), `${id}/${pose}`).toEqual(glyph("folha"));
    }
  });

  it("o quadro no tempo traz as células e o balanço do ciclo", () => {
    const c = createPixelCharacter({ id: "folha-x", character: "folha" });
    const f0 = pixelFrameAt(c, "thinking", 0);
    expect(f0.dyCells).toBe(0);
    expect(f0.cells).toEqual(animatedCells("folha", "pensando", 0));
    expect(pixelFrameAt(c, "thinking", 700).key).not.toBe(f0.key);
  });
});
