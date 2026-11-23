import { describe, expect, it } from "vitest";
import { animatedCells, animationOf, staticCells } from "./cells.js";
import { createPixelCharacter, PIXEL_CHARACTER_IDS } from "./character.js";
import { PIXEL_GRID } from "./data/characters.js";
import { colorOf, drawPixelImage, layoutPixels, type PixelCanvasContext } from "./draw.js";
import { pixelFrame3dAt, pixelStill3d, swayView, turnView } from "./frame3d.js";
import { createPixelPlayer } from "./player.js";
import {
  type PixelView,
  paletteShadeSet,
  RASTER_MARGIN,
  RASTER_SIZE,
  rasterVoxel,
  shadesOf,
} from "./raster3d.js";
import { PIXEL_POSES } from "./states.js";
import { buildVoxelModel, KIND_BODY, KIND_EMPTY, VOXEL_HALF_MAX, voxelCount } from "./voxel.js";

const FRONT: PixelView = { yaw: 0, pitch: 0 };
const DEG = Math.PI / 180;

describe("modelo de voxels", () => {
  it("cada um dos 17 personagens vira um sólido com profundidade", () => {
    expect(PIXEL_CHARACTER_IDS).toHaveLength(17);
    for (const id of PIXEL_CHARACTER_IDS) {
      const cells = staticCells(id, "parado");
      const model = buildVoxelModel(id, cells);
      let filled = 0;
      for (let y = 0; y < PIXEL_GRID; y++) {
        for (let x = 0; x < PIXEL_GRID; x++) {
          const col = y * PIXEL_GRID + x;
          const solid = cells[y]?.charAt(x) !== ".";
          expect(model.kind[col] !== KIND_EMPTY).toBe(solid);
          if (solid) {
            filled++;
            expect(model.kind[col]).toBe(KIND_BODY); // a pose parada não tem símbolo
            expect(model.half[col]).toBeGreaterThanOrEqual(1);
            expect(model.half[col]).toBeLessThanOrEqual(VOXEL_HALF_MAX);
          }
        }
      }
      // mais fundo no miolo do que na borda (volume, não lajota fina)
      expect(voxelCount(model)).toBeGreaterThan(filled * 2);
      expect(Math.max(...model.half)).toBe(VOXEL_HALF_MAX);
    }
  });

  it("o modelo é guardado por quadro (mesmo quadro, mesmo objeto)", () => {
    const cells = staticCells("gato", "parado");
    expect(buildVoxelModel("gato", cells)).toBe(buildVoxelModel("gato", cells));
  });

  it("o símbolo do estado vira plaqueta; o corpo continua corpo", () => {
    const cells = staticCells("gato", "trabalhando");
    const model = buildVoxelModel("gato", cells);
    expect(model.kind[1 * PIXEL_GRID + 12]).toBe(2);
    expect(model.half[1 * PIXEL_GRID + 12]).toBe(1);
    expect(model.kind[12 * PIXEL_GRID + 8]).toBe(KIND_BODY);
  });
});

function letterColor(letter: string, bot: ReturnType<typeof createPixelCharacter>) {
  return letter === "." ? null : colorOf(letter, bot.palette);
}

describe("vista de frente = o desenho 2D", () => {
  it("em todos os personagens e poses, pixel a pixel (cores originais, sem degraus)", () => {
    for (const id of PIXEL_CHARACTER_IDS) {
      const bot = createPixelCharacter({ id: `t-${id}`, character: id });
      for (const pose of PIXEL_POSES) {
        const cells = staticCells(id, pose);
        const img = rasterVoxel(buildVoxelModel(id, cells), bot.palette, FRONT);
        expect(img.size).toBe(RASTER_SIZE);
        for (let y = 0; y < RASTER_SIZE; y++) {
          for (let x = 0; x < RASTER_SIZE; x++) {
            const cx = x - RASTER_MARGIN;
            const cy = y - RASTER_MARGIN;
            const inside = cx >= 0 && cy >= 0 && cx < PIXEL_GRID && cy < PIXEL_GRID;
            const want = inside ? letterColor(cells[cy]?.charAt(cx) ?? ".", bot) : null;
            expect(img.pixels[y * RASTER_SIZE + x] ?? null).toBe(want);
          }
        }
      }
    }
  });

  it("também em todos os quadros animados (símbolos e piscar)", () => {
    for (const id of ["folha", "robo", "cacto"] as const) {
      const bot = createPixelCharacter({ id: `t-${id}`, character: id, color: "#1084ff" });
      for (const pose of PIXEL_POSES) {
        for (let i = 0; i < animationOf(pose).length; i++) {
          const cells = animatedCells(id, pose, i);
          const img = rasterVoxel(buildVoxelModel(id, cells), bot.palette, FRONT);
          for (let cy = 0; cy < PIXEL_GRID; cy++)
            for (let cx = 0; cx < PIXEL_GRID; cx++)
              expect(
                img.pixels[(cy + RASTER_MARGIN) * RASTER_SIZE + cx + RASTER_MARGIN] ?? null,
              ).toBe(letterColor(cells[cy]?.charAt(cx) ?? ".", bot));
        }
      }
    }
  });

  it("movimento reduzido: o jogador devolve exatamente a vista de frente", () => {
    const bot = createPixelCharacter({ id: "r", character: "polvo" });
    const player = createPixelPlayer(bot, { state: "idle", reducedMotion: true, pixel3d: true });
    const still = pixelStill3d(bot, "idle");
    expect(player.frame3dAt(0)).toEqual(still);
    expect(player.frame3dAt(1234)).toEqual(still);
    expect(still).toEqual(
      rasterVoxel(buildVoxelModel("polvo", staticCells("polvo", "parado")), bot.palette, FRONT),
    );
  });

  it("a opção fica desligada por padrão", () => {
    const bot = createPixelCharacter({ id: "r", character: "polvo" });
    expect(createPixelPlayer(bot).pixel3d).toBe(false);
  });
});

