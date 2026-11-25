import { ArrowLeft, type LucideIcon } from "lucide-react";
import { type FormEvent, type HTMLAttributes, type ReactNode, useEffect, useState } from "react";
import { cx } from "../lib/cx.js";
import { useReducedMotion } from "../lib/reduced-motion.js";
import {
  createLayout,
  type GalleryStart,
  galleryHeadSpace,
  type Size,
  stageFormRight,
} from "../lib/welcome.js";
import { Avatar } from "./avatar.js";
import { IconCircle, MutedText, RoundButton } from "./primitives.js";
import { ScrollFade } from "./scroll-fade.js";

/**
 * The frame of the screens before the app opens (first-run choice, connect, the embedded server's
 * start): one calm card in the middle of the window, the mascot, a title and one line under it
 * (docs/DESIGN.md §3d). With `onSubmit` the card is a form.
 */
export function WelcomeCard({
  title,
  subtitle,
  onSubmit,
  testId,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  onSubmit?(): void;
  testId?: string;
  children: ReactNode;
}) {
  const head = (
    <div className="flex flex-col items-center gap-2 text-center">
      <Avatar avatar="mascot:blob" seed="suup" size="lg" />
      <h1 className="text-heading font-bold">{title}</h1>
      {subtitle !== undefined && <MutedText as="p">{subtitle}</MutedText>}
    </div>
  );
  const card = "flex w-connect flex-col gap-4 rounded-card border border-border bg-surface p-8";
  return (
    <main className="flex min-h-full animate-fade-in items-center justify-center overflow-auto p-6">
      {onSubmit === undefined ? (
        <div className={card} data-testid={testId}>
          {head}
          {children}
        </div>
      ) : (
        <form
          className={card}
          data-testid={testId}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {head}
          {children}
        </form>
      )}
    </main>
  );
}

/** The room `StageForm` leaves on the right for the big bot, kept up with the window's size. */
function readStageRight(): number {
  return typeof window === "undefined"
    ? 0
    : stageFormRight({ width: window.innerWidth, height: window.innerHeight });
}

/** Where "Crie seu bot" starts its column: after the bot that stands on the left. */
function readStageLeft(): number {
  return typeof window === "undefined"
    ? 0
    : createLayout({ width: window.innerWidth, height: window.innerHeight }).formLeft;
}

