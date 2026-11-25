import { type BotColor, OWNER_NAME_MAX_LENGTH } from "@suup/api";
import type { ShapeId } from "@suup/avatar";

// The welcome (docs/DESIGN.md §3d): what this device remembers about it, and the timing of the
// sequence. The mark and the pending name live in `localStorage` as a convenience only: the name's
// home is the server, and it leaves this device as soon as a server is connected.

const DONE_KEY = "suup.welcomeDone";
const NAME_KEY = "suup.pendingOwnerName";
const CONNECTORS_KEY = "suup.connectorsStepDone";

/** The longest a name may be: the server's own limit (the field stops there instead of the server refusing). */
export const OWNER_NAME_MAX = OWNER_NAME_MAX_LENGTH;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // only a convenience: the welcome may come back next time
  }
}

/** The welcome was already shown on this device. */
export function welcomeDone(): boolean {
  return read(DONE_KEY) === "1";
}

export function markWelcomeDone(): void {
  write(DONE_KEY, "1");
}

/**
 * The step of the connectors (the list after the token, before "Crie seu bot") was already
 * concluded on this device: it shows once, on a new account (docs/DESIGN.md §3d). Only a convenience.
 */
export function connectorsStepDone(): boolean {
  return read(CONNECTORS_KEY) === "1";
}

export function markConnectorsStepDone(): void {
  write(CONNECTORS_KEY, "1");
}

/** Whether the entry offers the connectors list now: a server with no bot and a step not yet done. */
export function offersConnectorsStep(botCount: number): boolean {
  return botCount === 0 && !connectorsStepDone();
}

/**
 * Where the entrance goes once a server is connected (docs/DESIGN.md §3d): a server with bots goes
 * straight to the app; with none, the connectors first (once on this device), then "Crie seu bot".
 * `null` is a list that could not be read: no reason to hold the app back.
 */
export function entryAfterConnect(botCount: number | null): "connectors" | "create-bot" | "ready" {
  if (botCount === null || botCount > 0) return "ready";
  return offersConnectorsStep(botCount) ? "connectors" : "create-bot";
}

/** Back to before the welcome ("Voltar" on the connect screen): the mark and the typed name go. */
export function resetWelcome(): void {
  write(DONE_KEY, null);
  write(NAME_KEY, null);
}

/** The name typed in the welcome that no server has received yet (`null`: none). */
export function pendingOwnerName(): string | null {
  const name = read(NAME_KEY);
  return name === null || name.trim() === "" ? null : name;
}

export function setPendingOwnerName(name: string | null): void {
  write(NAME_KEY, name === null || name.trim() === "" ? null : name.trim());
}

/** What the name field gives back: trimmed, case and spaces inside kept; `null` when empty. */
export function cleanOwnerName(text: string): string | null {
  const name = text.trim();
  return name === "" ? null : name.slice(0, OWNER_NAME_MAX);
}

/** The steps of the sequence, in the order they show up. */
export const WELCOME_STEPS = ["bot", "line1", "line2", "line3", "field", "button"] as const;
export type WelcomeStep = (typeof WELCOME_STEPS)[number];

/**
 * The timing of the sequence, in ms from the start (docs/pesquisas/entrada-de-apps-reais.md,
 * "Proposta de entrada"): the bot first (400), its three unhurried looks, the lines staggered by 300
 * while it turns to the front, then the field (which takes the focus once the words are on screen)
 * and the button. All settled in about 4.2 s (under the 5 s of WCAG 2.2.2), no loop. The durations
 * of the bot, the lines and the fades come from the Material 3 and Fluent 2 tokens; the pace of the
 * looks is a design choice (owner, 24/11/2026: slower).
 */
