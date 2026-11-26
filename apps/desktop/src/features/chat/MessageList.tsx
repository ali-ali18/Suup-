import type { DecideTeamBody, Run } from "@suup/api";
import type { AvatarStateId } from "@suup/avatar";
import { ArrowDown } from "lucide-react";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useServices } from "../../app/context.js";
import { useSettings } from "../../app/settings-store.js";
import { FRIENDLY_FAILURE } from "../../data/derive.js";
import { ACTIVITY_AVATAR, type ChatActivity } from "../../lib/chat-activity.js";
import { cx } from "../../lib/cx.js";
import { SOMETHING_WRONG } from "../../lib/friendly-error.js";
import { useReducedMotion } from "../../lib/reduced-motion.js";
import { ActionList } from "../../ui/action-card.js";
import { EndedLine, WorkingIndicator } from "../../ui/chat-lines.js";
import { BotMessage, EventLine, UserMessage } from "../../ui/message.js";
import { Pill, RoundButton } from "../../ui/primitives.js";
import { QuestionCard } from "../../ui/question-card.js";
import { ScrollFade } from "../../ui/scroll-fade.js";
import { TeamCard } from "../../ui/team-card.js";
import { ApprovalRow, SecretRequestRow } from "./ApprovalRows.js";
import { ConnectCard } from "./ConnectCard.js";
import { FileRows } from "./FileRows.js";
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
  onDismissQuestion,
  onDecideTeam,
  onInspect,
  expanded,
  onToggle,
  phrase,
  activity,
  liveFace,
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
  /** The X of an open question (the message's id): the card locks, the composer takes the focus. */
  onDismissQuestion?(messageId: string): void;
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
  /** What the run on screen is doing now (`chatActivityOf`): the expression of the live avatar. */
  activity: ChatActivity;
  /** The bot's face in a state: the live avatar at the end of the chat while it works. */
  liveFace(state: AvatarStateId): ReactNode;
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
  const logRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const loading = useRef(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const [away, setAway] = useState(false);
  const firstKey = items[0]?.key;
  const positions = useMemo(() => bubblePositions(items), [items]);
  const live = useLiveIndicator(items, runs, activity, phrase);

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
  }, [items, expanded, phrase, activity, firstKey]);

  // The text being written grows inside its bubble, with no new item: follow it to the end while
  // the person is at the end (KOD-34).
  useEffect(() => {
    const el = ref.current;
    const log = logRef.current;
    if (el === null || log === null || typeof ResizeObserver === "undefined") return;
    const watcher = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    watcher.observe(log);
    return () => watcher.disconnect();
  }, []);

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
          ref={logRef}
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
                // A question with choices: the card, ALWAYS apart, with the question as its title
                // (owner, 24/11/2026). A bubble above it only when the bot wrote more than the
                // question (`ask.lead`), so the question is never shown twice. An open question
                // (no options) is only the bubble.
                return isChoiceCard(item) && item.ask !== undefined ? (
                  <Fragment key={item.key}>
                    {item.ask.lead !== undefined && (
                      <BotMessage
                        text={item.ask.lead}
                        position={positions.get(item.key)}
                        openUrl={platform.openUrl}
                        favicons={favicons}
                      />
                    )}
                    {
                      <BotMessage>
                        <QuestionCard
                          questions={item.ask.questions}
                          answer={item.ask.answer ?? (item.ask.open ? undefined : "")}
                          dismissed={item.ask.dismissed}
                          autoFocus={item.ask.open}
                          onSubmit={onAnswer}
                          {...(item.ask.open && onDismissQuestion !== undefined
                            ? { onDismiss: () => onDismissQuestion(item.key) }
                            : {})}
                        />
                        {item.ask.open && (
                          // Outside the card: the chat answers too (any text is the answer).
                          <p
                            className="pl-5 text-small text-text-muted"
                            data-testid="question-hint"
                          >
                            Ou responda no chat abaixo
                          </p>
                        )}
                      </BotMessage>
                    }
                  </Fragment>
                ) : (
                  <BotMessage
                    key={item.key}
                    text={item.text}
                    position={positions.get(item.key)}
                    openUrl={platform.openUrl}
                    favicons={favicons}
                    typing={item.live === true}
                  />
                );
              case "files":
                return (
                  <BotMessage key={item.key}>
                    <FileRows files={item.files} />
                  </BotMessage>
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
              case "connect":
                return (
                  <BotMessage key={item.key}>
                    <ConnectCard card={item.card} botName={botName} />
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
              default:
                return null;
            }
          })}
          {live.shown !== null && (
            // One element for the whole life of the run (keyed by it), so the face keeps its
            // motion when the run ends and the "done" expression plays while the row leaves.
            <WorkingIndicator
              key={`working-${live.shown.runId}`}
              phrase={live.shown.phrase}
              activity={live.shown.activity}
              face={liveFace(ACTIVITY_AVATAR[live.shown.activity])}
              leaving={live.leaving}
              onLeft={live.left}
            />
          )}
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

/** How long the leaving row waits for its transition before going anyway (a safety net). */
const LEAVE_FALLBACK_MS = 1500;

interface LiveRow {
  runId: string;
  activity: ChatActivity;
  phrase: string;
}

/**
 * The live avatar at the end of the chat: while the timeline has the working item, the run's
 * activity and phrase; when it goes (the run ended, the bot's answer is there), the same row stays
 * for its leaving transition with the face of the end ("done", or "failed" for a run that failed or
 * was cancelled) and is dropped when the transition ends. Reduced motion drops it at once.
 */
export function useLiveIndicator(
  items: readonly TimelineItem[],
  runs: Record<string, Run>,
  activity: ChatActivity,
  phrase: string,
): { shown: LiveRow | null; leaving: boolean; left(): void } {
  const reduced = useReducedMotion();
  const working = items.find((item) => item.kind === "working");
  const runId = working?.kind === "working" ? working.runId : undefined;
  const [row, setRow] = useState<{ live: LiveRow; leaving: boolean } | null>(null);
  // Adjusted while rendering (not in an effect), so the row is never unmounted between the run
  // ending and its leaving: the same element changes its classes, and the face its expression.
  if (runId !== undefined) {
    const live = row?.live;
    if (
      row === null ||
      row.leaving ||
      live?.runId !== runId ||
      live.activity !== activity ||
      live.phrase !== phrase
    ) {
      setRow({ live: { runId, activity, phrase }, leaving: false });
    }
  } else if (row !== null && !row.leaving) {
    const status = runs[row.live.runId]?.status;
    setRow(
      reduced
        ? null
        : { live: { ...row.live, activity: status === "done" ? "done" : "failed" }, leaving: true },
    );
  }

  const left = useCallback(() => setRow((r) => (r?.leaving === true ? null : r)), []);
  const leaving = row?.leaving === true;
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(left, LEAVE_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [leaving, left]);

  return { shown: row?.live ?? null, leaving, left };
}