/** The room the form leaves to the bot, on the side the bot is (the right corner, or the left whole). */
function useStageInset(side: "right" | "left"): number {
  const read = side === "left" ? readStageLeft : readStageRight;
  const [inset, setInset] = useState(read);
  useEffect(() => {
    const resize = () => setInset(read());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [read]);
  return inset;
}

/**
 * The frame of the screens that follow the welcome (the first-run choice, connect; docs/DESIGN.md
 * §3d): a column on the LEFT with the title, one line and the content; the big bot of the stage
 * sits in the right corner (it is not drawn here: there is only one bot, and it came from the
 * welcome). "Voltar" is an arrow at the top left. With `onSubmit` the column is a form.
 * `bot="left"` is "Crie seu bot" (docs/DESIGN.md §3d): the bot stands whole on the left and the
 * column starts after it; `enterDelay` lets the column come after the bot's trip.
 */
export function StageForm({
  title,
  subtitle,
  onSubmit,
  onBack,
  backDisabled,
  leaving,
  bot = "right",
  enterDelay = 0,
  eyebrow,
  testId,
  children,
}: {
  title: string;
  subtitle?: string | undefined;
  onSubmit?(): void;
  /** Where "Voltar" goes; without it there is no arrow. */
  onBack?: (() => void) | undefined;
  backDisabled?: boolean;
  /** The screen is going away: it fades out instead of vanishing (docs/DESIGN.md §1, "Nada seco"). */
  leaving?: boolean;
  /** Which side the stage's bot is on: the right corner (the default) or whole on the left. */
  bot?: "right" | "left";
  /** The column fades in this long (ms) after the screen is there; none with reduced motion. */
  enterDelay?: number;
  /** A small line above the title (the dots of the steps). */
  eyebrow?: ReactNode;
  testId?: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  // "Crie seu bot" (`bot="left"`) is a screen of its own: a bigger title and the line in body size.
  const big = bot === "left";
  const head = (
    <div className={cx("flex flex-col", big ? "gap-3" : "gap-2")}>
      {eyebrow}
      <h1 className={cx("font-bold", big ? "text-screen-title" : "text-heading")}>{title}</h1>
      {subtitle !== undefined && (
        <MutedText
          as="p"
          size={big ? "inherit" : "small"}
          className={big ? "text-body" : undefined}
        >
          {subtitle}
        </MutedText>
      )}
    </div>
  );
  const column = cx(
    "pointer-events-auto flex flex-col",
    big ? "w-create gap-6" : "w-connect gap-4",
  );
  // The bot's visible half takes the right side; the form is centred in the rest. The screen sits
  // ABOVE the bot's layer but lets the clicks through where it is empty, so the bot is clicked only
  // where nothing of the form is (owner, 24/11/2026: the bot's box was taking the field's clicks).
  const inset = useStageInset(bot);
  // The arrow's corner is beside the window's own buttons (the strip at the top drags the window).
  return (
    <main
      className={cx(
        "pointer-events-none relative z-20 flex min-h-full items-center overflow-auto py-6",
        bot === "left" ? "justify-center px-6" : "justify-center pl-6",
        leaving === true ? "animate-welcome-out" : "animate-fade-in",
      )}
      style={{
        // "Crie seu bot": the panel is centred in the right half (the bot has the left one).
        ...(bot === "left" ? { paddingLeft: inset + 24 } : { paddingRight: inset }),
        ...(enterDelay > 0 && leaving !== true
          ? { animationDelay: `${reduced ? 0 : enterDelay}ms` }
          : {}),
      }}
    >
      {onBack !== undefined && (
        <RoundButton
          label="Voltar"
          tone="ghost"
          className="pointer-events-auto absolute top-6 left-6 framed:top-10"
          disabled={backDisabled}
          onClick={onBack}
          data-testid="connect-back"
        >
          <ArrowLeft size={18} aria-hidden="true" />
        </RoundButton>
      )}
      {onSubmit === undefined ? (
        <div className={column} data-testid={testId}>
          {head}
          {children}
        </div>
      ) : (
        <form
          className={column}
          data-testid={testId}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            onSubmit();
          }}
        >
          {head}
          {children}
        </form>
      )}
    </main>
  );
}

/**
 * Where the person is in a short sequence of steps, calmly: one dot per step, the current one a
 * little longer and brighter. The dots are only to the eye; the screen reader gets "Passo 1 de 3".
 */
export function StepDots({ current, total }: { current: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5" data-testid="step-dots" data-step={current}>
      <span className="sr-only">{`Passo ${current} de ${total}`}</span>
      {Array.from({ length: total }, (_, i) => (
        <span
          // The dots never reorder: the position is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, ordered dots
          key={i}
          aria-hidden="true"
          data-on={i + 1 === current ? "true" : "false"}
          className={cx(
            "h-1.5 rounded-pill transition-[width,background-color] duration-(--duration-base) ease-out",
            i + 1 === current ? "w-5 bg-text" : "w-1.5 bg-border-strong",
          )}
        />
      ))}
    </div>
  );
}

/**
 * A choice that is a whole card (the first-run screen): an icon plate, a title and what it means in
 * one faded line. It is a button, so the keyboard and the screen reader get it as one.
 */
