import { useEffect, useMemo, useState } from "react";
import { cx } from "../../lib/cx.js";
import { useReducedMotion } from "../../lib/reduced-motion.js";
import {
  type CrewPlace,
  FOLLOW_MOVE_MS,
  GALLERY_CREW_LOOK_GAIN,
  GALLERY_CREW_REST_GAIN,
  GALLERY_TIMING,
  GAZE_MOVE_MS,
  galleryCrew,
  galleryStart,
  type Size,
  stageGaze,
} from "../../lib/welcome.js";
import { Mascot } from "../../ui/mascot.js";
import { centerOf, sameLook, useGlidingGaze, type Vector } from "./gaze.js";
import type { StageCue } from "./Stage.js";

function readWindow(): Size {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** How the crew looks at a point: the bot's own pointer look, a little lighter. */
function crewLook(from: Vector, point: Vector): Vector {
  const look = stageGaze(from, point);
  return { x: look.x * GALLERY_CREW_LOOK_GAIN, y: look.y * GALLERY_CREW_LOOK_GAIN };
}

/**
 * One bot of the crew. Only the eyes and the face: it looks at the card under the pointer (or at
 * the pointer) with the stage's bot, smiles when something connects, never breathes and has no
 * "brain" (the engine's small sizes have none): it is company, not a second bot.
 */
function CrewBot({
  place,
  index,
  delay,
  smiling,
  curiousAt,
}: {
  place: CrewPlace;
  index: number;
  delay: number;
  smiling: boolean;
  curiousAt: HTMLElement | null;
}) {
  const reduced = useReducedMotion();
  const [pointer, setPointer] = useState<Vector | null>(null);
  const [curious, setCurious] = useState<Vector | null>(null);

  useEffect(() => {
    if (reduced) {
      setPointer(null);
      return;
    }
    const move = (e: PointerEvent) => {
      const look = crewLook({ x: place.cx, y: place.cy }, { x: e.clientX, y: e.clientY });
      setPointer((now) => (sameLook(now, look) ? now : look));
    };
    const away = () => setPointer(null);
    window.addEventListener("pointermove", move);
    document.documentElement.addEventListener("pointerleave", away);
    return () => {
      window.removeEventListener("pointermove", move);
      document.documentElement.removeEventListener("pointerleave", away);
    };
  }, [reduced, place.cx, place.cy]);

  useEffect(() => {
    const to = reduced || curiousAt === null ? null : centerOf(curiousAt);
    setCurious(to === null ? null : crewLook({ x: place.cx, y: place.cy }, to));
  }, [curiousAt, reduced, place.cx, place.cy]);

  // Stable between renders: a new object each time would restart the glide of the eyes forever.
  const rest = useMemo(
    () => ({ x: (place.side === "left" ? 1 : -1) * GALLERY_CREW_REST_GAIN, y: 0 }),
    [place.side],
  );
  const target = curious ?? pointer ?? rest;
  const quick = curious === null && pointer !== null;
  const eyes = useGlidingGaze(target, quick ? FOLLOW_MOVE_MS : GAZE_MOVE_MS, reduced);
  return (
    <div
      className="absolute animate-bot-in rounded-full"
      style={{
        left: place.cx - place.size / 2,
        top: place.cy - place.size / 2,
        width: place.size,
        height: place.size,
        animationDelay: `${reduced ? 0 : delay}ms`,
      }}
      data-testid="stage-crew-bot"
      data-side={place.side}
      data-rank={place.rank}
      data-state={smiling ? "smiling" : "idle"}
    >
      <Mascot
        shape={place.shape}
        color={place.color}
        seed={`suup-crew-${index}`}
        size="md"
        state={smiling ? "smiling" : "idle"}
        gaze={eyes}
        breathe={false}
      />
    </div>
  );
}

/**
 * The crew of the gallery of the connectors (docs/DESIGN.md §3d; owner, 24/11/2026): other bots,
 * each of a different shape and colour, standing on the same line as the stage's bot, three on each
 * side in a wide window (fewer in a narrow one), smaller and smaller outwards. They come out of
 * the middle, one pair after the other, while the bot is arriving. Decoration only: hidden from
 * the screen reader, no focus, no click (the layer takes no pointer at all).
 */
export function StageCrew({ cue, trip }: { cue: StageCue; trip: boolean }) {
  const [win, setWin] = useState(readWindow);
  useEffect(() => {
    const resize = () => setWin(readWindow());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const places = galleryCrew(win);
  const start = galleryStart(trip).crew;
  return (
    <div
      aria-hidden="true"
      className={cx(
        "pointer-events-none fixed inset-0 z-10 overflow-hidden",
        cue.leaving && "animate-welcome-out",
      )}
      data-testid="stage-crew"
      data-count={places.length}
    >
      {places.map((place, index) => (
        <CrewBot
          key={`${place.side}-${place.rank}`}
          place={place}
          index={index}
          delay={start + place.rank * GALLERY_TIMING.crewEvery}
          smiling={cue.status === "confirmed"}
          curiousAt={cue.curiousAt}
        />
      ))}
    </div>
  );
}
