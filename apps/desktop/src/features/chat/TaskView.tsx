import type { Bot, Run, Task } from "@suup/api";
import { ChevronLeft } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { callSeqsOf } from "../../data/call-seq.js";
import { deriveRunDisplay, planOf } from "../../data/derive.js";
import { liveView } from "../../data/live.js";
import { orderedEvents, orderedMessages } from "../../data/reducers.js";
import { TASK_STATE_TEXT, taskIsOpen, updatesText } from "../../data/task-text.js";
import { activityPhrase, chatActivityOf } from "../../lib/chat-activity.js";
import { Avatar } from "../../ui/avatar.js";
import { Composer } from "../../ui/composer.js";
import { EventLine } from "../../ui/message.js";
import { RoundButton } from "../../ui/primitives.js";
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
  const updates = messages.filter((m) => m.authorKind === "bot").length;
  const open = taskIsOpen(task);

  const active = run !== undefined && taskIsOpen(task) ? run : undefined;
  const display = deriveRunDisplay(active ?? null, active === undefined ? [] : events);
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

  return (
    <section
      className="flex min-h-0 min-w-chat-min flex-[1_0_var(--width-chat-min)] flex-col"
      aria-label={`Tarefa: ${task.title}`}
      data-testid="task-view"
      data-task={task.id}
      data-task-state={task.state}
    >
      <MessageList
        head={
          <div className="flex h-11 max-w-full min-w-0 items-center gap-2">
            <RoundButton label="Voltar para a conversa" onClick={onBack} data-testid="task-back">
              <ChevronLeft size={18} aria-hidden="true" />
            </RoundButton>
            <div
              className="flex h-11 max-w-bot-chip min-w-0 items-center gap-2.5 rounded-pill border border-border-strong bg-bg py-0 pr-4 pl-2"
              data-testid="task-head"
            >
              <Avatar
                avatar={bot.avatar}
                avatarStyle={bot.avatarStyle}
                pixel3d={bot.avatarPixel3d}
                color={bot.color}
                seed={bot.id}
                size="sm"
                state={display.avatar}
                supervisor={bot.isDefault}
              />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-label font-label" data-testid="task-title">
                  {task.title}
                </span>
                <span className="truncate text-small text-text-muted" data-testid="task-subtitle">
                  <span data-testid="task-state">{TASK_STATE_TEXT[task.state]}</span>
                  {" · "}
                  <span data-testid="task-updates">{updatesText(updates)}</span>
                </span>
              </div>
            </div>
          </div>
        }
        items={items}
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
        className="mx-auto w-full max-w-[calc(var(--width-content)+var(--space-5)*2)] flex-none px-5 pt-2 pb-5"
        data-testid="task-composer"
      >
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
