import { describe, expect, it } from "vitest";
import {
  AVATAR_COLORS,
  AVATAR_STATES,
  type AvatarRenderData,
  BODY_MORPH_STATES,
  createAvatarRuntime,
  createCharacter,
  createFrameLoop,
  createTicker,
  type FrameScheduler,
  renderStill,
  SHAPE_IDS,
  STATE_MAP,
} from "./index.js";

const COLORS = ["black", "blue", "#ff00aa", "magenta"];

describe("renderStill", () => {
  for (const shape of SHAPE_IDS) {
    it(`${shape}: well-formed SVG of the requested size with two eyes`, () => {
      for (const color of COLORS) {
        const character = createCharacter({ id: "bot-1", shape, color });
        const svg = renderStill(character, "idle", { size: 48 });
        expect(svg.startsWith("<svg ")).toBe(true);
        expect(svg.endsWith("</svg>")).toBe(true);
        expect(svg).toContain('width="48" height="48"');
        expect(svg.match(/<svg /g)).toHaveLength(1);
        expect(svg.match(/<defs>/g)).toHaveLength(1);
        // Both eyes live in one path: two closed sub-paths ("Z").
        const eyes =
          /<path d="([^"]+)" fill="(?:#000|#[0-9a-fA-F]+)"\/><\/mask>|<g mask="url\(#[^)]+-inside\)"><path d="([^"]+)"/.exec(
            svg,
          );
        const d = (eyes?.[1] ?? eyes?.[2]) as string;
        expect(d.match(/M/g)).toHaveLength(2);
        expect(svg).not.toMatch(/NaN|undefined|Infinity/);
      }
    });
  }

  it("every state yields a still", () => {
    const character = createCharacter({ id: "x" });
    for (const state of AVATAR_STATES) expect(renderStill(character, state)).toContain("<svg");
  });

  it("paintEyes: the eyes are painted, never holes (an outline around the silhouette would ring them)", () => {
    const red = createCharacter({ id: "bot-1", shape: "blob", color: "#ff3347" });
    expect(renderStill(red, "idle")).toContain("-holes");
    const painted = renderStill(red, "idle", { paintEyes: true });
    expect(painted).not.toContain("-holes");
    expect(painted).toContain(red.eyeColor);
  });
});

describe("createCharacter", () => {
  it("is stable for an id and spreads shapes and colours across ids", () => {
    const ids = Array.from({ length: 300 }, (_, i) => `bot-${i}`);
    const a = ids.map((id) => createCharacter({ id }));
    const b = ids.map((id) => createCharacter({ id }));
    expect(a).toEqual(b);
    const shapes = new Set(a.map((c) => c.shape));
    const colors = new Set(a.map((c) => c.color));
    expect(shapes.size).toBeGreaterThanOrEqual(6);
    expect(colors.size).toBeGreaterThanOrEqual(8);
  });

  it("honours explicit shape and colour id, falls back on invalid values", () => {
    const c = createCharacter({ id: "a", shape: "star", color: "blue" });
    expect(c.shape).toBe("star");
    expect(c.color).toBe(AVATAR_COLORS.find((x) => x.id === "blue")?.value);
    expect(c.colorId).toBe("blue");
    const d = createCharacter({ id: "a", shape: "nope" });
    expect(SHAPE_IDS).toContain(d.shape);
    expect(createCharacter({ id: "a", color: "#123456" }).colorId).toBeNull();
  });
});

const sequence: [number, (typeof AVATAR_STATES)[number] | null][] = Array.from(
  { length: 240 },
  (_, i) => [
    i * 16,
    i % 60 === 0 ? (AVATAR_STATES[(i / 60) % AVATAR_STATES.length] ?? null) : null,
  ],
);

function run(reducedMotion: boolean): string[] {
  const rt = createAvatarRuntime(createCharacter({ id: "det" }), { reducedMotion, breathe: true });
  return sequence.map(([t, state]) => {
    if (state) rt.setState(state);
    const f = rt.frame(t);
    return `${f.transform}|${f.body}|${f.eyes}`;
  });
}

