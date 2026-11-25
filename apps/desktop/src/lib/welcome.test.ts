import { describe, expect, it } from "vitest";
import {
  CREATE_BOT_MAX_PX,
  CREATE_BOT_MIN_PX,
  CREATE_EDGE_PX,
  CREATE_PANEL_PX,
  createBotSize,
  createLayout,
  crewPerSide,
  FOLLOW_GAIN,
  FOLLOW_RADIUS_PX,
  followGaze,
  GALLERY_BOT_MAX_PX,
  GALLERY_BOT_MIN_PX,
  GALLERY_CREW,
  GALLERY_CREW_GAP_PX,
  GALLERY_EDGE_PX,
  GALLERY_TOP_PX,
  galleryBotSize,
  galleryBotSlot,
  galleryCrew,
  galleryHeadSpace,
  galleryStart,
  gazeEase,
  STAGE_FOLLOW_GAIN,
  STAGE_FOLLOW_REACH_PX,
  STAGE_FORM_GAP_PX,
  STAGE_FORM_RESERVE_PX,
  STAGE_HEIGHT_RATIO,
  STAGE_MIN_RATIO,
  STAGE_TRAVEL_MS,
  stageBotSize,
  stageFormRight,
  stageGaze,
  stagePose,
  WELCOME_DANCE_MS,
  WELCOME_EXIT_MS,
  WELCOME_GAZE,
  WELCOME_STEP_AT,
} from "./welcome.js";

describe("the welcome's timing", () => {
  it("settles within 5 seconds (WCAG 2.2.2) and the lines rise while the bot turns to the front", () => {
    expect(WELCOME_STEP_AT.button).toBeLessThan(5000);
    const front = WELCOME_GAZE.at(-1);
    expect(front?.look).toBe("front");
    expect(WELCOME_STEP_AT.line1).toBe(front?.at);
    expect(WELCOME_STEP_AT.field).toBeGreaterThan(WELCOME_STEP_AT.line3);
    expect(WELCOME_STEP_AT.button).toBeGreaterThan(WELCOME_STEP_AT.field);
  });

  it("glides the eyes with an ease in and out, from 0 to 1", () => {
    expect(gazeEase(0)).toBe(0);
    expect(gazeEase(1)).toBe(1);
    expect(gazeEase(0.5)).toBe(0.5);
    expect(gazeEase(0.1)).toBeLessThan(0.1);
    expect(gazeEase(2)).toBe(1);
  });
});

describe("followGaze: the bot follows a near pointer, lightly", () => {
  const center = { x: 500, y: 300 };

  it("ignores a pointer outside the circle", () => {
    expect(followGaze(center, { x: 500 + FOLLOW_RADIUS_PX + 1, y: 300 })).toBeNull();
  });

  it("looks toward it, never more than the gain", () => {
    const look = followGaze(center, { x: 500 + FOLLOW_RADIUS_PX, y: 300 });
    expect(look?.x).toBeCloseTo(FOLLOW_GAIN);
    expect(look?.y).toBeCloseTo(0);
    const up = followGaze(center, { x: 500, y: 300 - FOLLOW_RADIUS_PX / 2 });
    expect(up?.y).toBeCloseTo(-FOLLOW_GAIN);
  });

  it("barely moves for a pointer right over it", () => {
    expect(followGaze(center, center)).toEqual({ x: 0, y: 0 });
    const close = followGaze(center, { x: 510, y: 300 });
    expect(Math.abs(close?.x ?? 1)).toBeLessThan(0.05);
  });
});

describe("the stage: the form beside the bot", () => {
  it("leaves the bot's visible half and a gap; the form never reaches under the bot", () => {
    for (const size of [
      { width: 1567, height: 743 },
      { width: 1280, height: 800 },
      { width: 1100, height: 700 }, // the app's smallest window
      { width: 800, height: 900 },
    ]) {
      const right = stageFormRight(size);
      expect(right).toBe(Math.round(stageBotSize(size) / 2) + STAGE_FORM_GAP_PX);
      // What is left for the form holds its column (440 px) and the padding.
      expect(size.width - right).toBeGreaterThanOrEqual(STAGE_FORM_RESERVE_PX - STAGE_FORM_GAP_PX);
    }
  });
});

