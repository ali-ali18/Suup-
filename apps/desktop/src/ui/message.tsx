import type { ReactNode } from "react";
import { Markdown } from "../lib/markdown.js";
import { Avatar } from "./avatar.js";

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
  return (
    <div
      className="ui-msg ui-msg--user"
      data-testid="message-user"
      data-state={state ?? ""}
      data-bubble={position}
    >
      <div
        className={`ui-bubble ui-bubble--user${state === "sending" || state === "sent" ? " ui-bubble--pending" : ""}`}
      >
        <p className="ui-bubble__text wrap">{text}</p>
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
    <div className="ui-msg ui-msg--bot" data-testid="message-bot" data-bubble={position}>
      <div className="ui-msg__col">
        {text !== undefined && (
          <div className="ui-bubble ui-bubble--bot">
            <Markdown
              text={text}
              {...(openUrl === undefined ? {} : { openUrl })}
              {...(favicons === undefined ? {} : { favicons })}
            />
          </div>
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
  title?: string;
  testId?: string;
}) {
  return (
    <p
      className="ui-event"
      title={title ?? (typeof children === "string" ? children : undefined)}
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
    <p className="ui-event ui-event--bot" data-testid="inter-bot-line">
      <Avatar avatar={avatar} color={color} seed={seed} size="xs" />
      <span className="ui-event__text">
        {direction === "to" ? "Enviou mensagem para" : "Mensagem de"} {botName}
      </span>
    </p>
  );
}