export const WELCOME_TIMING = {
  /** The bot has entered (400 ms) and, a breath later, the gaze starts. */
  gazeStart: 500,
  /**
   * One look, start to start: an unhurried glide of the eyes (`GAZE_MOVE_MS`) and a hold on that
   * side. Owner, 24/11/2026: the engine's own spring (the one that follows the pointer) was "too
   * fast" here, so the welcome glides the gaze itself.
   */
  gazeEvery: 1300,
  /** The first line rises while the bot turns to the front. */
  firstLine: 3100,
  /** From one line to the next (the stagger). */
  lineEvery: 300,
  /** The button, after the field's own 200 ms fade. */
  buttonAfterField: 200,
  /** Typing makes the bot look at the field; this long without a key, it looks back to the front. */
  lookBackAfter: 1200,
} as const;

/** How long the eyes take to glide from one look to the next (an ease in and out). */
export const GAZE_MOVE_MS = 650;

/** The gliding of the eyes: ease in and out (smoothstep), 0 to 1. */
export function gazeEase(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/**
 * Once the bot faces the front (owner, 24/11/2026), it follows the pointer lightly while it is near:
 * within this distance of its centre, in CSS pixels...
 */
export const FOLLOW_RADIUS_PX = 320;
/** ...the eyes turn this fraction of the way to it (a hint, not a stare)... */
export const FOLLOW_GAIN = 0.35;
/** ...gliding there in this long, so a quick mouse does not jerk them. */
export const FOLLOW_MOVE_MS = 300;

/**
 * Where the eyes look for a pointer at `pointer` (page coordinates) when the bot's centre is at
 * `center`: `null` when the pointer is far (the bot looks to the front). Pure, for the tests.
 */
export function followGaze(
  center: { x: number; y: number },
  pointer: { x: number; y: number },
): { x: number; y: number } | null {
  const dx = pointer.x - center.x;
  const dy = pointer.y - center.y;
  const distance = Math.hypot(dx, dy);
  if (distance > FOLLOW_RADIUS_PX) return null;
  if (distance === 0) return { x: 0, y: 0 };
  // Direction, stronger the farther it is inside the circle (no flick right at the centre).
  const reach = Math.min(1, distance / (FOLLOW_RADIUS_PX / 2)) * FOLLOW_GAIN;
  return { x: (dx / distance) * reach, y: (dy / distance) * reach };
}

/**
 * After "Continuar" the bot dances, smiling (owner, 24/11/2026), and only then the screen changes:
 * the length of the engine's `cheering` dance (its clip `Done_B`, 1.8 s).
 */
export const WELCOME_DANCE_MS = 1800;

/**
 * The words and the field fade out (owner, 24/11/2026: "esmaecem para sair") while the bot leaves
 * for the corner; the next screen comes when they are gone. The same as `--duration-welcome-out`.
 */
export const WELCOME_EXIT_MS = 400;

export type Gaze = "left" | "right" | "front" | "field";

/** The three looks of the bot, one after the other, and the time each one starts. */
export const WELCOME_GAZE: readonly { at: number; look: Gaze }[] = [
  { at: WELCOME_TIMING.gazeStart, look: "left" },
  { at: WELCOME_TIMING.gazeStart + WELCOME_TIMING.gazeEvery, look: "right" },
  { at: WELCOME_TIMING.gazeStart + 2 * WELCOME_TIMING.gazeEvery, look: "front" },
];

/** The time each step of the text shows up. */
export const WELCOME_STEP_AT: Record<WelcomeStep, number> = {
  bot: 0,
  line1: WELCOME_TIMING.firstLine,
  line2: WELCOME_TIMING.firstLine + WELCOME_TIMING.lineEvery,
  line3: WELCOME_TIMING.firstLine + 2 * WELCOME_TIMING.lineEvery,
  field: WELCOME_TIMING.firstLine + 3 * WELCOME_TIMING.lineEvery - 50,
  button:
    WELCOME_TIMING.firstLine + 3 * WELCOME_TIMING.lineEvery - 50 + WELCOME_TIMING.buttonAfterField,
};

/** Where the engine's gaze vector points for each look (x: right, y: down; -1 to 1). */
export const GAZE_VECTOR: Record<Gaze, { x: number; y: number }> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  front: { x: 0, y: 0 },
  /** Down, at the field below it, while the person types. */
  field: { x: 0, y: 0.7 },
};