/** Raio fino em passos de 1/50 de voxel, só para conferir o raster (independente do DDA). */
function marchFilled(
  id: (typeof PIXEL_CHARACTER_IDS)[number],
  view: PixelView,
  cells: readonly string[],
) {
  const model = buildVoxelModel(id, cells);
  const cy = Math.cos(view.yaw);
  const sy = Math.sin(view.yaw);
  const cp = Math.cos(view.pitch);
  const sp = Math.sin(view.pitch);
  const m = [
    [cy, 0, sy],
    [-sp * sy, cp, sp * cy],
    [-cp * sy, -sp, cp * cy],
  ] as const;
  const filled: boolean[] = [];
  for (let j = 0; j < RASTER_SIZE; j++) {
    for (let i = 0; i < RASTER_SIZE; i++) {
      const w: [number, number] = [
        i + 0.5 - RASTER_SIZE / 2 + 0.0013,
        j + 0.5 - RASTER_SIZE / 2 + 0.0007,
      ];
      let hit = false;
      for (let z = 20; z > -20 && !hit; z -= 0.02) {
        const x = PIXEL_GRID / 2 + m[0][0] * w[0] + m[1][0] * w[1] + m[2][0] * z;
        const y = PIXEL_GRID / 2 + m[0][1] * w[0] + m[1][1] * w[1] + m[2][1] * z;
        const zz = m[0][2] * w[0] + m[1][2] * w[1] + m[2][2] * z;
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        if (ix < 0 || iy < 0 || ix >= PIXEL_GRID || iy >= PIXEL_GRID) continue;
        const col = iy * PIXEL_GRID + ix;
        const k = Math.floor(zz);
        const h = model.half[col] as number;
        hit = model.kind[col] !== KIND_EMPTY && k >= -h && k < h;
      }
      filled.push(hit);
    }
  }
  return filled;
}

