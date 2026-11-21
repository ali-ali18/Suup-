// Prévia em vídeo do pixel 3D, com quadros REAIS do motor (sem edição à mão).
//   pnpm exec tsc -b packages/avatar && node packages/avatar/scripts/pixel3d-preview.mjs <pasta-de-saida> [--frames-only]
// Gera quadros PNG numa tela lógica de 320 x 180 e o ffmpeg amplia 4x com vizinho mais próximo
// (1280 x 720), então cada pixel continua um quadrado nítido. Saídas: pixel3d-previa.mp4 e
// pixel3d-lado-a-lado.mp4. A pasta de saída padrão é apps/desktop/screenshots (ignorada pelo git).
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import {
  createPixelCharacter,
  pixelFrame3dAt,
  pixelFrameAt,
  pixelRuns,
  RASTER_MARGIN,
  RASTER_SIZE,
  SWAY_PITCH_DEG,
  swayView,
  turnView,
} from "../dist/index.js";

const W = 320;
const H = 180;
const FPS = 30;
const BG = [14, 16, 22];
const out =
  process.argv[2] ?? fileURLToPath(new URL("../../../apps/desktop/screenshots", import.meta.url));
const framesOnly = process.argv.includes("--frames-only");
mkdirSync(out, { recursive: true });

