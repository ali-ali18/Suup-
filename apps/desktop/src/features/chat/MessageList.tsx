import type { Run } from "@suup/api";
import { ArrowDown } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useServices } from "../../app/context.js";
import { useSettings } from "../../app/settings-store.js";
import { failureOriginLabel, ORIGIN_EXPLANATION } from "../../data/derive.js";
import { ActionFold } from "../../ui/action-card.js";
import { EndedLine, WorkingIndicator } from "../../ui/chat-lines.js";
import { BotMessage, EventLine, UserMessage } from "../../ui/message.js";
import { Pill, RoundButton } from "../../ui/primitives.js";
import { QuestionCard } from "../../ui/question-card.js";
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
  onInspect,
  expanded,
  onToggle,
  phrase,
  announce,
  empty,
}: {
  items: readonly TimelineItem[];
  runs: Record<string, Run>;
  botName: string;
  hasOlder: boolean;
  onLoadOlder(): Promise<boolean>;
  /** The answer to a question (plain text): it is sent as the user's message. */
  onAnswer(text: string): void;
  onInspect(runId: string): void;
  /** Keys (call ids, fold ids, message ids) of what is expanded. */
  expanded: ReadonlySet<string>;
  onToggle(key: string): void;
  /** What the working indicator says. */
  phrase: string;
  /** A short text for the live region (a new bot message). */
  announce: string;
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
    <div className="chat__scrollwrap">
      <div ref={ref} className="chat__scroll" onScroll={onScroll} data-testid="message-scroll">
        <div
          className="chat__log"
          role="log"
          aria-label={`Conversa com ${botName}`}
          aria-live="polite"
          aria-relevant="additions text"
        >
          {hasOlder && (
            <p className="ui-event" data-testid="loading-older">
              Carregando mensagens anteriores…
            </p>
          )}
          {items.length === 0 && empty}
          {items.map((item) => {
            switch (item.kind) {
              case "separator":
                return (
                  <p key={item.key} className="ui-event" data-testid="separator">
                    {item.text}
                  </p>
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
                // A question with choices is a card; an open one is an ordinary bubble.
                return isChoiceCard(item) && item.ask !== undefined ? (
                  <BotMessage key={item.key}>
                    <QuestionCard
                      questions={item.ask.questions}
                      answer={item.ask.answer ?? (item.ask.open ? undefined : "")}
                      autoFocus={item.ask.open}
                      onSubmit={onAnswer}
                    />
                  </BotMessage>
                ) : (
                  <BotMessage
                    key={item.key}
                    text={item.text}
                    position={positions.get(item.key)}
                    openUrl={platform.openUrl}
                    favicons={favicons}
                  />
                );
              case "actions":
                return (
                  <BotMessage key={item.key}>
                    <div className="ui-actions" data-testid="actions">
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
                    </div>
                  </BotMessage>
                );
              case "approval":
                return (
                  <BotMessage key={item.key}>
                    <div className="ui-actions">
                      <ApprovalRow
                        approval={item.approval}
                        clicked={expanded}
                        onToggle={onToggle}
                        autoFocus={item.approval.status === "pending"}
                      />
                    </div>
                  </BotMessage>
                );
              case "secret":
                return (
                  <BotMessage key={item.key}>
                    <div className="ui-actions">
                      <SecretRequestRow
                        request={item.request}
                        clicked={expanded}
                        onToggle={onToggle}
                        autoFocus={item.request.state === "open"}
                      />
                    </div>
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
                        <p data-testid="ended-origin" data-origin={run.failureOrigin ?? "harness"}>
                          Origem: {failureOriginLabel(run.failureOrigin)}.{" "}
                          {ORIGIN_EXPLANATION[run.failureOrigin ?? "harness"]}
                        </p>
                        {run.failureDetail !== null && (
                          <pre className="ui-action__pre ui-action__pre--error">
                            {run.failureDetail}
                          </pre>
                        )}
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
      {away && (
        <div className="chat__jump">
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
