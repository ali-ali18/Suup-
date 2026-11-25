import { useEffect, useRef, useState } from "react";
import { cx } from "../../lib/cx.js";
import { useReducedMotion } from "../../lib/reduced-motion.js";
import {
  cleanOwnerName,
  type Gaze,
  OWNER_NAME_MAX,
  WELCOME_DANCE_MS,
  WELCOME_EXIT_MS,
  WELCOME_GAZE,
  WELCOME_STEP_AT,
  WELCOME_STEPS,
  WELCOME_TIMING,
} from "../../lib/welcome.js";
import { Pill, TextField } from "../../ui/primitives.js";
import { WelcomeLine } from "../../ui/welcome.js";
import { useStage } from "./Stage.js";

const STEP = Object.fromEntries(WELCOME_STEPS.map((id, index) => [id, index])) as Record<
  (typeof WELCOME_STEPS)[number],
  number
>;
const LAST_STEP = WELCOME_STEPS.length - 1;

const QUESTION = "Como você quer ser chamado?";

/**
 * The very first thing a device shows (docs/DESIGN.md §3d, owner's decisions of 24/11/2026; the
 * choreography of docs/pesquisas/entrada-de-apps-reais.md): the round bot rises into the middle,
 * looks to one side, to the other and to the front while the words rise one line at a time; then the
 * field (the chat's colour, the focus once the words are there) and "Continuar" (the white pill, as
 * wide as the field). The name is required: no "Pular". Typing makes the bot look at the field;
 * going on, it dances smiling (`cheering`, `WELCOME_DANCE_MS`); then the words and the field fade out
 * while the same bot turns and goes to the corner of the next screen (`Stage`). The bot itself is
 * drawn by the stage, over the screen: here there is only the empty spot where it sits. Reduced
 * motion (the system's or the app's) shows everything at once, the bot still.
 */
export function WelcomeScreen({ onDone }: { onDone(name: string | null): void }) {
  const reduced = useReducedMotion();
  const [step, setStep] = useState(reduced ? LAST_STEP : 0);
  const [gaze, setGaze] = useState<Gaze>("front");
  const [name, setName] = useState("");
  const [leaving, setLeaving] = useState(false);
  // The caller may pass a new function at every render: the exit timer must not restart for it.
  const done = useRef(onDone);
  done.current = onDone;
  const lookBack = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const stage = useStage();
  const fieldShown = step >= STEP.field;
  // Once the sequence is over and the bot faces the front, a near pointer draws its eyes a little.
  const following = fieldShown && !leaving && !reduced && gaze === "front";
  useEffect(
    () => stage.cue({ look: gaze, dancing: leaving, following }),
    [stage, gaze, leaving, following],
  );

  useEffect(() => {
    if (reduced) {
      setStep(LAST_STEP);
      setGaze("front");
      return;
    }
    const timers = [
      ...WELCOME_GAZE.map((g) => setTimeout(() => setGaze(g.look), g.at)),
      ...WELCOME_STEPS.map((id, index) =>
        index === 0
          ? undefined
          : setTimeout(() => setStep((now) => Math.max(now, index)), WELCOME_STEP_AT[id]),
      ),
    ];
    return () => {
      for (const timer of timers) if (timer !== undefined) clearTimeout(timer);
      clearTimeout(lookBack.current);
    };
  }, [reduced]);

  // The exit: the bot dances, smiling; then the words and the field fade while the bot turns and
  // goes to the corner, and the next screen comes when they are gone.
  const [fading, setFading] = useState(false);
  useEffect(() => {
    if (!leaving) return;
    if (reduced) {
      stage.leave();
      done.current(cleanOwnerName(name));
      return;
    }
    const fade = setTimeout(() => {
      setFading(true);
      stage.leave();
    }, WELCOME_DANCE_MS);
    const next = setTimeout(
      () => done.current(cleanOwnerName(name)),
      WELCOME_DANCE_MS + WELCOME_EXIT_MS,
    );
    return () => {
      clearTimeout(fade);
      clearTimeout(next);
    };
  }, [leaving, name, reduced, stage]);

  const buttonShown = step >= STEP.button;
  const ready = cleanOwnerName(name) !== null && !leaving;
  const go = () => {
    if (ready) {
      setGaze("front");
      setLeaving(true);
    }
  };
  const type = (text: string) => {
    setName(text);
    if (reduced) return;
    // The bot looks at what is being typed, and back to the front when the typing stops.
    setGaze("field");
    clearTimeout(lookBack.current);
    lookBack.current = setTimeout(() => setGaze("front"), WELCOME_TIMING.lookBackAfter);
  };

  return (
    <main
      className={cx(
        "flex min-h-full flex-col items-center justify-center gap-8 overflow-auto p-6 text-center",
        fading && "animate-welcome-out",
      )}
      data-testid="welcome"
      data-leaving={leaving ? "true" : "false"}
    >
      {/* Where the stage's bot sits: empty here (the bot is drawn over the screen, so it can travel). */}
      <div
        ref={stage.slot}
        className="size-30"
        data-testid="welcome-bot"
        data-gaze={gaze}
        aria-hidden="true"
      />
      <div className="flex max-w-reading flex-col items-center gap-2" aria-live="polite">
        <WelcomeLine
          shown={step >= STEP.line1}
          className="text-heading font-bold"
          data-testid="welcome-line-1"
        >
          Olá, tudo bem?
        </WelcomeLine>
        <WelcomeLine
          shown={step >= STEP.line2}
          className="text-body text-text-muted"
          data-testid="welcome-line-2"
        >
          Seja muito bem-vindo ao Suup, seu assistente do dia a dia.
        </WelcomeLine>
        {/* The field's own label says the same, for the screen reader; the line is the look of it. */}
        <WelcomeLine
          shown={step >= STEP.line3}
          className="text-title font-title"
          aria-hidden="true"
          data-testid="welcome-line-3"
        >
          {QUESTION}
        </WelcomeLine>
      </div>
      {/* Keyed by "shown": it takes its place unseen from the start and is born (and takes the focus)
          when the question is out; the hidden one cannot be reached. */}
      <form
        key={fieldShown ? "shown" : "hidden"}
        className={cx("flex w-connect flex-col gap-3", !fieldShown && "invisible")}
        data-testid="welcome-form"
        data-shown={fieldShown ? "true" : "false"}
        aria-hidden={fieldShown ? undefined : true}
        inert={!fieldShown}
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <div className={cx("w-full", fieldShown && "animate-control-in")}>
          <TextField
            label={QUESTION}
            hideLabel
            name="nickname"
            align="center"
            raised
            placeholder="Seu nome"
            value={name}
            onChange={type}
            autoFocus={fieldShown}
            autoComplete="nickname"
            enterKeyHint="done"
            maxLength={OWNER_NAME_MAX}
            onEnter={go}
          />
        </div>
        <Pill
          tone="primary"
          type="submit"
          className={cx("w-full", buttonShown ? "animate-control-in" : "invisible")}
          disabled={!ready}
          data-testid="welcome-continue"
        >
          Continuar
        </Pill>
      </form>
    </main>
  );
}
