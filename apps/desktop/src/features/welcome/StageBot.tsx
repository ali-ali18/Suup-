import type { AvatarStateId } from "@suup/avatar";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx.js";
import { mascotValue } from "../../lib/mascots.js";
import { useReducedMotion } from "../../lib/reduced-motion.js";
import {
  CREATE_HOP_STRENGTH,
  CREATE_REACT_MS,
  CREATE_REST_GAZE,
  createLayout,
  FOLLOW_MOVE_MS,
  followGaze,
  GALLERY_REST_GAZE,
  GAZE_MOVE_MS,
  GAZE_VECTOR,
  type Size,
  type Slot,
  STAGE_FAILED_MS,
  STAGE_POKE_EVERY_MS,
  STAGE_POKE_STRENGTH,
  STAGE_REST_GAZE,
  STAGE_THINK_EVERY_MS,
  STAGE_THINK_LOOKS,
  STAGE_TRAVEL_MS,
  type StagePlace,
  stageBotSize,
  stageGaze,
  stagePose,
  WELCOME_TIMING,
} from "../../lib/welcome.js";
import { Avatar } from "../../ui/avatar.js";
import { Mascot } from "../../ui/mascot.js";
import { centerOf, sameLook, useGlidingGaze, type Vector } from "./gaze.js";
import type { StageCue } from "./Stage.js";

/** The bot of the welcome: the perfect circle (`blob`, the same radius on both axes), white. */
const SHAPE = "blob";
const COLOR = "branco";

/** The elements the bot looks at while someone types in them (compared by tag, never by pattern). */
const FIELD_TAGS: readonly string[] = ["INPUT", "TEXTAREA"];