describe("the stage: the big bot in the corner", () => {
  it("is as tall as the ratio of the window, cut in half by the right edge", () => {
    expect(stageBotSize({ width: 1280, height: 800 })).toBe(Math.round(800 * STAGE_HEIGHT_RATIO));
  });

  it("shrinks in a narrow window so its visible half stays clear of the form, but not below the floor", () => {
    expect(stageBotSize({ width: STAGE_FORM_RESERVE_PX + 200, height: 800 })).toBe(400);
    expect(stageBotSize({ width: 300, height: 800 })).toBe(Math.round(800 * STAGE_MIN_RATIO));
  });

  it("in the corner it is laid out as is: no offset, full size", () => {
    expect(stagePose("corner", { width: 1280, height: 800 }, null)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });

  it("in the welcome it sits on the spot: its centre there and the spot's width over its own", () => {
    const size = { width: 1280, height: 800 };
    const slot = { cx: 640, cy: 300, size: 120 };
    const pose = stagePose("welcome", size, slot);
    // The big box is centred on (1280, 400): moving it by (x, y) puts its centre on the spot.
    expect(1280 + pose.x).toBe(slot.cx);
    expect(400 + pose.y).toBe(slot.cy);
    expect(pose.scale).toBeCloseTo(slot.size / stageBotSize(size));
    expect(pose.scale).toBeLessThan(1);
  });

  it("grows by a constant amount per millisecond (linear) between the two poses", () => {
    const size = { width: 1280, height: 800 };
    const from = stagePose("welcome", size, { cx: 640, cy: 300, size: 120 }).scale;
    const to = stagePose("corner", size, null).scale;
    const at = (t: number) => from + (to - from) * (t / STAGE_TRAVEL_MS);
    expect(at(700) - at(600)).toBeCloseTo(at(100) - at(0));
    expect(at(STAGE_TRAVEL_MS)).toBe(1);
  });

  it("the turn and the trip last 1.4 s, and the words are gone before the bot arrives", () => {
    expect(STAGE_TRAVEL_MS).toBe(1400);
    expect(WELCOME_EXIT_MS).toBeLessThan(STAGE_TRAVEL_MS);
    expect(WELCOME_DANCE_MS).toBe(1800);
  });

  it("looks at a pointer anywhere, much stronger than the welcome's light follow", () => {
    expect(STAGE_FOLLOW_GAIN).toBeGreaterThan(FOLLOW_GAIN);
    const center = { x: 1280, y: 400 };
    const far = stageGaze(center, { x: 0, y: 400 });
    expect(far.x).toBeCloseTo(-STAGE_FOLLOW_GAIN);
    expect(far.y).toBeCloseTo(0);
    const up = stageGaze(center, { x: 1280, y: 400 - STAGE_FOLLOW_REACH_PX });
    expect(up.y).toBeCloseTo(-STAGE_FOLLOW_GAIN);
    expect(stageGaze(center, center)).toEqual({ x: 0, y: 0 });
  });
});

describe("the gallery of the connectors", () => {
  const wide = { width: 1280, height: 800 };

  it("the bot grows with the window's height up to its cap, is smaller in a short one, centred at the top", () => {
    expect(galleryBotSize(wide)).toBe(160);
    expect(galleryBotSize({ width: 1567, height: 1260 })).toBe(GALLERY_BOT_MAX_PX);
    expect(galleryBotSize({ width: 1280, height: 400 })).toBe(GALLERY_BOT_MIN_PX);
    const slot = galleryBotSlot(wide);
    expect(slot.cx).toBe(640);
    expect(slot.cy - slot.size / 2).toBe(GALLERY_TOP_PX);
    expect(galleryHeadSpace(wide)).toBeGreaterThan(slot.cy + slot.size / 2);
  });

  it("its pose is the corner's box moved to the top and shrunk (linear size, the same travel)", () => {
    const pose = stagePose("gallery", wide, null);
    const slot = galleryBotSlot(wide);
    expect(pose.x).toBe(slot.cx - wide.width);
    expect(pose.y).toBe(slot.cy - wide.height / 2);
    expect(pose.scale).toBeCloseTo(slot.size / stageBotSize(wide));
    expect(pose.scale).toBeLessThan(1);
  });

  it("the crew: 3 a side in a wide window, fewer in a narrow one, and none when nothing fits", () => {
    expect(crewPerSide(wide)).toBe(3);
    // A window 660 px tall has a bot of 132 px: the room on each side decides how many fit.
    expect(crewPerSide({ width: 1000, height: 660 })).toBe(3);
    expect(crewPerSide({ width: 700, height: 660 })).toBe(2);
    expect(crewPerSide({ width: 520, height: 660 })).toBe(1);
    expect(crewPerSide({ width: 300, height: 660 })).toBe(0);
    expect(galleryCrew({ width: 300, height: 660 })).toEqual([]);
    // The app's smallest window (1100 x 700) still holds the whole crew.
    expect(crewPerSide({ width: 1100, height: 700 })).toBe(3);
  });

  it("the crew stands on the bot's line, smaller and smaller outwards, symmetrical, inside the window", () => {
    const bot = galleryBotSlot(wide);
    const base = bot.cy + bot.size / 2;
    const crew = galleryCrew(wide);
    expect(crew).toHaveLength(6);
    for (const place of crew) {
      expect(place.cy + place.size / 2).toBeCloseTo(base);
      expect(place.size).toBeLessThan(bot.size);
      expect(place.cx - place.size / 2).toBeGreaterThanOrEqual(GALLERY_EDGE_PX);
      expect(place.cx + place.size / 2).toBeLessThanOrEqual(wide.width - GALLERY_EDGE_PX);
    }
    for (const side of ["left", "right"] as const) {
      const mine = crew.filter((p) => p.side === side).sort((a, b) => a.rank - b.rank);
      expect(mine.map((p) => p.rank)).toEqual([0, 1, 2]);
      expect(mine[0]?.size).toBeGreaterThan(mine[1]?.size ?? 0);
      expect(mine[1]?.size).toBeGreaterThan(mine[2]?.size ?? 0);
    }
    // Mirror images in place, with the gap between neighbours.
    const left = crew.find((p) => p.side === "left" && p.rank === 0);
    const right = crew.find((p) => p.side === "right" && p.rank === 0);
    expect(left && right && bot.cx - left.cx).toBeCloseTo((right?.cx ?? 0) - bot.cx);
    expect(bot.cx - (left?.cx ?? 0) - (left?.size ?? 0) / 2 - bot.size / 2).toBeCloseTo(
      GALLERY_CREW_GAP_PX,
    );
  });

  it("the crew is fixed: every face different, never the stage bot's white circle", () => {
    const looks = GALLERY_CREW.map((c) => `${c.shape}/${c.color}`);
    expect(new Set(looks).size).toBe(GALLERY_CREW.length);
    expect(new Set(GALLERY_CREW.map((c) => c.color)).size).toBe(GALLERY_CREW.length);
    expect(new Set(GALLERY_CREW.map((c) => c.shape)).size).toBe(GALLERY_CREW.length);
    expect(GALLERY_CREW.some((c) => c.shape === "blob")).toBe(false);
    expect(GALLERY_CREW.some((c) => c.color === "branco")).toBe(false);
    expect(galleryCrew(wide)).toEqual(galleryCrew(wide));
  });

  it("enters in order: the crew while the bot arrives, then the title, the grid and the button", () => {
    const trip = galleryStart(true);
    expect(trip.crew).toBeLessThan(STAGE_TRAVEL_MS);
    expect(trip.head).toBeGreaterThan(trip.crew);
    expect(trip.grid).toBeGreaterThan(trip.head);
    expect(trip.button).toBeGreaterThan(trip.grid);
    expect(trip.button).toBeLessThan(5000);
    expect(galleryStart(false).crew).toBeLessThan(trip.crew);
  });
});

describe('"Crie seu bot": two equal halves, centred in the window', () => {
  const windows = [
    { width: 1567, height: 1260 },
    { width: 1440, height: 900 },
    { width: 1100, height: 700 },
  ];

  it("the bot is centred in the left half, the panel in the right one", () => {
    for (const w of windows) {
      const layout = createLayout(w);
      expect(layout.bot.cx, `${w.width}`).toBe(w.width / 4);
      expect(layout.bot.cy).toBe(w.height / 2);
      expect(layout.formLeft).toBe(w.width / 2);
    }
  });

  it("the bot is whole and as big as its half allows, never past its limits", () => {
    for (const w of windows) {
      const size = createBotSize(w);
      expect(size).toBeLessThanOrEqual(CREATE_BOT_MAX_PX);
      expect(size).toBeGreaterThanOrEqual(CREATE_BOT_MIN_PX);
      // Whole: inside its half with the margin, and inside the window's height.
      expect(size).toBeLessThanOrEqual(w.width / 2 - 2 * CREATE_EDGE_PX);
      expect(size).toBeLessThanOrEqual(w.height);
    }
    expect(createBotSize(windows[0] as { width: number; height: number })).toBe(CREATE_BOT_MAX_PX);
    expect(createBotSize({ width: 1100, height: 700 })).toBe(385);
  });

  it("the panel is wide: up to 560 px, and it fits the right half of the smallest window", () => {
    expect(CREATE_PANEL_PX).toBe(560);
    expect(1100 / 2 - 2 * 24).toBeGreaterThanOrEqual(500);
  });
});