// The stage: after the dance the SAME bot goes to the right corner of the next screen (owner,
// 24/11/2026). It turns once on its own axis, smiling, and ends facing front; it grows linearly
// on the way, to a big face cut in half by the window's edge, centred in height, looking at the
// form on the left.

/**
 * How long the trip and the turn take, together, so it arrives facing front. The same as
 * `--duration-travel` (tokens.css; `design-rules.test.ts` checks both).
 */
export const STAGE_TRAVEL_MS = 1400;

/** The big bot is this much of the window's height tall (owner, 24/11/2026: half the window)... */
export const STAGE_HEIGHT_RATIO = 0.5;
/** ...never less than this much, in a window too narrow for it... */
export const STAGE_MIN_RATIO = 0.3;
/**
 * ...and its visible half stays clear of the form: the left padding of `StageForm` (1.5rem), the
 * form's column (`--width-connect`, 440 px), the gap (`STAGE_FORM_GAP_PX`) and a little air.
 */
export const STAGE_FORM_RESERVE_PX = 528;

/** On the last screens the bot follows the pointer all over the window, much stronger than the welcome's 0.35... */
export const STAGE_FOLLOW_GAIN = 0.9;
/** ...reaching its full look at this distance from its centre. */
export const STAGE_FOLLOW_REACH_PX = 240;
/** With no pointer to follow it looks at the form: to the left. */
export const STAGE_REST_GAZE = { x: -0.8, y: 0 } as const;
/** An error makes it look sorry for this long (it comes back by itself). */
export const STAGE_FAILED_MS = 2400;

export interface Size {
  width: number;
  height: number;
}

/**
 * A click on the big bot is a light touch (owner, 24/11/2026: at full strength, clicked again and
 * again, it wobbled "like a marshmallow"): this fraction of the engine's poke...
 */
export const STAGE_POKE_STRENGTH = 0.35;
/** ...and at most one every this long: quick clicks do not pile up the wobble. */
export const STAGE_POKE_EVERY_MS = 600;

/**
 * Each step of connecting (the address, then the token) lets the bot think at least this long, even
 * when the server answers at once (owner, 24/11/2026: "o nosso bot dá uma pensada").
 */
export const CONNECT_THINK_MS = 1800;

/**
 * Thinking, to the eye (owner, 24/11/2026: "o bot não muda para pensando"): the engine's own
 * `pondering` is only a glance up now and then, and the stage steers the gaze itself, so nothing
 * showed. While a step is checked the eyes go up and wander from one side to the other, and the
 * pointer is ignored.
 */
export const STAGE_THINK_LOOKS: readonly { x: number; y: number }[] = [
  { x: -0.55, y: -0.75 },
  { x: 0.35, y: -0.8 },
];
/** How long the eyes stay on each side while thinking (the glide is `GAZE_MOVE_MS`). */
export const STAGE_THINK_EVERY_MS = 800;

/** A step confirmed: the bot's eyes go wide (`surprised`) for this long (owner, 24/11/2026). */
export const STAGE_SURPRISED_MS = 1100;

/** Between the form's area and the bot's visible half. */
export const STAGE_FORM_GAP_PX = 24;

/**
 * How much of the window's right side the form leaves to the bot: its visible half and a gap. The
 * form is centred in what is left (owner, 24/11/2026: pinned to the left edge, a wide window had a
 * huge hole in the middle). Pure, for the tests.
 */
export function stageFormRight(window: Size): number {
  return Math.round(stageBotSize(window) / 2) + STAGE_FORM_GAP_PX;
}

/** The diameter of the big bot in a window of this size. Pure, for the tests. */
export function stageBotSize(window: Size): number {
  const wanted = window.height * STAGE_HEIGHT_RATIO;
  const room = 2 * (window.width - STAGE_FORM_RESERVE_PX);
  return Math.round(Math.max(window.height * STAGE_MIN_RATIO, Math.min(wanted, room)));
}

