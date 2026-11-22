// Gera `src/pixel/data/characters.ts` e `src/pixel/data/animation.ts` a partir de
// `scripts/figma-pixel.json` (o desenho do dono no Figma, extraído por `figma-extract.figma.js`).
// Uso: `node packages/avatar/scripts/gen-pixel-data.mjs`. Sem dependências e sem regex.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const raw = JSON.parse(readFileSync(here("./figma-pixel.json"), "utf8"));
const N = raw.grid;
if (N !== 19 || raw.unit !== 12 || raw.margin !== 4) throw new Error("grade inesperada");

const NAMES = {
  folha: "Folha",
  xicara: "Xícara",
  gota: "Gota",
  nuvem: "Nuvem",
  brasa: "Brasa",
  gato: "Gato",
  broto: "Broto",
  estrela: "Estrela",
  cogumelo: "Cogumelo",
  polvo: "Polvo",
  robo: "Robô",
  urso: "Urso",
  coruja: "Coruja",
  lua: "Lua",
  fantasma: "Fantasma",
  raposa: "Raposa",
  cacto: "Cacto",
};
// Nome do estado no Figma -> id sem acento usado no código.
const STATE_IDS = {
  Parado: "parado",
  Pensando: "pensando",
  Trabalhando: "trabalhando",
  "Com dúvida": "duvida",
  "Pedindo permissão": "permissao",
  Concluiu: "concluiu",
  "Levou bronca": "bronca",
  Falhou: "falhou",
  Pausado: "pausado",
  "Teve uma ideia": "ideia",
};
const ORDER = Object.keys(STATE_IDS);

/** Os símbolos de estado ficam nesta região (linhas 0-5 a partir da coluna 7; linhas 0-9 a partir da 15). */
const inGlyph = (x, y) => (y <= 5 && x >= 7) || (y <= 9 && x >= 15);

const toRows = (s) => s.split("/");
function applyDiff(rows, diff) {
  const g = rows.map((r) => r.split(""));
  if (diff.trim() !== "") {
    for (const tok of diff.trim().split(" ")) {
      g[Number.parseInt(tok[1], 36)][Number.parseInt(tok[0], 36)] = tok[2];
    }
  }
  return g.map((r) => r.join(""));
}
/** Dentro da região do símbolo o branco é detalhe do símbolo ("w"), não olho. */
function normalizeStatic(rows) {
  return rows.map((row, y) =>
    row
      .split("")
      .map((ch, x) => (inGlyph(x, y) && ch === "e" ? "w" : ch))
      .join(""),
  );
}

const fnv = (s) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
};

const characters = raw.characters.map((c) => {
  const id = c.id.split(" ")[1];
  const base = toRows(c.base);
  const rawGrids = ORDER.map((fig) =>
    (fig === "Parado" ? base : applyDiff(base, c.d[fig] ?? "")).join("/"),
  );
  if (fnv(rawGrids.join("|")) !== raw.fnv[c.id])
    throw new Error(`${id}: hash diferente do que o Figma devolveu`);
  if (base.length !== N || base.some((r) => r.length !== N)) throw new Error(`${id}: grade torta`);
  const states = {};
  for (const fig of ORDER) {
    const rows = fig === "Parado" ? base : applyDiff(base, c.d[fig] ?? "");
    states[STATE_IDS[fig]] = normalizeStatic(rows);
  }
  return { id, name: NAMES[id], body: `#${c.body}`, states };
});

// Animação (quadros da folha) -> camada do símbolo por quadro e quadro de piscar.
const leaf = characters.find((c) => c.id === raw.animation.character);
const glyphOnly = (rows) =>
  rows.map((row, y) =>
    row
      .split("")
      .map((ch, x) => {
        if (!inGlyph(x, y)) return ".";
        return ch === "e" ? "w" : ch === "E" ? "a" : ch;
      })
      .join(""),
  );
const outside = (rows) =>
  rows.map((row, y) =>
    row
      .split("")
      .map((ch, x) => (inGlyph(x, y) ? "." : ch))
      .join(""),
  );
