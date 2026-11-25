import type { AvatarStyle, BotColor } from "@suup/api";
import type { PixelCharacterId, ShapeId } from "@suup/avatar";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import type { Gaze } from "../../lib/welcome.js";
import { StageBot } from "./StageBot.js";
import { StageCrew } from "./StageCrew.js";

/** How the bot being made looks ("Crie seu bot"): the choices of the person, live. */
export interface StageFace {
  style: AvatarStyle;
  shape: ShapeId;
  pixel: PixelCharacterId;
  pixel3d: boolean;
  /** `null`: a pixel drawing keeps its own colours. */
  color: BotColor | null;
}

/** What the screens tell the bot (the screen decides what happens; the bot does it). */
export interface StageCue {
  /** The welcome's own looks: left, right, front, down at the field. */
  look: Gaze;
  /** The "Continuar" dance, smiling. */
  dancing: boolean;
  /** Once the welcome is over its sequence, a near pointer draws the eyes a little. */
  following: boolean;
  /** The last screens: nothing, checking a step, the step confirmed, could not, or the bot is made. */
  status: "idle" | "busy" | "confirmed" | "error" | "celebrating";
  /** Something on the screen the bot is curious about (a row under the pointer): it looks at it, asking. */
  curiousAt: HTMLElement | null;
  /** The gallery is going away ("Continuar"): the crew fades out with it (the bot stays and goes on). */
  leaving: boolean;
  /** The whole entrance is going away to the app: the bot fades out with the screen. */
  exiting: boolean;
  /** The looks of the bot being made; `null` outside "Crie seu bot" (the welcome's white circle). */
  face: StageFace | null;
}

const START_CUE: StageCue = {
  look: "front",
  dancing: false,
  following: false,
  status: "idle",
  curiousAt: null,
  leaving: false,
  exiting: false,
  face: null,
};

export interface StageApi {
  /** The welcome gives the empty spot where the bot sits in the middle (a ref callback). */
  slot(element: HTMLElement | null): void;
  cue(next: Partial<StageCue>): void;
  /** Sends the bot to the corner of the next screen. */
  leave(): void;
  /** The gallery of the connectors asks for the bot (and the crew) at the top, in the middle; `false` gives it back. */
  gallery(on: boolean): void;
  /** "Crie seu bot" asks for the bot on the left, whole and made-up by the person; `false` gives it back. */
  create(on: boolean): void;
  /** Where the bot was born: a gallery has no trip to wait for when it was born there. */
  readonly bornAt: StartsAt;
}

type StartsAt = "welcome" | "corner" | "gallery" | "create";

const NO_STAGE: StageApi = {
  slot: () => undefined,
  cue: () => undefined,
  leave: () => undefined,
  gallery: () => undefined,
  create: () => undefined,
  bornAt: "corner",
};

const StageContext = createContext<StageApi>(NO_STAGE);

/** The screens before the app talk to the bot through this (a screen alone, as in a test, talks to no one). */
export function useStage(): StageApi {
  return useContext(StageContext);
}

/** Tells the bot what the screen is doing: it ponders while connecting and is sorry for an error. */
export function useStageStatus(status: StageCue["status"]): void {
  const stage = useStage();
  useEffect(() => stage.cue({ status }), [stage, status]);
}

/**
 * The ONE bot of the screens before the app (docs/DESIGN.md §3d, owner, 24/11/2026): it comes up in
 * the middle of the welcome and, when that ends, goes to the right corner of the screen that
 * follows, the same bot (it does not vanish and come back). `startsAt` says where it is born: the
 * welcome, the corner (a device that already saw the welcome), the gallery of the connectors (a
 * server on this computer has no connect screen before it) or "Crie seu bot" (the same, with the
 * connectors already seen). A new `key` is a new bot.
 */
export function Stage({ startsAt, children }: { startsAt: StartsAt; children: ReactNode }) {
  const [first] = useState(startsAt);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [cue, setCue] = useState(START_CUE);
  const [away, setAway] = useState(false);
  const [inGallery, setInGallery] = useState(startsAt === "gallery");
  const [inCreate, setInCreate] = useState(startsAt === "create");
  const api = useMemo<StageApi>(
    () => ({
      slot: setSlot,
      cue: (next) => setCue((now) => ({ ...now, ...next })),
      leave: () => setAway(true),
      gallery: setInGallery,
      create: setInCreate,
      bornAt: first,
    }),
    [first],
  );
  const mode =
    first === "welcome" && !away
      ? "welcome"
      : inCreate
        ? "create"
        : inGallery
          ? "gallery"
          : "corner";
  return (
    <StageContext.Provider value={api}>
      {children}
      <StageBot mode={mode} slot={slot} cue={cue} />
      {mode === "gallery" && <StageCrew cue={cue} trip={first !== "gallery"} />}
    </StageContext.Provider>
  );
}