/** Where the welcome's bot sits, in window coordinates: its centre and its width. */
export interface Slot {
  cx: number;
  cy: number;
  size: number;
}

export interface StagePose {
  /** From the corner spot (the bot's centre on the right edge, halfway down), in px. */
  x: number;
  y: number;
  /** 1 in the corner; the welcome's size over the big size in the middle. */
  scale: number;
}

/**
 * The pose of the bot in each place. The bot is always laid out at its big size in the corner; the
 * welcome's pose is that box moved to the slot and shrunk to the slot's size (so the face is
 * drawn at the big size and is sharp at rest). Pure, for the tests.
 */
export function stagePose(place: StagePlace, window: Size, slot: Slot | null): StagePose {
  if (place === "corner") return { x: 0, y: 0, scale: 1 };
  // The gallery's and the creation's spots are worked out from the window; the welcome's is
  // measured on its screen.
  const spot =
    place === "gallery"
      ? galleryBotSlot(window)
      : place === "create"
        ? createLayout(window).bot
        : slot;
  if (spot === null) return { x: 0, y: 0, scale: 1 };
  return {
    x: spot.cx - window.width,
    y: spot.cy - window.height / 2,
    scale: spot.size / stageBotSize(window),
  };
}

/**
 * Where the stage's bot is: the welcome's middle, the right corner, the top of the gallery, or the
 * left side of "Crie seu bot" (the bot that is being made).
 */
export type StagePlace = "welcome" | "corner" | "gallery" | "create";

// The gallery of the connectors (docs/DESIGN.md §3d; owner, 24/11/2026): the SAME bot goes from the
// corner to the top of the screen, in the middle, medium sized, with a crew of other bots on each
// side, smaller and smaller towards the edges, all standing on the same line.

/**
 * The bot of the gallery is this much of the window's height: it grows with a tall window (owner,
 * 24/11/2026: "tem bastante altura disponível, pode preencher melhor")...
 */
export const GALLERY_BOT_RATIO = 0.2;
/** ...at most this big, and not smaller than this in a short window. */
export const GALLERY_BOT_MAX_PX = 200;
export const GALLERY_BOT_MIN_PX = 96;
/** Its top is this far from the window's top (under the strip the custom frame drags the window by). */
export const GALLERY_TOP_PX = 48;
/** The air between the bots' row and the title under it. */
export const GALLERY_HEAD_GAP_PX = 32;
/** The crew, from the bot outwards: each one this much of the gallery bot's size (smaller and smaller). */
export const GALLERY_CREW_SCALES: readonly number[] = [0.8, 0.64, 0.5];
/** The air between two bots of the row, and the least the outermost keeps from the window's edge. */
export const GALLERY_CREW_GAP_PX = 20;
export const GALLERY_EDGE_PX = 24;

/**
 * The crew: fixed, never drawn at random. One of the engine's "clean" shapes (never the bot's own
 * circle) in one colour of the app's palette each, all different. Index = `rank * 2` for the left
 * side and `rank * 2 + 1` for the right one, `rank` 0 being the nearest to the bot.
 */
export const GALLERY_CREW: readonly { shape: ShapeId; color: BotColor }[] = [
  { shape: "pebble", color: "azul" },
  { shape: "squircle", color: "rosa" },
  { shape: "hex", color: "amarelo" },
  { shape: "teardrop", color: "verde" },
  { shape: "cloud", color: "roxo" },
  { shape: "tablet", color: "laranja" },
];

/** The diameter of the gallery's bot in a window of this size. Pure, for the tests. */
export function galleryBotSize(window: Size): number {
  return Math.round(
    Math.min(GALLERY_BOT_MAX_PX, Math.max(GALLERY_BOT_MIN_PX, window.height * GALLERY_BOT_RATIO)),
  );
}

/** The gallery's spot: centred in width, at the top. */
export function galleryBotSlot(window: Size): Slot {
  const size = galleryBotSize(window);
  return { cx: window.width / 2, cy: GALLERY_TOP_PX + size / 2, size };
}