describe("runtime", () => {
  it("every public state produces a pose", () => {
    expect(Object.keys(STATE_MAP).sort()).toEqual([...AVATAR_STATES].sort());
    for (const state of AVATAR_STATES) {
      const rt = createAvatarRuntime(createCharacter({ id: "p" }), { state });
      let f = rt.frame(0);
      for (let t = 16; t < 400; t += 16) f = rt.frame(t);
      expect(f.body.length).toBeGreaterThan(10);
      // Indicator states ("thinking", "waiting") replace the face with dots/rings.
      const indicator = f.parts.some((p) => p.opacity !== "0");
      if (indicator) expect(f.parts.some((p) => p.r !== "0")).toBe(true);
      else expect(f.eyes.match(/M/g)).toHaveLength(2);
      expect(f.parts).toHaveLength(5);
      expect(f.svg(32)).toContain('width="32"');
      expect(`${f.body}${f.eyes}${f.transform}`).not.toMatch(/NaN/);
    }
  });

  it("smiling keeps the happy face without the dance, and spin(seconds) reaches the runtime", () => {
    const smile = createAvatarRuntime(createCharacter({ id: "smile" }), { state: "smiling" });
    const idle = createAvatarRuntime(createCharacter({ id: "smile" }), { state: "idle" });
    let a = smile.frame(0);
    let b = idle.frame(0);
    for (let t = 16; t < 600; t += 16) {
      a = smile.frame(t);
      b = idle.frame(t);
    }
    expect(a.eyes).not.toBe(b.eyes);
    const turning = createAvatarRuntime(createCharacter({ id: "turn" }), { breathe: false });
    const before = turning.frame(0).body;
    turning.spin(1.2);
    let changed = false;
    for (let t = 16; t < 500; t += 16) changed = changed || turning.frame(t).body !== before;
    expect(changed).toBe(true);
  });

  it("is deterministic for the same (state, time) inputs", () => {
    expect(run(false)).toEqual(run(false));
  });

  it("two runtimes do not leak state into each other", () => {
    const solo = run(false);
    const noise = createAvatarRuntime(createCharacter({ id: "other" }), { brain: true });
    noise.setState("working");
    noise.frame(0);
    noise.frame(500);
    expect(run(false)).toEqual(solo);
  });

  it("reduced motion yields a constant frame per state", () => {
    const rt = createAvatarRuntime(createCharacter({ id: "r" }), { reducedMotion: true });
    const strip = (f: AvatarRenderData) => `${f.transform}|${f.body}|${f.eyes}`;
    const first = strip(rt.frame(0));
    for (let t = 16; t < 5000; t += 250) expect(strip(rt.frame(t))).toBe(first);
    rt.setState("thinking");
    rt.poke();
    const thinking = strip(rt.frame(6000));
    expect(strip(rt.frame(9000))).toBe(thinking);
  });

  it("animated frames change over time (breathing / blinking)", () => {
    const rt = createAvatarRuntime(createCharacter({ id: "m" }), { breathe: true });
    const seen = new Set<string>();
    for (let t = 0; t < 6000; t += 16) seen.add(rt.frame(t).transform + rt.frame(t).eyes);
    expect(seen.size).toBeGreaterThan(5);
  });

  it("ignores non-advancing and huge time jumps", () => {
    const rt = createAvatarRuntime(createCharacter({ id: "j" }));
    const a = rt.frame(1000).body;
    expect(rt.frame(900).body).toBe(a);
    expect(rt.frame(1000).body).toBe(a);
    expect(`${rt.frame(1e9).body}`).not.toMatch(/NaN/);
  });
});

describe("frame loop", () => {
  it("drives a runtime through an injected scheduler and stops", () => {
    let pending: ((t: number) => void) | null = null;
    const schedule: FrameScheduler = (cb) => {
      pending = cb;
      return () => {
        pending = null;
      };
    };
    const rt = createAvatarRuntime(createCharacter({ id: "l" }), { breathe: true });
    const frames: AvatarRenderData[] = [];
    const loop = createFrameLoop(rt, schedule, (d) => frames.push(d));
    loop.start();
    for (let t = 0; t < 3000; t += 16) (pending as ((t: number) => void) | null)?.(t);
    expect(frames.length).toBeGreaterThan(0);
    loop.stop();
    expect(pending).toBeNull();
  });
});

describe("runtime in the shared ticker", () => {
  it("tickerEntry hands every ticker frame to the host as render data", () => {
    let ts = 1000;
    const pending: { cb: ((ts: number) => void) | null } = { cb: null };
    const ticker = createTicker({
      now: () => ts,
      raf(cb) {
        pending.cb = cb;
        return 1;
      },
      caf: () => {
        pending.cb = null;
      },
      setTimer: () => 1,
      clearTimer: () => {},
      isHidden: () => false,
      onVisibilityChange: () => () => {},
      onPointerMove: () => () => {},
      onPointerLeave: () => () => {},
      observeVisible: () => () => {},
    });
    const runtime = createAvatarRuntime(createCharacter({ id: "tk" }));
    const seen: AvatarRenderData[] = [];
    const handle = ticker.register({
      ...runtime.tickerEntry((data) => seen.push(data)),
      follow: "off",
      getCenter: () => null,
    });
    // Registering applies the resting pose at once.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toMatch(/^M/);
    handle.interact(() => runtime.setState("thinking"));
    for (let i = 0; i < 20; i++) {
      ts += 17;
      const cb = pending.cb;
      pending.cb = null;
      cb?.(ts);
    }
    expect(seen.length).toBeGreaterThan(1);
    handle.unregister();
    runtime.dispose();
  });
});

describe("the states of the chat's live avatar (they keep the face)", () => {
  it("pondering, reading and coding never turn the body into an indicator", () => {
    for (const state of ["pondering", "reading", "coding"] as const) {
      expect(AVATAR_STATES).toContain(state);
      expect(BODY_MORPH_STATES).not.toContain(state);
    }
  });

  it("each has its own look: reading and coding change the eyes of working; pondering keeps the face", () => {
    const c = createCharacter({ id: "chat", shape: "blob" });
    const working = renderStill(c, "working");
    expect(renderStill(c, "reading")).not.toBe(working);
    expect(renderStill(c, "coding")).not.toBe(working);
    expect(renderStill(c, "coding")).not.toBe(renderStill(c, "reading"));
    // thinking turns the body into the dots indicator; pondering keeps the face (two eyes, no dots)
    const rt = createAvatarRuntime(c, { state: "pondering", brain: true });
    let f = rt.frame(0);
    for (let t = 16; t < 2000; t += 16) f = rt.frame(t);
    expect(f.parts.every((p) => p.opacity === "0")).toBe(true);
    expect(f.eyes.split("M").length - 1).toBe(2);
  });
});
