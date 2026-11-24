import type { DecideTeamBody, Run } from "@suup/api";
import { ArrowDown } from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useServices } from "../../app/context.js";
import { useSettings } from "../../app/settings-store.js";
import { FRIENDLY_FAILURE } from "../../data/derive.js";
import { cx } from "../../lib/cx.js";
import { SOMETHING_WRONG } from "../../lib/friendly-error.js";
import { ActionFold, ActionList } from "../../ui/action-card.js";
import { EndedLine, WorkingIndicator } from "../../ui/chat-lines.js";
import { BotMessage, EventLine, UserMessage } from "../../ui/message.js";
import { Pill, RoundButton } from "../../ui/primitives.js";
import { QuestionCard } from "../../ui/question-card.js";
import { ScrollFade } from "../../ui/scroll-fade.js";
import { TeamCard } from "../../ui/team-card.js";
import { ApprovalRow, CallRow, callKey, SecretRequestRow } from "./ApprovalRows.js";
import { bubblePositions, isChoiceCard, type TimelineItem } from "./timeline.js";

const NEAR_BOTTOM = 80;
const FAR_FROM_BOTTOM = 240;
const NEAR_TOP = 120;

/**
 * The messages: a log that sticks to the bottom while new ones arrive (unless the person scrolled
 * up to read), loads older ones when scrolled to the top (keeping the place), shows a round button
 * to jump to the end when scrolled up, and is announced to screen readers as it grows.
 */