/** How much room the screen leaves at its top for the row of bots (the title starts under it). */
export function galleryHeadSpace(window: Size): number {
  return GALLERY_TOP_PX + galleryBotSize(window) + GALLERY_HEAD_GAP_PX;
}

export interface CrewPlace {
  side: "left" | "right";
  /** 0 is the nearest to the bot. */
  rank: number;
  /** Centre and diameter, in window coordinates; the base is the bot's base. */
  cx: number;
  cy: number;
  size: number;
  shape: ShapeId;
  color: BotColor;
}

/** How far the outermost of `count` bots on a side reaches from the middle (its far edge). */
function crewReach(bot: number, count: number): number {
  let reach = bot / 2;
  for (let rank = 0; rank < count; rank++) {
    reach += GALLERY_CREW_GAP_PX + bot * (GALLERY_CREW_SCALES[rank] ?? 0);
  }
  return reach;
}

/** How many bots fit on each side of the gallery bot in this width (3 in a wide window, down to 0). */
export function crewPerSide(window: Size): number {
  const bot = galleryBotSize(window);
  const room = window.width / 2 - GALLERY_EDGE_PX;
  for (let count = GALLERY_CREW_SCALES.length; count > 0; count--) {
    if (crewReach(bot, count) <= room) return count;
  }
  return 0;
}

/**
 * The crew of this window, from the middle outwards (the nearest pair first, left then right):
 * where each one stands, how big, and which shape and colour it is. Pure, for the tests.
 */
export function galleryCrew(window: Size): CrewPlace[] {
  const bot = galleryBotSize(window);
  const slot = galleryBotSlot(window);
  const base = slot.cy + bot / 2;
  const count = crewPerSide(window);
  const places: CrewPlace[] = [];
  for (let rank = 0; rank < count; rank++) {
    const size = Math.round(bot * (GALLERY_CREW_SCALES[rank] ?? 0));
    const near = crewReach(bot, rank) + GALLERY_CREW_GAP_PX;
    for (const side of ["left", "right"] as const) {
      const look = GALLERY_CREW[rank * 2 + (side === "right" ? 1 : 0)];
      if (look === undefined) continue;
      const sign = side === "left" ? -1 : 1;
      places.push({
        side,
        rank,
        cx: slot.cx + sign * (near + size / 2),
        cy: base - size / 2,
        size,
        shape: look.shape,
        color: look.color,
      });
    }
  }
  return places;
}

/**
 * The gallery's entrance, in ms from the moment the bot starts toward it (docs/pesquisas/
 * entrada-de-apps-reais.md: the biggest first and "staggering is preferred", Fluent 2; the 110 ms
 * step is a design choice): the crew comes out of the middle, one pair after the other, then the
 * title, the grid and the button rise. A bot born there (the local server) has no trip to wait for.
 */
export const GALLERY_TIMING = {
  /** The crew starts when the bot is about half way (a trip of `STAGE_TRAVEL_MS`)... */
  crewAfterTrip: 700,
  /** ...or a moment after a bot that was born there. */
  crewAfterBorn: 300,
  /** From one pair of the crew to the next, outwards. */
  crewEvery: 110,
  /** The title starts this long after the first pair of the crew. */
  headAfterCrew: 330,
  /** The grid, after the title; the button, after the grid. */
  gridAfterHead: 150,
  buttonAfterGrid: 150,
} as const;

export interface GalleryStart {
  crew: number;
  head: number;
  grid: number;
  button: number;
}

/** When each part of the gallery starts. `trip`: the bot comes from the corner. Pure, for the tests. */
export function galleryStart(trip: boolean): GalleryStart {
  const crew = trip ? GALLERY_TIMING.crewAfterTrip : GALLERY_TIMING.crewAfterBorn;
  const head = crew + GALLERY_TIMING.headAfterCrew;
  const grid = head + GALLERY_TIMING.gridAfterHead;
  return { crew, head, grid, button: grid + GALLERY_TIMING.buttonAfterGrid };
}

