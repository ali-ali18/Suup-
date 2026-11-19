import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "../lib/cx.js";
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
      className={cx(
        "ui-bubble--bot",
        BUBBLE,
        "max-w-full self-start border border-border bg-surface",
        className,
      )}
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
        // `ui-bubble--user` and `ui-bubble--pending` are hooks (tests, screens), not styles.
        className={cx(
          "ui-bubble--user",
          BUBBLE,
          "max-w-bubble-user bg-bot-bubble text-bot-on-bubble bubble-neutral:bg-bubble-neutral bubble-neutral:text-text",
          linkCorners("user", position),
          pending && "ui-bubble--pending opacity-72",
        )}
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
}: {
  position?: BubblePosition | undefined;
  text?: string;
  children?: ReactNode;
  openUrl?: (url: string) => void;
  favicons?: boolean;
}) {
  return (
    <div
      className={cx("flex min-w-0 items-start", linked(position))}
      data-testid="message-bot"
      data-bubble={position}
    >
      <div className="flex w-full max-w-reading min-w-0 flex-col gap-3">
        {text !== undefined && (
          <BotBubble className={linkCorners("bot", position)}>
            <Markdown
              text={text}
              {...(openUrl === undefined ? {} : { openUrl })}
              {...(favicons === undefined ? {} : { favicons })}
            />
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