/** Regra de piscar: a linha de cima de cada olho vira corpo (o quadro 3 da folha, generalizado). */
function blinkRows(rows) {
  const g = rows.map((r) => r.split(""));
  for (let y = 0; y < N - 1; y++)
    for (let x = 0; x < N; x++)
      if (!inGlyph(x, y) && rows[y][x] === "e" && rows[y + 1][x] === "e") g[y][x] = "B";
  return g.map((r) => r.join(""));
}
const animHash = [];
for (const fig of ORDER)
  for (const f of raw.animation.states[fig]) animHash.push(`${f[0]}|${f[4]}`);
if (fnv(animHash.join("#")) !== raw.fnvAnimation)
  throw new Error("quadros da animação diferem do Figma");
const animation = {};
for (const fig of ORDER) {
  const staticRows = leaf.states[STATE_IDS[fig]];
  const frames = raw.animation.states[fig].map(([dy, holdMs, transMs, ease, rowsText], i) => {
    const rows = toRows(rowsText).map((r) => r.split("E").join("a"));
    const sameBody = outside(rows).join("/") === outside(staticRows).join("/");
    const blink = !sameBody;
    if (blink) {
      const expected = outside(blinkRows(staticRows)).join("/");
      if (outside(rows).join("/") !== expected)
        throw new Error(`${fig} quadro ${i + 1}: o piscar da folha não bate com a regra`);
    }
    return { dy, holdMs, transMs, ease, glyph: glyphOnly(rows), blink };
  });
  // O símbolo do estado parado (Figma) tem de ser um dos quadros da animação.
  const stat = glyphOnly(staticRows).join("/");
  if (!frames.some((f) => f.glyph.join("/") === stat))
    throw new Error(
      `${fig}: o símbolo estático não aparece em nenhum quadro\n${stat}\n${frames.map((f) => f.glyph.join("/")).join("\n")}`,
    );
  animation[STATE_IDS[fig]] = frames;
}
// Nenhum personagem tem corpo na região do símbolo no repouso.
for (const c of characters)
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++)
      if (inGlyph(x, y) && c.states.parado[y][x] !== ".")
        throw new Error(`${c.id}: corpo na região do símbolo`);

const HEADER =
  "// GERADO por `packages/avatar/scripts/gen-pixel-data.mjs` a partir de `scripts/figma-pixel.json`\n// (desenho do dono no Figma, arquivo c1FraH70ehfVHADeOXKspp). Não edite à mão: rode o script.\n";
const json = (v) => JSON.stringify(v, null, 2);

writeFileSync(
  here("../src/pixel/data/characters.ts"),
  `${HEADER}
/** Lado da grade (células) e tamanho do pixel no Figma (unidades). */
export const PIXEL_GRID = ${N};
export const PIXEL_UNIT = ${raw.unit};

export type PixelCharacterData = {
  id: string;
  name: string;
  /** Cor do corpo no desenho do dono. */
  body: string;
  /** Uma grade de ${N} linhas por estado. B corpo, e olho (ou branco), a escuro, l lâmpada, . vazio. */
  states: Readonly<Record<string, readonly string[]>>;
};

export const PIXEL_CHARACTER_DATA: readonly PixelCharacterData[] = ${json(characters)};
`,
);
writeFileSync(
  here("../src/pixel/data/animation.ts"),
  `${HEADER}
export type PixelEase = "io" | "o" | "n";

export type PixelAnimFrame = {
  /** Deslocamento vertical do sprite no Figma (unidades; -4 = sobe um terço de célula). */
  dy: number;
  /** Quanto o quadro fica parado antes de a transição começar (ms). */
  holdMs: number;
  /** Duração da transição para o próximo quadro (ms); 0 troca de uma vez. */
  transMs: number;
  /** Curva da transição: io = ease in-out, o = ease out, n = nenhuma. */
  ease: PixelEase;
  /** O símbolo do estado neste quadro (só a região do símbolo; B = pontos na cor do corpo, w = branco). */
  glyph: readonly string[];
  /** Olhos piscando neste quadro. */
  blink: boolean;
};

export const PIXEL_ANIMATION: Readonly<Record<string, readonly PixelAnimFrame[]>> = ${json(animation)};
`,
);
console.log(`ok: ${characters.length} personagens, ${Object.keys(animation).length} estados`);