/** The crew follows the pointer more lightly than the bot does (this fraction of its look: a hint, not a stare). */
export const GALLERY_CREW_LOOK_GAIN = 0.75;
/** The crew's eyes while nothing draws them: a little towards the middle (the bot they stand by). */
export const GALLERY_CREW_REST_GAIN = 0.4;
/** The gallery bot's eyes at rest: a little down, at the title and the cards. */
export const GALLERY_REST_GAZE = { x: 0, y: 0.35 } as const;

/**
 * Where the eyes look for a pointer anywhere in the window (the last screens): the direction to
 * it, stronger the farther it is up to `STAGE_FOLLOW_REACH_PX`, at most `STAGE_FOLLOW_GAIN`.
 */
export function stageGaze(
  center: { x: number; y: number },
  point: { x: number; y: number },
): { x: number; y: number } {
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return { x: 0, y: 0 };
  const reach = Math.min(1, distance / STAGE_FOLLOW_REACH_PX) * STAGE_FOLLOW_GAIN;
  return { x: (dx / distance) * reach, y: (dy / distance) * reach };
}

// "Crie seu bot" (docs/DESIGN.md §3d; owner, 24/11/2026): the SAME bot of the stage becomes the bot
// the person is making. The window is two equal halves: the bot stands whole (not cut by the edge),
// centred in the left half; the panel of the step is centred in the right half.

/** The bot being made is this much of the window's height... */
export const CREATE_BOT_RATIO = 0.55;
/** ...at most this big, and not smaller than this in a short window. */
export const CREATE_BOT_MAX_PX = 520;
export const CREATE_BOT_MIN_PX = 160;
/** The panel's widest size: the same as `--width-create` (tokens.css; `design-rules.test.ts` checks both). */
export const CREATE_PANEL_PX = 560;
/** The least the bot keeps from the edge of its half. */
export const CREATE_EDGE_PX = 48;
/** With no pointer to follow it looks at the form: to the right. */
export const CREATE_REST_GAZE = { x: 0.8, y: 0 } as const;
/** A change of shape or colour makes it smile (and hop a little) for this long. */
export const CREATE_REACT_MS = 900;
/** The hop is this fraction of the engine's poke, straight up from the middle of the face. */
export const CREATE_HOP_STRENGTH = 0.3;
/** The bot is made: it celebrates this long (the engine's `cheering` dance) before the app comes. */
export const CREATE_CELEBRATE_MS = WELCOME_DANCE_MS;
/** The steps of "Crie seu bot", in order: the looks, the name, what it does. */
export const CREATE_STEPS = ["look", "name", "job"] as const;
export type CreateStep = (typeof CREATE_STEPS)[number];

/** The diameter of the bot being made in a window of this size. Pure, for the tests. */
export function createBotSize(window: Size): number {
  const room = window.width / 2 - 2 * CREATE_EDGE_PX;
  const wanted = Math.min(CREATE_BOT_MAX_PX, window.height * CREATE_BOT_RATIO, room);
  return Math.round(Math.max(CREATE_BOT_MIN_PX, wanted));
}

export interface CreateLayout {
  /** The bot's spot, in window coordinates. */
  bot: Slot;
  /** Where the right half starts: the panel is centred in the room from here to the window's edge. */
  formLeft: number;
}

/** The two halves of the window: the bot centred in the left, the panel in the right. Pure, for the tests. */
export function createLayout(window: Size): CreateLayout {
  const size = createBotSize(window);
  return {
    bot: { cx: window.width / 4, cy: window.height / 2, size },
    formLeft: window.width / 2,
  };
}

/** The step after this one (the last one stays), and the one before it (the first stays). */
export function nextCreateStep(step: CreateStep): CreateStep {
  return CREATE_STEPS[Math.min(CREATE_STEPS.length - 1, CREATE_STEPS.indexOf(step) + 1)] ?? step;
}
export function previousCreateStep(step: CreateStep): CreateStep {
  return CREATE_STEPS[Math.max(0, CREATE_STEPS.indexOf(step) - 1)] ?? step;
}