export function MessageList({
  items,
  runs,
  botName,
  hasOlder,
  onLoadOlder,
  onAnswer,
  onDecideTeam,
  onInspect,
  expanded,
  onToggle,
  phrase,
  announce,
  empty,
  head,
}: {
  items: readonly TimelineItem[];
  runs: Record<string, Run>;
  botName: string;
  hasOlder: boolean;
  onLoadOlder(): Promise<boolean>;
  /** The answer to a question (plain text): it is sent as the user's message. */
  onAnswer(text: string): void;
  /** The user's decision on a team card. Resolves when the server has answered. */
  onDecideTeam(
    messageId: string,
    body: DecideTeamBody,
  ): Promise<{ ok: true } | { ok: false; message: string }>;
  onInspect(runId: string): void;
  /** Keys (call ids, fold ids, message ids) of what is expanded. */
  expanded: ReadonlySet<string>;
  onToggle(key: string): void;
  /** What the working indicator says. */
  phrase: string;
  /** A short text for the live region (a new bot message). */
  announce: string;
  /**
   * What floats over the top of the log (the bot's pill): on a fade from the page's colour to
   * transparent, so the messages melt under it instead of being cut by a hard edge ("Nada seco").
   */
  head?: ReactNode;
  empty?: ReactNode;
}) {
  const { platform } = useServices();
  const favicons = useSettings((s) => s.settings.favicons === "on");
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const loading = useRef(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const [away, setAway] = useState(false);
  const firstKey = items[0]?.key;
  const positions = useMemo(() => bubblePositions(items), [items]);

  const onScroll = () => {
    const el = ref.current;
    if (el === null) return;
    const gap = el.scrollHeight - el.scrollTop - el.clientHeight;
    stick.current = gap < NEAR_BOTTOM;
    setAway(gap > FAR_FROM_BOTTOM);
    if (el.scrollTop < NEAR_TOP && hasOlder && !loading.current) {
      loading.current = true;
      anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      void onLoadOlder().finally(() => {
        loading.current = false;
      });
    }
  };

  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    if (anchor.current !== null) {
      el.scrollTop = anchor.current.top + (el.scrollHeight - anchor.current.height);
      anchor.current = null;
      return;
    }
    if (stick.current) el.scrollTop = el.scrollHeight;
  }, [items, expanded, phrase, firstKey]);

  // The first fill may not reach the top of a tall window: ask for more until it does.
  useEffect(() => {
    const el = ref.current;
    if (el !== null && hasOlder && !loading.current && el.scrollHeight <= el.clientHeight + 4) {
      loading.current = true;
      void onLoadOlder().finally(() => {
        loading.current = false;
      });
    }
  }, [hasOlder, items.length, onLoadOlder]);

  const toEnd = () => {
    const el = ref.current;
    if (el === null) return;
    stick.current = true;
    const calm =
      document.documentElement.dataset.motion === "reduce" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    el.scrollTo({ top: el.scrollHeight, behavior: calm ? "auto" : "smooth" });
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={ref}
        className={cx(
          "min-h-0 flex-1 overflow-y-auto px-5 pb-4",
          head === undefined ? "pt-4" : "pt-chat-head",
        )}
        onScroll={onScroll}
        data-testid="message-scroll"
      >
        <div
          className="mx-auto flex w-full max-w-content flex-col gap-(--chat-gap)"
          data-testid="chat-log"
          role="log"
          aria-label={`Conversa com ${botName}`}
          aria-live="polite"
          aria-relevant="additions text"
        >
          {hasOlder && (
            <EventLine testId="loading-older" title={false}>
              Carregando mensagens anteriores…
            </EventLine>
          )}
          {items.length === 0 && empty}
          {items.map((item) => {
            switch (item.kind) {
              case "separator":
                return (
                  <EventLine key={item.key} testId="separator" title={false}>
                    {item.text}
                  </EventLine>
                );
              case "notice":
                return (
                  <EventLine key={item.key} testId="message-system">
                    {item.text}
                  </EventLine>
                );
              case "user":
                return (
                  <UserMessage
                    key={item.key}
                    text={item.text}
                    position={positions.get(item.key)}
                    {...(item.state === undefined ? {} : { state: item.state })}
                  />
                );
              case "bot":
                // A question with choices: the bot's bubble with the question, then, ALWAYS apart
                // and under it, the card of options (owner, 24/11/2026). An open question is only
                // the bubble.
                return isChoiceCard(item) && item.ask !== undefined ? (
                  <Fragment key={item.key}>
                    <BotMessage
                      text={item.text}
                      position={positions.get(item.key)}
                      openUrl={platform.openUrl}
                      favicons={favicons}
                    />
                    <BotMessage>
                      <QuestionCard
                        questions={item.ask.questions}
                        answer={item.ask.answer ?? (item.ask.open ? undefined : "")}
                        autoFocus={item.ask.open}
                        onSubmit={onAnswer}
                      />
                    </BotMessage>
                  </Fragment>
                ) : (
                  <BotMessage
                    key={item.key}
                    text={item.text}
                    position={positions.get(item.key)}
                    openUrl={platform.openUrl}
                    favicons={favicons}
                  />
                );
              case "team":
                return (
                  <BotMessage key={item.key}>
                    <TeamCard
                      seed={item.messageId}
                      team={item.team}
                      botName={botName}
                      expanded={expanded.has(item.key)}
                      onToggle={() => onToggle(item.key)}
                      onDecide={(body) => onDecideTeam(item.messageId, body)}
                    />
                  </BotMessage>
                );
              case "actions":
                return (
                  <BotMessage key={item.key}>
                    <ActionList data-testid="actions">
                      {item.entries.map((entry) =>
                        entry.kind === "action" ? (
                          <CallRow
                            key={callKey(entry.item)}
                            item={entry.item}
                            clicked={expanded}
                            onToggle={onToggle}
                          />
                        ) : (
                          <ActionFold
                            key={entry.key}
                            count={entry.items.length}
                            expanded={expanded.has(entry.key)}
                            onToggle={() => onToggle(entry.key)}
                          >
                            {entry.items.map((it) => (
                              <CallRow
                                key={callKey(it)}
                                item={it}
                                clicked={expanded}
                                onToggle={onToggle}
                              />
                            ))}
                          </ActionFold>
                        ),
                      )}
                    </ActionList>
                  </BotMessage>
                );
              case "approval":
                return (
                  <BotMessage key={item.key}>
                    <ActionList>
                      <ApprovalRow
                        approval={item.approval}
                        clicked={expanded}
                        onToggle={onToggle}
                        autoFocus={item.approval.status === "pending"}
                      />
                    </ActionList>
                  </BotMessage>
                );
              case "secret":
                return (
                  <BotMessage key={item.key}>
                    <ActionList>
                      <SecretRequestRow
                        request={item.request}
                        clicked={expanded}
                        onToggle={onToggle}
                        autoFocus={item.request.state === "open"}
                      />
                    </ActionList>
                  </BotMessage>
                );
              case "ended": {
                const run = runs[item.runId];
                return (
                  <EndedLine
                    key={item.key}
                    text={item.text}
                    expanded={expanded.has(item.key)}
                    onToggle={() => onToggle(item.key)}
                  >
                    {run?.status === "failed" && (
                      <>
                        {/* One friendly sentence by the origin; the detail is in the Inspector. */}
                        <p data-testid="ended-origin" data-origin={run.failureOrigin ?? "harness"}>
                          {FRIENDLY_FAILURE[run.failureOrigin ?? "harness"] ?? SOMETHING_WRONG}
                        </p>
                      </>
                    )}
                    {run?.status === "cancelled" && (
                      <p>A execução foi cancelada antes de terminar.</p>
                    )}
                    <Pill tone="ghost" onClick={() => onInspect(item.runId)}>
                      Abrir no inspetor
                    </Pill>
                  </EndedLine>
                );
              }
              case "working":
                return (
                  <WorkingIndicator
                    key={item.key}
                    phrase={phrase}
                    animated={phrase !== "Pausado"}
                  />
                );
              default:
                return null;
            }
          })}
        </div>
        <div className="sr-only" aria-live="polite" data-testid="live-region">
          {announce}
        </div>
      </div>
      {head !== undefined && (
        <header
          className="absolute inset-x-0 top-0 z-10 flex h-chat-head justify-center bg-linear-to-b from-bg from-40% to-transparent px-4 pt-3"
          data-testid="chat-head"
          data-tauri-drag-region
        >
          {head}
        </header>
      )}
      <ScrollFade edges={["bottom"]} />
      {away && (
        <div className="absolute bottom-3 left-1/2 z-20 -translate-x-1/2">
          <RoundButton
            label="Ir para o fim da conversa"
            tone="raised"
            onClick={toEnd}
            data-testid="jump-to-end"
          >
            <ArrowDown size={18} aria-hidden="true" />
          </RoundButton>
        </div>
      )}
    </div>
  );
}