export function ChoiceCard({
  icon: Icon,
  title,
  description,
  onSelect,
  disabled,
  testId,
  recommended,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onSelect(): void;
  disabled?: boolean;
  testId?: string;
  /** Draws the stronger border: the choice the app suggests. */
  recommended?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      data-testid={testId}
      className={cx(
        "flex w-full items-center gap-3 rounded-row border bg-bg px-4 py-3 text-left transition-colors enabled:hover:bg-hover disabled:opacity-40",
        recommended === true ? "border-border-strong" : "border-border",
      )}
      onClick={onSelect}
    >
      <IconCircle>
        <Icon size={18} />
      </IconCircle>
      <span className="flex min-w-0 flex-col leading-label">
        <span className="text-label font-label wrap-anywhere">{title}</span>
        <span className="text-small wrap-anywhere text-text-muted">{description}</span>
      </span>
    </button>
  );
}

/**
 * One line of the first welcome: it takes its place from the start (so nothing moves when it
 * shows up) and rises into it when `shown` (docs/DESIGN.md §3d). Reduced motion zeroes the rise.
 */
export function WelcomeLine({
  shown,
  className,
  children,
  ...rest
}: {
  shown: boolean;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLParagraphElement>, "className">) {
  return (
    <p
      data-shown={shown ? "true" : "false"}
      className={cx(shown ? "animate-line-in" : "invisible", className)}
      {...rest}
    >
      {children}
    </p>
  );
}

function readSize(): Size {
  return typeof window === "undefined"
    ? { width: 1280, height: 800 }
    : { width: window.innerWidth, height: window.innerHeight };
}

/** The window's size, kept up with a resize (the gallery's row of bots depends on it). */
function useWindowSize(): Size {
  const [size, setSize] = useState(readSize);
  useEffect(() => {
    const resize = () => setSize(readSize());
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return size;
}

/**
 * The frame of the gallery of the connectors (docs/DESIGN.md §3d; owner, 24/11/2026): the stage's
 * bot and its crew stand at the top, in the middle (they are not drawn here: the stage draws them
 * under this screen); under them the title and one faded line, centred; then `children` in a box
 * of limited height that scrolls with the fade on its edges, in a column of at most
 * `--width-screen-max`; and the `footer` (the button) under it, always in sight. The screen sits
 * ABOVE the bots' layer but lets the clicks through where it is empty (as `StageForm` does).
 * The parts rise one after the other (`start`, in ms); with reduced motion everything is there.
 */
export function GalleryFrame({
  title,
  subtitle,
  start,
  leaving,
  testId,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  start: GalleryStart;
  leaving: boolean;
  testId: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const head = galleryHeadSpace(useWindowSize());
  const delay = (ms: number) => ({ animationDelay: `${reduced ? 0 : ms}ms` });
  return (
    <main
      className={cx(
        "pointer-events-none relative z-20 flex h-full min-h-0 flex-col items-center overflow-auto px-6 pb-10",
        leaving && "animate-welcome-out",
      )}
      style={{ paddingTop: head }}
      data-testid={testId}
      data-leaving={leaving ? "true" : "false"}
    >
      <div className="max-w-screen-max flex min-h-0 w-full flex-1 flex-col items-center gap-6">
        <div
          className="pointer-events-auto flex animate-line-in flex-col items-center gap-2 text-center"
          style={delay(start.head)}
          data-testid="gallery-head"
        >
          <h1 className="text-heading font-bold">{title}</h1>
          <MutedText as="p">{subtitle}</MutedText>
        </div>
        <div
          className="pointer-events-auto relative max-h-gallery-list min-h-40 w-full flex-1 animate-line-in"
          style={delay(start.grid)}
          data-testid="gallery-box"
        >
          <div className="size-full overflow-y-auto py-3" data-testid="gallery-list">
            {children}
          </div>
          <ScrollFade />
        </div>
        <div
          className="pointer-events-auto flex-none animate-line-in"
          style={delay(start.button)}
          data-testid="gallery-footer"
        >
          {footer}
        </div>
      </div>
    </main>
  );
}