// ---- PNG -------------------------------------------------------------------------------------
function png(rgb, width, height) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    rgb.copy(raw, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head[8] = 8;
  head[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- tela lógica -----------------------------------------------------------------------------
function canvas() {
  const buf = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) buf.set(BG, i * 3);
  return buf;
}
function hexRgb(hex) {
  return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
}
function rect(buf, x, y, w, h, rgb) {
  for (let j = y; j < y + h; j++)
    for (let i = x; i < x + w; i++)
      if (i >= 0 && j >= 0 && i < W && j < H) buf.set(rgb, (j * W + i) * 3);
}
function drawImage(buf, image, x0, y0, scale) {
  for (let y = 0; y < image.size; y++)
    for (let x = 0; x < image.size; x++) {
      const c = image.pixels[y * image.size + x];
      if (c !== null) rect(buf, x0 + x * scale, y0 + y * scale, scale, scale, hexRgb(c));
    }
}
function draw2d(buf, character, frame, x0, y0, scale) {
  // a grade 19 x 19 fica no meio da caixa de RASTER_SIZE, como a vista de frente do 3D
  const off = RASTER_MARGIN * scale;
  const bob = Math.round(frame.dyCells * scale);
  for (const run of pixelRuns(frame.cells, character.palette))
    rect(
      buf,
      x0 + off + run.x * scale,
      y0 + off + bob + run.y * scale,
      run.width * scale,
      scale,
      hexRgb(run.color),
    );
}

// ---- fonte 3 x 5 (maiúsculas, números) ---------------------------------------------------------
const FONT = {
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  J: "001001001101010",
  K: "101101110101101",
  L: "100100100100111",
  M: "101111111101101",
  N: "110101101101101",
  O: "010101101101010",
  P: "110101110100100",
  Q: "010101101111011",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  V: "101101101101010",
  W: "101101111111101",
  X: "101101010101101",
  Y: "101101010010010",
  Z: "111001010100111",
  0: "111101101101111",
  1: "010110010010111",
  2: "110001010100111",
  3: "110001010001110",
  4: "101101111001001",
  5: "111100110001110",
  6: "011100111101111",
  7: "111001010010010",
  8: "111101111101111",
  9: "111101111001110",
  "-": "000000111000000",
  " ": "000000000000000",
  "+": "000010111010000",
};
function text(buf, str, x, y, rgb, scale = 1) {
  let cx = x;
  for (const ch of str) {
    const g = FONT[ch] ?? FONT[" "];
    for (let k = 0; k < 15; k++)
      if (g[k] === "1")
        rect(buf, cx + (k % 3) * scale, y + Math.floor(k / 3) * scale, scale, scale, rgb);
    cx += 4 * scale;
  }
}
function centered(buf, str, cx, y, rgb, scale = 1) {
  text(buf, str, Math.round(cx - (str.length * 4 * scale - scale) / 2), y, rgb, scale);
}

// ---- cenas -----------------------------------------------------------------------------------
const NAMES = ["folha", "gato", "robo", "polvo", "coruja", "cacto"];
const bots = NAMES.map((c) => createPixelCharacter({ id: `previa-${c}`, character: c }));
const WHITE = [235, 238, 245];
const GREY = [120, 128, 145];
const SCALE6 = 3; // 25 voxels x 3 = 75 pixels lógicos por personagem (300 px no vídeo), 3 x 2
const BOX = RASTER_SIZE * SCALE6;
const LEFT = Math.floor((W - 3 * BOX) / 2);

function gridScene(t) {
  const buf = canvas();
  let caption;
  let state = "idle";
  let stateT = t;
  let mode = "3d";
  let turn = null;
  if (t < 2) {
    mode = "2d";
    caption = "2D ATUAL";
  } else if (t < 5) {
    caption = "3D BALANCO";
    stateT = t - 2;
  } else if (t < 8) {
    caption = "3D GIRO 360";
    turn = turnView((t - 5) * 1000, 2600);
    stateT = t - 5;
  } else {
    const k = Math.min(3, Math.floor(t - 8));
    state = ["thinking", "working", "done", "idea"][k];
    caption = ["3D PENSANDO", "3D TRABALHANDO", "3D CONCLUIU", "3D IDEIA"][k];
    stateT = t - 8 - k;
  }
  bots.forEach((bot, i) => {
    const x0 = LEFT + (i % 3) * BOX;
    const y0 = 28 + Math.floor(i / 3) * BOX;
    const ms = stateT * 1000;
    if (mode === "2d") draw2d(buf, bot, pixelFrameAt(bot, state, ms), x0, y0, SCALE6);
    else drawImage(buf, pixelFrame3dAt(bot, state, ms, turn ?? undefined), x0, y0, SCALE6);
    centered(buf, NAMES[i].toUpperCase(), x0 + BOX / 2, y0 + BOX - 7, GREY);
  });
  centered(buf, "PIXEL 3D - PREVIA", W / 2, 4, WHITE, 2);
  centered(buf, caption, W / 2, 18, [255, 210, 63], 1);
  return buf;
}

const SCALE_BIG = 6; // 25 x 6 = 150 pixels lógicos (600 no vídeo)
function sideScene(t) {
  const buf = canvas();
  const bot = createPixelCharacter({ id: "lado-gato", character: "gato" });
  const states = ["idle", "thinking", "working", "done", "idea"];
  const k = Math.min(states.length - 1, Math.floor(t / 2));
  const ms = t * 1000;
  const state = states[k];
  const local = (t - k * 2) * 1000;
  const bx = 8;
  const by = 22;
  draw2d(buf, bot, pixelFrameAt(bot, state, local), bx, by, SCALE_BIG);
  drawImage(
    buf,
    pixelFrame3dAt(
      bot,
      state,
      local,
      t < 8 ? swayView(ms, bot.id) : turnView((t - 8) * 1000, 2000),
    ),
    W - 8 - RASTER_SIZE * SCALE_BIG,
    by,
    SCALE_BIG,
  );
  centered(buf, "2D ATUAL", bx + (RASTER_SIZE * SCALE_BIG) / 2, 8, WHITE, 2);
  centered(buf, "3D PIXEL", W - 8 - (RASTER_SIZE * SCALE_BIG) / 2, 8, [255, 210, 63], 2);
  centered(buf, state.toUpperCase(), W / 2, H - 10, GREY);
  return buf;
}

function render(name, seconds, scene) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`));
  const total = seconds * FPS;
  for (let f = 0; f < total; f++)
    writeFileSync(join(dir, `f${String(f).padStart(4, "0")}.png`), png(scene(f / FPS), W, H));
  console.log(`${total} quadros em ${dir}`);
  if (framesOnly) return;
  const file = join(out, `${name}.mp4`);
  const r = spawnSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      String(FPS),
      "-i",
      join(dir, "f%04d.png"),
      "-vf",
      "scale=1280:720:flags=neighbor,format=yuv420p",
      "-c:v",
      "libx264",
      "-crf",
      "12",
      "-preset",
      "slow",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      file,
    ],
    { stdio: "inherit" },
  );
  if (r.status !== 0) throw new Error("ffmpeg falhou");
  console.log(file);
}

render("pixel3d-previa", 12, gridScene);
render("pixel3d-lado-a-lado", 10, sideScene);
void SWAY_PITCH_DEG;