function readWindow(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * The bot of the screens before the app. It is laid out ONCE, big, with its centre on the right
 * edge of the window (half of it cut by the edge, centred in height): the corner. In the welcome it
 * is that same box moved to the middle and shrunk (a `translate` and a `scale`); going to the corner
 * is those two going back to nothing: the position with the entry curve, the size linearly, and
 * the body turns once on its axis (`spin`), all in the same time, so it arrives facing front.
 * Reduced motion: no trip and no turn, it is simply there.
 *
 * In the corner it follows the pointer over the whole window, smiles when the pointer is over it,
 * gets poked by a click, looks at the field someone types in (curious) and ponders while the
 * screen connects (docs/DESIGN.md §3d). In the gallery of the connectors it is the same bot, at the
 * top and in the middle, the same behaviours (it is the one that looks at the card under the pointer).
 * In "Crie seu bot" (`create`) it is on the left, whole, and it IS the bot being made: the shape and
 * the colour the person picks (`cue.face`) change it live, with a smile and a little hop each time.
 * The pixel style is drawn by `Avatar` (the one place that mounts the pixel mascot), in a box of its
 * own at the real size: a canvas needs whole-pixel cells, which a `scale` would break.
 */
export function StageBot({
  mode,
  slot,
  cue,
}: {
  mode: StagePlace;
  slot: HTMLElement | null;
  cue: StageCue;
}) {
  const reduced = useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const [win, setWin] = useState(readWindow);
  const [slotBox, setSlotBox] = useState<Slot | null>(null);
  const [pointer, setPointer] = useState<Vector | null>(null);
  const [field, setField] = useState<Vector | null>(null);
  const [typing, setTyping] = useState(false);
  const [hover, setHover] = useState(false);
  const [failing, setFailing] = useState(false);
  const [poke, setPoke] = useState({ key: 0, x: 0, y: 0, strength: STAGE_POKE_STRENGTH });
  const lastPoke = useRef(Number.NEGATIVE_INFINITY);
  const [spin, setSpin] = useState({ key: 0, ms: STAGE_TRAVEL_MS });
  const [traveling, setTraveling] = useState(false);
  const [lastMode, setLastMode] = useState(mode);
  // The looks of the bot being made: a new shape is a smile and a little hop; a new colour only
  // repaints the body and smiles (no hop, and a smile already going is not restarted by another
  // colour: the person flips through them).
  const face = mode === "create" ? cue.face : null;
  const shapeKey = face === null ? "" : `${face.style}|${face.shape}|${face.pixel}|${face.pixel3d}`;
  const faceKey = face === null ? "" : `${shapeKey}|${face.color}`;
  const [lastFace, setLastFace] = useState(faceKey);
  const [lastShape, setLastShape] = useState(shapeKey);
  const [reacting, setReacting] = useState(false);
  if (lastFace !== faceKey) {
    setLastFace(faceKey);
    setLastShape(shapeKey);
    if (lastFace !== "" && faceKey !== "" && !reduced) {
      setReacting(true);
      if (lastShape !== shapeKey) {
        setPoke((now) => ({ key: now.key + 1, x: 0, y: -0.6, strength: CREATE_HOP_STRENGTH }));
      }
    }
  }
  useEffect(() => {
    if (!reacting) return;
    const timer = setTimeout(() => setReacting(false), CREATE_REACT_MS);
    return () => clearTimeout(timer);
  }, [reacting, faceKey]);

  // A change of place, decided in the same render as the new pose, so the transition has the
  // old pose to run from.
  if (lastMode !== mode) {
    setLastMode(mode);
    if (!reduced) {
      setTraveling(true);
      if (mode === "corner") setSpin((now) => ({ key: now.key + 1, ms: STAGE_TRAVEL_MS }));
    }
  }
  useEffect(() => {
    if (!traveling) return;
    const timer = setTimeout(() => setTraveling(false), STAGE_TRAVEL_MS);
    return () => clearTimeout(timer);
  }, [traveling]);

  useEffect(() => {
    const resize = () => setWin(readWindow());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  // Where the welcome's spot is (the welcome screen lays it out, so it is measured).
  useLayoutEffect(() => {
    if (slot === null) return;
    const r = slot.getBoundingClientRect();
    setSlotBox({ cx: r.left + r.width / 2, cy: r.top + r.height / 2, size: r.width });
  }, [slot, win]);

  // The pointer. In the welcome only when it is near (and the sequence is over); in the corner,
  // anywhere in the window, strongly.
  const watching = mode === "welcome" ? cue.following && !reduced : !reduced;
  useEffect(() => {
    if (!watching) {
      setPointer(null);
      return;
    }
    const move = (e: PointerEvent) => {
      const center = centerOf(box.current);
      if (center === null) return;
      const at = { x: e.clientX, y: e.clientY };
      const look = mode === "welcome" ? followGaze(center, at) : stageGaze(center, at);
      setPointer((now) => (sameLook(now, look) ? now : look));
    };
    const away = () => setPointer(null);
    window.addEventListener("pointermove", move);
    document.documentElement.addEventListener("pointerleave", away);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", away);
    };
  }, [watching, mode]);

  // The corner: typing in a field of the form draws the eyes to it and makes the bot curious.
  useEffect(() => {
    if (mode === "welcome" || reduced) {
      setTyping(false);
      setField(null);
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const typed = (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLElement) || !FIELD_TAGS.includes(target.tagName)) return;
      const center = centerOf(box.current);
      const at = centerOf(target);
      if (center === null || at === null) return;
      setField(stageGaze(center, at));
      setTyping(true);
      clearTimeout(timer);
      timer = setTimeout(() => setTyping(false), WELCOME_TIMING.lookBackAfter);
    };
    document.addEventListener("input", typed);
    return () => {
      document.removeEventListener("input", typed);
      clearTimeout(timer);
    };
  }, [mode, reduced]);

  // A failed try: sorry for a moment, then back by itself.
  useEffect(() => {
    if (cue.status !== "error") {
      setFailing(false);
      return;
    }
    setFailing(true);
    const timer = setTimeout(() => setFailing(false), STAGE_FAILED_MS);
    return () => clearTimeout(timer);
  }, [cue.status]);

  // Thinking (a step being checked): the eyes go up and wander from side to side.
  const thinking = mode !== "welcome" && cue.status === "busy" && !reduced;
  const [thinkLook, setThinkLook] = useState(0);
  useEffect(() => {
    if (!thinking) {
      setThinkLook(0);
      return;
    }
    const timer = setInterval(
      () => setThinkLook((now) => (now + 1) % STAGE_THINK_LOOKS.length),
      STAGE_THINK_EVERY_MS,
    );
    return () => clearInterval(timer);
  }, [thinking]);

  // After the welcome (the corner or the gallery) the bot is a toy for the pointer.
  const inCorner = mode !== "welcome";
  // Curious about something on the screen (a row of the list): the eyes go to it.
  const curiousAt = mode !== "welcome" && !reduced ? cue.curiousAt : null;
  const [curiousLook, setCuriousLook] = useState<Vector | null>(null);
  useEffect(() => {
    const center = curiousAt === null ? null : centerOf(box.current);
    const at = curiousAt === null ? null : centerOf(curiousAt);
    setCuriousLook(center === null || at === null ? null : stageGaze(center, at));
  }, [curiousAt]);
  const target =
    mode === "welcome"
      ? cue.following && pointer !== null
        ? pointer
        : GAZE_VECTOR[cue.look]
      : thinking
        ? (STAGE_THINK_LOOKS[thinkLook] ?? STAGE_REST_GAZE)
        : curiousLook !== null
          ? curiousLook
          : typing && field !== null
            ? field
            : (pointer ??
              (mode === "gallery"
                ? GALLERY_REST_GAZE
                : mode === "create"
                  ? CREATE_REST_GAZE
                  : STAGE_REST_GAZE));
  const quick =
    !thinking &&
    curiousLook === null &&
    pointer !== null &&
    (mode === "welcome" ? cue.following : !typing);
  const eyes = useGlidingGaze(target, quick ? FOLLOW_MOVE_MS : GAZE_MOVE_MS, reduced);

  let state: AvatarStateId = "idle";
  if (mode === "welcome") state = cue.dancing ? "cheering" : "idle";
  else if (traveling) state = "smiling";
  else if (cue.status === "busy") state = "pondering";
  else if (cue.status === "celebrating") state = "cheering";
  else if (cue.status === "confirmed") state = "surprised";
  else if (failing) state = "failed";
  else if (reacting) state = "smiling";
  else if (typing || curiousLook !== null) state = "asking";
  else if (hover) state = "smiling";

  const size = stageBotSize(win);
  const pose = stagePose(mode, win, slotBox);
  const placed = inCorner || slotBox !== null;
  // The pixel drawing, once the bot has settled in its place: real size, no scale (see above).
  const pixelSpot = mode === "create" ? createLayout(win).bot : null;
  const pixelFace = face !== null && face.style === "pixel" && !traveling && pixelSpot !== null;

  return (
    <div
      className={cx(
        "pointer-events-none fixed inset-0 z-10 overflow-hidden",
        cue.exiting && "animate-welcome-out",
      )}
      data-testid="stage-layer"
    >
      <div
        ref={box}
        // A toy for the mouse: the bot reacts to it; nothing here is needed by the keyboard.
        role="presentation"
        className={cx(
          "absolute rounded-full",
          !placed && "invisible",
          inCorner && "pointer-events-auto cursor-pointer",
          pixelFace && "pointer-events-none",
        )}
        data-testid="stage-bot"
        data-mode={mode}
        data-state={state}
        data-thinking={thinking ? String(thinkLook) : "off"}
        data-traveling={traveling ? "true" : "false"}
        data-face={face === null ? undefined : face.style === "pixel" ? face.pixel : face.shape}
        data-face-style={face === null ? undefined : face.style}
        data-face-color={face?.color ?? undefined}
        data-spin={spin.key}
        data-poke={poke.key}
        style={{
          width: size,
          height: size,
          right: -size / 2,
          top: `calc(50% - ${size / 2}px)`,
          translate: `${pose.x}px ${pose.y}px`,
          scale: String(pose.scale),
          // The place with the entry curve, the size at a constant pace; both take the trip's time.
          transition: traveling
            ? "translate var(--duration-travel) var(--ease-bot-in), scale var(--duration-travel) linear"
            : "none",
        }}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
        onClick={(e) => {
          const now = Date.now();
          if (now - lastPoke.current < STAGE_POKE_EVERY_MS) return;
          lastPoke.current = now;
          const r = e.currentTarget.getBoundingClientRect();
          const unit = (v: number) => Math.max(-1, Math.min(1, v));
          setPoke((before) => ({
            key: before.key + 1,
            x: unit((e.clientX - (r.left + r.width / 2)) / (r.width / 2)),
            y: unit((e.clientY - (r.top + r.height / 2)) / (r.height / 2)),
            strength: STAGE_POKE_STRENGTH,
          }));
        }}
      >
        <div className={cx("size-full", placed && "animate-bot-in")}>
          <div
            className={cx(
              "size-full transition-opacity duration-(--duration-base)",
              pixelFace && "opacity-0",
            )}
          >
            <Mascot
              shape={face?.shape ?? SHAPE}
              color={face?.color ?? COLOR}
              seed="suup-welcome"
              size="xl"
              state={state}
              gaze={eyes}
              breathe={false}
              spin={spin}
              poke={poke}
              repaint
            />
          </div>
        </div>
      </div>
      {pixelFace && face !== null && pixelSpot !== null && (
        <div
          className="pointer-events-none absolute animate-fade-in"
          style={{
            left: pixelSpot.cx - pixelSpot.size / 2,
            top: pixelSpot.cy - pixelSpot.size / 2,
            width: pixelSpot.size,
            height: pixelSpot.size,
          }}
          data-testid="stage-pixel"
        >
          <Avatar
            avatar={mascotValue(face.pixel)}
            avatarStyle="pixel"
            pixel3d={face.pixel3d}
            color={face.color}
            seed="suup-create"
            size="fill"
            state={state}
          />
        </div>
      )}
    </div>
  );
}
