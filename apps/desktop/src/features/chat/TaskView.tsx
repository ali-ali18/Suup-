import type { Bot, Run, Task } from "@suup/api";
import { ChevronLeft, CornerUpLeft, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { callSeqsOf } from "../../data/call-seq.js";
import { planOf } from "../../data/derive.js";
import { liveView } from "../../data/live.js";
import { orderedEvents, orderedMessages } from "../../data/reducers.js";
import { NEW_REPLIES_TEXT, TASK_STATE_TEXT, taskIsOpen } from "../../data/task-text.js";
import { activityPhrase, chatActivityOf } from "../../lib/chat-activity.js";
import { cx } from "../../lib/cx.js";
import { Avatar } from "../../ui/avatar.js";
import { Composer } from "../../ui/composer.js";
import { EventLine } from "../../ui/message.js";
import { Pill } from "../../ui/primitives.js";
import { MessageList } from "./MessageList.js";
import { buildTimeline } from "./timeline.js";

/**
 * The own view of a task (KOD-68, docs/DESIGN.md, "Tarefas"): in the place of the chat, with its
 * title, its state and how many updates it brought, the messages of the task's conversation (what
 * the bot did and asked, and what you answered) and a box that writes straight to the task. Its
 * approval cards are NOT here: they appear in the chat that asked, with the name of the task.
 */
export function TaskView({ task, bot, onBack }: { task: Task; bot: Bot; onBack(): void }) {
  const { sync } = useServices();
  const runs = useData((s) => s.runs);
  const slice = useData((s) => s.messages[task.taskConversationId]);
  const eventsByRun = useData((s) => s.events);
  const liveBlocks = useData((s) => s.live);
  const [restore, setRestore] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // The conversation of the task is on screen: fetch it and keep it fresh.
  useEffect(() => {
    void sync.watchConversation(task.taskConversationId);
    return () => sync.unwatchConversation(task.taskConversationId);
  }, [sync, task.taskConversationId]);

  // Opening the view (and every reply that arrives while it is open) counts as reading the task.
  useEffect(() => {
    if (task.unreadReplies > 0) void sync.markTaskRead(task.id);
  }, [sync, task.id, task.unreadReplies]);

  const messages = useMemo(() => orderedMessages(slice), [slice]);
  const taskRuns = useMemo(
    () =>
      Object.fromEntries(
        Object.values(runs)
          .filter((r) => r.conversationId === task.taskConversationId)
          .map((r) => [r.id, r]),
      ) as Record<string, Run>,
    [runs, task.taskConversationId],
  );
  const run = runs[task.runId];
  const events = useMemo(() => orderedEvents(eventsByRun[task.runId]), [eventsByRun, task.runId]);
  const callSeqs = useMemo(() => callSeqsOf(task.runId, events), [task.runId, events]);
  const live = useMemo(
    () => liveView(liveBlocks, new Set(Object.keys(taskRuns))),
    [liveBlocks, taskRuns],
  );
  const items = useMemo(
    () => buildTimeline(messages, taskRuns, new Date(), { callSeqs, live }),
    [messages, taskRuns, callSeqs, live],
  );
  const open = taskIsOpen(task);

  const active = run !== undefined && taskIsOpen(task) ? run : undefined;
  const activity = chatActivityOf(active ?? null, active === undefined ? [] : events) ?? "thinking";
  const phrase = activityPhrase(
    activity,
    active ?? null,
    active === undefined || run === undefined ? [] : planOf(run, events),
  );

  const toggle = useCallback(
    (key: string) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );
  const send = useCallback(
    async (text: string) => {
      const result = await sync.replyToTask(task, text);
      if (!result.ok) setRestore((r) => ({ text: result.text, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [sync, task],
  );

  // What the task waits for the person to answer: the open question the run posted (structure:
  // `message.question`), shown in its own block above the composer, never twice in the log.
  const pending = items.findLast((i) => i.kind === "bot" && i.ask?.open === true);
  const shownItems = useMemo(
    () => (pending === undefined ? items : items.filter((i) => i !== pending)),
    [items, pending],
  );
  const focusMessage = useUi((s) => s.focusMessage);
  const showInChat = (messageId: string) => {
    focusMessage(messageId);
    onBack();
  };
  const stateText = task.unreadReplies > 0 ? NEW_REPLIES_TEXT : TASK_STATE_TEXT[task.state];

  return (
    <section
      className="flex min-h-0 min-w-chat-min flex-[1_0_var(--width-chat-min)] flex-col"
      aria-label={`Tarefa: ${task.title}`}
      data-testid="task-view"
      data-task={task.id}
      data-task-state={task.state}
    >
      <header
        className="flex flex-none flex-col gap-3 px-6 pt-5 pb-3 framed:pr-head-end"
        data-testid="task-head"
        data-tauri-drag-region
      >
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h2
              className="truncate text-title font-label"
              data-testid="task-title"
              title={task.title}
            >
              {task.title}
            </h2>
            <span
              className={cx(
                "inline-flex w-fit items-center rounded-pill border border-border px-2.5 py-0.5 text-small",
                task.unreadReplies > 0 ? "text-status-unread" : "text-text-muted",
              )}
              data-testid="task-state"
            >
              {stateText}
            </span>
          </div>
          {open && (
            <Pill
              tone="danger"
              icon={<Square size={14} aria-hidden="true" />}
              onClick={() => void sync.stopTask(task.id)}
              data-testid="task-stop"
            >
              Parar
            </Pill>
          )}
          <Pill
            tone="secondary"
            icon={<ChevronLeft size={16} aria-hidden="true" />}
            onClick={onBack}
            data-testid="task-back"
          >
            Voltar ao chat
          </Pill>
        </div>
        {task.sourceMessages.length > 0 && (
          <blockquote
            className="m-0 flex min-w-0 flex-col gap-1.5 border-0 border-l-2 border-border-strong py-0.5 pl-3"
            data-testid="task-request"
          >
            <span className="text-small text-text-muted">Pedido</span>
            {task.sourceMessages.map((m) => (
              <p
                key={m.id}
                className="line-clamp-3 text-body wrap-anywhere whitespace-pre-wrap"
                data-testid="task-request-text"
              >
                {m.text}
              </p>
            ))}
            <button
              type="button"
              className="inline-flex w-fit cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-small text-text-muted underline underline-offset-3 hover:text-text"
              data-testid="task-request-link"
              onClick={() => showInChat((task.sourceMessages[0] as { id: string }).id)}
            >
              <CornerUpLeft size={14} aria-hidden="true" />
              Ver na conversa
            </button>
          </blockquote>
        )}
      </header>
      <MessageList
        items={shownItems}
        botName={bot.name}
        hasOlder={slice?.hasOlder ?? false}
        onLoadOlder={() => sync.loadOlderMessages(task.taskConversationId)}
        runs={taskRuns}
        // A click on an option of the task's question answers the task, in its own box.
        onAnswer={(text) => void send(text)}
        onDecideTeam={async () => ({ ok: false, message: "" })}
        onInspect={() => undefined}
        expanded={expanded}
        onToggle={toggle}
        phrase={phrase}
        activity={activity}
        hideIndicator={task.state === "waiting_user"}
        liveFace={(state) => (
          <Avatar
            avatar={bot.avatar}
            avatarStyle={bot.avatarStyle}
            pixel3d={bot.avatarPixel3d}
            color={bot.color}
            seed={bot.id}
            size="md"
            state={state}
            lively
          />
        )}
        announce={
          messages.length === 0 ? "" : `Tarefa ${task.title}: ${TASK_STATE_TEXT[task.state]}`
        }
        empty={<EventLine testId="task-empty">A tarefa ainda não trouxe atualizações.</EventLine>}
      />
      <div
        className="mx-auto flex w-full max-w-[calc(var(--width-content)+var(--space-5)*2)] flex-none flex-col gap-3 px-5 pt-2 pb-5"
        data-testid="task-composer"
      >
        {pending?.kind === "bot" && pending.ask !== undefined && open && (
          <div
            className="flex flex-col gap-2 rounded-card border border-border bg-raised px-4 py-3"
            data-testid="task-question"
          >
            <span className="text-small text-text-muted">A tarefa pergunta</span>
            {pending.ask.questions.map((q) => (
              <div key={q.question} className="flex flex-col gap-2">
                <p className="text-body wrap-anywhere whitespace-pre-wrap">{q.question}</p>
                {q.options !== undefined && (
                  <div className="flex flex-wrap gap-2">
                    {q.options.map((o) => (
                      <Pill
                        key={o.label}
                        tone="secondary"
                        size="sm"
                        onClick={() => void send(o.label)}
                        data-testid="task-question-option"
                      >
                        {o.label}
                      </Pill>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <Composer
          placeholder="Adicione uma resposta"
          disabled={!open}
          disabledReason="Esta tarefa terminou"
          restore={restore}
          onSend={(text) => void send(text)}
          autoFocus
        />
      </div>
    </section>
  );
}