describe("sem buracos", () => {
  it("todo pixel dentro da silhueta projetada está preenchido, e só eles", () => {
    const views: PixelView[] = [
      { yaw: 28 * DEG, pitch: 6 * DEG },
      { yaw: -28 * DEG, pitch: 9 * DEG },
      { yaw: 75 * DEG, pitch: 3 * DEG },
      { yaw: 135 * DEG, pitch: 6 * DEG },
      { yaw: 200 * DEG, pitch: 0 },
      { yaw: 310 * DEG, pitch: -4 * DEG },
    ];
    for (const id of ["folha", "gato", "polvo", "coruja", "cacto", "estrela"] as const) {
      const bot = createPixelCharacter({ id: "h", character: id });
      const cells = animatedCells(id, "ideia", 0);
      for (const view of views) {
        const img = rasterVoxel(buildVoxelModel(id, cells), bot.palette, view);
        const want = marchFilled(id, view, cells);
        let wrong = 0;
        for (let k = 0; k < want.length; k++) if ((img.pixels[k] !== null) !== want[k]) wrong++;
        // só raios que roçam a quina de um voxel podem divergir do passo fino
        expect(wrong, `${id} yaw ${view.yaw}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it("os olhos continuam legíveis em todo o balanço (de frente até 28 graus)", () => {
    for (const id of PIXEL_CHARACTER_IDS) {
      const bot = createPixelCharacter({ id: "e", character: id });
      const model = buildVoxelModel(id, staticCells(id, "parado"));
      for (const yaw of [-28, -14, 0, 14, 28]) {
        const img = rasterVoxel(model, bot.palette, { yaw: yaw * DEG, pitch: 6 * DEG });
        const eyes = img.pixels.filter((c) => c === bot.palette.eye).length;
        expect(eyes, `${id} ${yaw}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});

describe("sombreado só com degraus da paleta", () => {
  it("cada degrau é aritmética inteira exata sobre a cor da paleta", () => {
    const s = shadesOf("#2fb36b");
    expect(s).toEqual({
      base: "#2fb36b",
      light: "#5cc38b",
      dark: "#238851",
      deep: "#1b673e",
    });
  });

  it("nenhum pixel usa cor fora de {base, mais claro, mais escuro, o mais escuro}", () => {
    for (const color of [null, "#1084ff", "#ffffff", "#000000"]) {
      for (const id of ["folha", "gato", "robo", "cacto"] as const) {
        const bot = createPixelCharacter({ id: "p", character: id, color });
        const allowed = paletteShadeSet(bot.palette);
        for (const pose of ["parado", "ideia", "trabalhando"] as const) {
          const cells = animatedCells(id, pose, 0);
          const model = buildVoxelModel(id, cells);
          for (let yaw = -180; yaw < 180; yaw += 20) {
            const img = rasterVoxel(model, bot.palette, { yaw: yaw * DEG, pitch: 8 * DEG });
            for (const c of img.pixels) if (c !== null) expect(allowed.has(c)).toBe(true);
          }
        }
      }
    }
  });

  it("mais claro em cima e mais escuro nas laterais (nunca o contrário)", () => {
    for (const hex of ["#2fb36b", "#a8adb4", "#d94b52", "#ffd23f"]) {
      const s = shadesOf(hex);
      const sum = (h: string) =>
        [1, 3, 5].reduce((a, i) => a + Number.parseInt(h.slice(i, i + 2), 16), 0);
      expect(sum(s.light)).toBeGreaterThan(sum(s.base));
      expect(sum(s.dark)).toBeLessThan(sum(s.base));
      expect(sum(s.deep)).toBeLessThan(sum(s.dark));
    }
  });
});

describe("determinismo e movimento", () => {
  it("o mesmo quadro sai igual, sempre", () => {
    const bot = createPixelCharacter({ id: "d", character: "coruja" });
    const a = pixelFrame3dAt(bot, "thinking", 1234);
    const b = pixelFrame3dAt(
      createPixelCharacter({ id: "d", character: "coruja" }),
      "thinking",
      1234,
    );
    expect(a).toEqual(b);
  });

  it("o balanço fica entre -28 e 28 graus e o giro volta de frente", () => {
    for (let ms = 0; ms < 10000; ms += 97) {
      const v = swayView(ms, "x");
      expect(Math.abs(v.yaw)).toBeLessThanOrEqual(28 * DEG + 1e-9);
      expect(v.pitch).toBeGreaterThan(0);
    }
    expect(turnView(0, 2000)).toEqual({ yaw: 0, pitch: 0 });
    expect(turnView(2000, 2000).yaw).toBeCloseTo(2 * Math.PI, 12);
    expect(turnView(1000, 2000).yaw).toBeCloseTo(Math.PI, 12);
  });

  it("quadros vizinhos mudam pouco (sem piscar de ruído entre quadros)", () => {
    const bot = createPixelCharacter({ id: "f", character: "folha" });
    let worst = 0;
    let prev = pixelFrame3dAt(bot, "idle", 0);
    for (let ms = 33; ms < 5000; ms += 33) {
      const next = pixelFrame3dAt(bot, "idle", ms);
      let diff = 0;
      for (let k = 0; k < next.pixels.length; k++) if (next.pixels[k] !== prev.pixels[k]) diff++;
      worst = Math.max(worst, diff);
      prev = next;
    }
    expect(worst).toBeLessThan(70);
  });
});

describe("desenho no canvas", () => {
  it("só retângulos inteiros, sem suavização", () => {
    const calls = { fill: 0, bad: 0 };
    const ctx: PixelCanvasContext = {
      fillStyle: "",
      imageSmoothingEnabled: true,
      clearRect() {},
      fillRect(x, y, w, h) {
        calls.fill++;
        if (![x, y, w, h].every(Number.isInteger)) calls.bad++;
      },
    };
    const bot = createPixelCharacter({ id: "c", character: "gato" });
    const layout = layoutPixels(150, 2, RASTER_SIZE);
    expect(layout.cell).toBe(12);
    drawPixelImage(ctx, pixelFrame3dAt(bot, "idle", 500), layout);
    expect(ctx.imageSmoothingEnabled).toBe(false);
    expect(calls.fill).toBeGreaterThan(10);
    expect(calls.bad).toBe(0);
  });
});
