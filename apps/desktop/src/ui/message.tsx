import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.js";
import { useLiveReveal } from "../lib/live-fade.js";
import { Markdown } from "../lib/markdown.js";
import { Avatar } from "./avatar.js";

/** The bubble: the radius of a card, and `data-bubble` (below) changes only the linking corners. */
const BUBBLE = "min-w-0 rounded-bubble py-(--bubble-pad-y) px-4.5";

/**
 * Dynamic bubbles (docs/DESIGN.md, Balões): consecutive text bubbles of one sender link on the
 * sender's side (bot: left, user: right) with a small corner; the far side and the group's ends keep
 * the full radius. Cards never carry data-bubble. Only the radius changes when a bubble's position
 * does, so a new message shifts nothing (it is never animated).
 */
const LINK = {
  bot: {
    first: "rounded-bl-bubble-link",
    middle: "rounded-tl-bubble-link rounded-bl-bubble-link",
    last: "rounded-tl-bubble-link",
  },
  user: {
    first: "rounded-br-bubble-link",
    middle: "rounded-tr-bubble-link rounded-br-bubble-link",
    last: "rounded-tr-bubble-link",
  },
} as const;

/** A bubble that follows another of the same sender sits closer to it than a new group does. */
const linked = (position: BubblePosition | undefined): string | false =>
  (position === "middle" || position === "last") &&
  "mt-[calc(var(--bubble-gap-group)-var(--chat-gap))]";

const linkCorners = (side: "bot" | "user", position: BubblePosition | undefined): string =>
  position === undefined || position === "single" ? "" : LINK[side][position];

/** The bubble of a bot's text (a plain one, as in Pendências, or with Markdown, as in the chat). */
export function BotBubble({
  children,
  className,
  ...rest
}: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cx(BUBBLE, "max-w-full self-start border border-border bg-surface", className)}
      data-testid="bubble-bot"
      {...rest}
    >
      {children}
    </div>
  );
}

/** The centred muted single line (`EventLine`), also drawn as a button by the chat. */
export const EVENT_LINE_CLASS =
  "m-0 flex items-center justify-center gap-1.5 overflow-hidden px-6 py-0 text-small text-ellipsis whitespace-nowrap text-text-muted";

export type UserMessageState = "sending" | "sent" | "delivered" | undefined;

/** Where a text bubble sits among the consecutive bubbles of its sender (see `bubblePositions`). */
export type BubblePosition = "single" | "first" | "middle" | "last";

/**
 * A message of the user: a round bubble on the right, filled with the colour of the conversation's
 * bot (`--bot-fill` / `--bot-on-fill`, set once on the conversation).
 */
export function UserMessage({
  text,
  state,
  position,
}: {
  text: string;
  state?: UserMessageState;
  position?: BubblePosition | undefined;
}) {
  // The delivery state is data, not text: a message not confirmed yet is a little dimmer.
  const pending = state === "sending" || state === "sent";
  return (
    <div
      className={cx("flex min-w-0 flex-col items-end gap-1", linked(position))}
      data-testid="message-user"
      data-state={state ?? ""}
      data-bubble={position}
    >
      <div
        className={cx(
          BUBBLE,
          "max-w-bubble-user bg-bot-bubble text-bot-on-bubble bubble-neutral:bg-bubble-neutral bubble-neutral:text-text",
          linkCorners("user", position),
          pending && "opacity-72",
        )}
        data-testid="bubble-user"
        data-pending={pending}
      >
        <p className="text-body wrap-anywhere whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  );
}

/**
 * A message of the bot: a neutral bubble on the left, no avatar and no name (the chip at the top of
 * the chat says whose it is). `children` replace the bubble (a card) when the message is one.
 */
export function BotMessage({
  text,
  children,
  openUrl,
  favicons,
  position,
  typing = false,
}: {
  position?: BubblePosition | undefined;
  /**
   * The answer is still being written (KOD-34): the screen reader is not told of every piece
   * (`aria-busy`, `aria-live="off"`) and what arrives in each frame fades in (no mark at the end,
   * no letter by letter; reduced motion: no animation). When the
   * recorded text replaces it the same bubble stays, and the text is read once, politely.
   */
  typing?: boolean;
  text?: string;
  children?: ReactNode;
  openUrl?: (url: string) => void;
  favicons?: boolean;
}) {
  const reveal = useLiveReveal(text ?? "", typing && text !== undefined);
  // Still written: typed, or the recorded text taking over has not finished its reveal.
  const writing = text !== undefined && reveal.live;
  return (
    <div
      className={cx("flex min-w-0 items-start", linked(position))}
      data-testid="message-bot"
      data-bubble={position}
      {...(writing
        ? { "aria-busy": true, "aria-live": "off" as const, "data-typing": "true" }
        : {})}
    >
      <div className="flex w-full max-w-reading min-w-0 flex-col gap-3">
        {/* No bubble until the first letter is revealed: an empty one would be a bare pill. */}
        {text !== undefined && !(writing && reveal.shown === "") && (
          <BotBubble className={linkCorners("bot", position)}>
            {/* Another element when it stops typing, so the final text is a new addition that the
                log announces once; the bubble itself stays. */}
            <div key={writing ? "typing" : "final"}>
              <Markdown
                text={writing ? reveal.shown : text}
                {...(reveal.sink === undefined ? {} : { fade: reveal.sink })}
                {...(openUrl === undefined ? {} : { openUrl })}
                {...(favicons === undefined ? {} : { favicons })}
              />
            </div>
          </BotBubble>
        )}
        {children}
      </div>
    </div>
  );
}

/** A small, centred, muted, single line between messages: a day, a time, a system notice. */
export function EventLine({
  children,
  title,
  testId,
}: {
  children: ReactNode;
  /** `false`: no tooltip (the line is not cut). */
  title?: string | false;
  testId?: string;
}) {
  return (
    <p
      className={EVENT_LINE_CLASS}
      title={
        title === false
          ? undefined
          : (title ?? (typeof children === "string" ? children : undefined))
      }
      data-testid={testId ?? "event-line"}
    >
      {children}
    </p>
  );
}

/**
 * An event line between two bots ("Enviou mensagem para Fulano" / "Mensagem de Fulano"), with the
 * other bot's mini mascot. There is no backend for messages between bots until phase 4: nothing
 * renders this yet.
 */
export function InterBotLine({
  direction,
  botName,
  avatar,
  color,
  seed,
}: {
  direction: "to" | "from";
  botName: string;
  avatar: string | null;
  color: import("@suup/api").BotColor | null;
  seed: string;
}) {
  return (
    <p className={EVENT_LINE_CLASS} data-testid="inter-bot-line">
      <Avatar avatar={avatar} color={color} seed={seed} size="xs" />
      <span className="overflow-hidden text-ellipsis">
        {direction === "to" ? "Enviou mensagem para" : "Mensagem de"} {botName}
      </span>
    </p>
  );
}
