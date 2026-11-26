import type { Bot, Run, Task } from "@suup/api";
import { CornerUpLeft, Ellipsis, Square, X } from "lucide-react";
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
import { MenuButton } from "../../ui/menu.js";
import { EventLine } from "../../ui/message.js";
import { RoundButton } from "../../ui/primitives.js";
import { MessageList } from "../chat/MessageList.js";
import { buildTimeline } from "../chat/timeline.js";

/**
 * A task's own panel (KOD-68, docs/DESIGN.md 4d): the third column while a task is open, in the
 * place of the bot's panel, like a thread's side panel. The chat stays in the middle. Header with
 * the name, the state and the close; the message(s) that opened the task, quoted, with a way back
 * to them in the chat; the task's conversation in the chat's own bubbles (its open question is a
 * normal question card); and the box that writes straight to the task.
 */
export function TaskPanel({ task, bot }: { task: Task; bot: Bot }) {
  const { sync } = useServices();
  const runs = useData((s) => s.runs);
  const slice = useData((s) => s.messages[task.taskConversationId]);
  const eventsByRun = useData((s) => s.events);
  const liveBlocks = useData((s) => s.live);
  const openTask = useUi((s) => s.openTask);
  const openPanel = useUi((s) => s.openPanel);
  const focusMessage = useUi((s) => s.focusMessage);
  const [restore, setRestore] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  // The conversation of the task is on screen: fetch it and keep it fresh.
  useEffect(() => {
    void sync.watchConversation(task.taskConversationId);
    return () => sync.unwatchConversation(task.taskConversationId);
  }, [sync, task.taskConversationId]);

  // The panel showing the task (and every reply that arrives meanwhile) counts as reading it.
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
  const active = run !== undefined && open ? run : undefined;
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
  const close = () => {
    openTask(null);
    openPanel();
  };
  const stateText = task.unreadReplies > 0 ? NEW_REPLIES_TEXT : TASK_STATE_TEXT[task.state];
  const first = task.sourceMessages[0];

  return (
    <aside
      className="relative flex min-h-0 min-w-0 flex-[0_1_var(--panel-w,var(--width-panel))] flex-col border-l border-border"
      aria-label={`Tarefa: ${task.title}`}
      data-testid="task-panel"
      data-task={task.id}
      data-task-state={task.state}
    >
      {/* One bar: the name in a pill like the bot's pill at the top of the chat, the state beside the
          name inside it, and the menu and the close at the right, on the same line. */}
      <header
        className="grid flex-none grid-cols-[1fr_auto_1fr] items-center gap-2 px-4 pt-3 pb-3 framed:pr-head-end"
        data-testid="task-head"
        data-tauri-drag-region
      >
        <span aria-hidden="true" />
        <div
          className="inline-flex h-11 max-w-bot-chip min-w-0 items-center gap-2 rounded-pill border border-border-strong bg-bg px-4 text-label"
          data-testid="task-pill"
        >
          <h2
            className="min-w-0 truncate text-label font-label"
            data-testid="task-title"
            title={task.title}
          >
            {task.title}
          </h2>
          <span
            className={cx(
              "flex-none text-small",
              task.unreadReplies > 0 ? "text-status-unread" : "text-text-muted",
            )}
            data-testid="task-state"
          >
            {stateText}
          </span>
        </div>
        <div className="flex items-center justify-end gap-1.5">
          {open && (
            <MenuButton
              label="Mais opções da tarefa"
              icon={<Ellipsis size={16} aria-hidden="true" />}
              width="normal"
              items={[
                {
                  id: "stop",
                  label: "Parar",
                  icon: Square,
                  danger: true,
                  testId: "task-stop",
                  onSelect: () => void sync.stopTask(task.id),
                },
              ]}
            />
          )}
          <RoundButton
            label="Fechar a tarefa"
            tone="outline"
            size="xs"
            onClick={close}
            data-testid="task-close"
          >
            <X size={14} aria-hidden="true" />
          </RoundButton>
        </div>
      </header>
      {first !== undefined && (
        <div
          className="flex flex-none flex-col items-start gap-2 px-5 pb-3"
          data-testid="task-request"
        >
          {task.sourceMessages.map((m) => (
            <blockquote
              key={m.id}
              className="m-0 line-clamp-3 max-w-full border-0 border-l-2 border-border-strong py-0.5 pl-3 text-small wrap-anywhere whitespace-pre-wrap text-text-muted"
              data-testid="task-request-text"
            >
              {m.text}
            </blockquote>
          ))}
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-small text-text-muted hover:text-text hover:underline"
            data-testid="task-request-link"
            onClick={() => focusMessage(first.id)}
          >
            <CornerUpLeft size={14} aria-hidden="true" />
            Ver na conversa
          </button>
        </div>
      )}
      <MessageList
        items={items}
        botName={bot.name}
        hasOlder={slice?.hasOlder ?? false}
        onLoadOlder={() => sync.loadOlderMessages(task.taskConversationId)}
        runs={taskRuns}
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
      {open ? (
        <div className="flex-none px-4 pt-2 pb-4" data-testid="task-composer">
          <Composer
            placeholder="Adicione uma resposta"
            restore={restore}
            onSend={(text) => void send(text)}
            autoFocus
          />
        </div>
      ) : (
        <p
          className="m-0 flex-none px-5 pt-2 pb-5 text-center text-small text-text-muted"
          data-testid="task-finished"
        >
          Esta tarefa terminou.
        </p>
      )}
    </aside>
  );
}
