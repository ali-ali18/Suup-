import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inGlyphRegion } from "./cells.js";
import { PIXEL_CHARACTER_IDS, PIXEL_CHARACTERS } from "./character.js";
import { PIXEL_ANIMATION } from "./data/animation.js";
import { PIXEL_CHARACTER_DATA, PIXEL_GRID, PIXEL_UNIT } from "./data/characters.js";
import { parseHexColor } from "./palette.js";
import { PIXEL_POSES, POSE_FIGMA_NAME } from "./states.js";

type Raw = {
  unit: number;
  margin: number;
  grid: number;
  fnv: Record<string, string>;
  fnvAnimation: string;
  characters: { id: string; body: string; base: string; d: Record<string, string> }[];
  animation: { states: Record<string, [number, number, number, string, string][]> };
};
const raw = JSON.parse(
  readFileSync(new URL("../../scripts/figma-pixel.json", import.meta.url), "utf8"),
) as Raw;

const fnv = (text: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
};

function applyDiff(base: string[], diff: string): string[] {
  const g = base.map((r) => r.split(""));
  if (diff.trim() !== "") {
    for (const tok of diff.trim().split(" ")) {
      (g[Number.parseInt(tok.charAt(1), 36)] as string[])[Number.parseInt(tok.charAt(0), 36)] =
        tok.charAt(2);
    }
  }
  return g.map((r) => r.join(""));
}

describe("dados dos mascotes pixel (desenho do dono no Figma)", () => {
  it("a grade é 19 x 19 e o pixel do Figma mede 12 (margem 4: 4 + 19 x 12 + 4 = 236)", () => {
    expect(PIXEL_GRID).toBe(19);
    expect(PIXEL_UNIT).toBe(12);
    expect(raw.grid).toBe(19);
    expect(raw.unit).toBe(12);
    expect(raw.margin * 2 + raw.grid * raw.unit).toBe(236);
  });

  it("tem os 17 personagens, nos ids e na ordem do Figma", () => {
    expect(PIXEL_CHARACTER_DATA.map((c) => c.id)).toEqual([...PIXEL_CHARACTER_IDS]);
    expect(PIXEL_CHARACTERS).toHaveLength(17);
    expect(raw.characters.map((c) => c.id.split(" ")[1])).toEqual([...PIXEL_CHARACTER_IDS]);
  });

  it("cada personagem tem as 10 poses, cada uma com 19 linhas de 19 células de letras conhecidas", () => {
    expect(PIXEL_POSES).toHaveLength(10);
    for (const c of PIXEL_CHARACTER_DATA) {
      expect(Object.keys(c.states).sort()).toEqual([...PIXEL_POSES].sort());
      for (const pose of PIXEL_POSES) {
        const rows = c.states[pose] as readonly string[];
        expect(rows, `${c.id}/${pose}`).toHaveLength(19);
        for (const row of rows) expect(row).toHaveLength(19);
        for (const ch of rows.join("")) expect("Beawlg.").toContain(ch);
      }
      expect(parseHexColor(c.body)).not.toBeNull();
    }
  });

  it("os dados gerados são exatamente o que o Figma devolveu (hash FNV calculado dentro do Figma)", () => {
    const poses = Object.values(POSE_FIGMA_NAME);
    for (const c of raw.characters) {
      const base = c.base.split("/");
      const grids = poses.map((figma) =>
        (figma === "Parado" ? base : applyDiff(base, c.d[figma] ?? "")).join("/"),
      );
      expect(fnv(grids.join("|")), c.id).toBe(raw.fnv[c.id]);
      // e o módulo gerado diz o mesmo (só o branco dentro do símbolo troca de letra: e -> w)
      const id = c.id.split(" ")[1] as string;
      const data = PIXEL_CHARACTER_DATA.find((d) => d.id === id);
      PIXEL_POSES.forEach((pose, i) => {
        const expected = (grids[i] as string)
          .split("/")
          .map((row, y) =>
            Array.from(row, (ch, x) => (inGlyphRegion(x, y) && ch === "e" ? "w" : ch)).join(""),
          );
        expect(data?.states[pose], `${id}/${pose}`).toEqual(expected);
      });
    }
  });

  it("o corpo do repouso nunca ocupa a região dos símbolos de estado", () => {
    for (const c of PIXEL_CHARACTER_DATA)
      (c.states.parado as readonly string[]).forEach((row, y) => {
        [...row].forEach((ch, x) => {
          if (inGlyphRegion(x, y)) expect(ch, `${c.id} ${x},${y}`).toBe(".");
        });
      });
  });

  it("os quadros da animação batem com o hash do Figma e tem 22 quadros em 10 estados", () => {
    const parts: string[] = [];
    for (const frames of Object.values(raw.animation.states))
      for (const f of frames) parts.push(`${f[0]}|${f[4]}`);
    expect(fnv(parts.join("#"))).toBe(raw.fnvAnimation);
    expect(parts).toHaveLength(22);
    expect(Object.keys(PIXEL_ANIMATION).sort()).toEqual([...PIXEL_POSES].sort());
    expect(
      Object.fromEntries(Object.entries(PIXEL_ANIMATION).map(([k, v]) => [k, v.length])),
    ).toEqual({
      parado: 3,
      pensando: 3,
      trabalhando: 2,
      duvida: 2,
      permissao: 2,
      concluiu: 2,
      bronca: 2,
      falhou: 2,
      pausado: 2,
      ideia: 2,
    });
  });

  it("tempos do protótipo: espera e transição de cada quadro", () => {
    const t = (pose: string) =>
      (PIXEL_ANIMATION[pose] ?? []).map((f) => [f.holdMs, f.transMs, f.ease, f.dy]);
    expect(t("parado")).toEqual([
      [1400, 600, "io", 0],
      [900, 600, "io", -4],
      [120, 100, "o", 0],
    ]);
    expect(t("pensando")).toEqual([
      [450, 150, "o", 0],
      [450, 150, "o", 0],
      [450, 150, "o", 0],
    ]);
    expect(t("trabalhando")).toEqual([
      [500, 0, "n", 0],
      [500, 0, "n", 0],
    ]);
    expect(t("pausado")).toEqual([
      [1400, 900, "io", 0],
      [1400, 900, "io", -4],
    ]);
    expect(t("ideia")).toEqual([
      [400, 150, "o", 0],
      [400, 150, "o", 0],
    ]);
  });

  it("só o quadro 3 de 'parado' pisca", () => {
    for (const [pose, frames] of Object.entries(PIXEL_ANIMATION))
      frames.forEach((f, i) => {
        expect(f.blink, `${pose}#${i + 1}`).toBe(pose === "parado" && i === 2);
      });
  });
});
