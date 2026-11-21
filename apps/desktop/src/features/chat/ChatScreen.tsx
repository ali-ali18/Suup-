import type { Run } from "@suup/api";
import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useSettings } from "../../app/settings-store.js";
import { useUi } from "../../app/ui-store.js";
import { actionsOf, VISIBLE_ACTIONS, workingPhrase } from "../../data/actions.js";
import { deriveRunDisplay, planOf } from "../../data/derive.js";
import {
  approvalsOfConversation,
  isTerminal,
  orderedEvents,
  orderedMessages,
} from "../../data/reducers.js";
import { secretRequestsOf } from "../../data/secret-requests.js";
import { cx } from "../../lib/cx.js";
import { colorVars, effectiveColor } from "../../lib/mascots.js";
import { Avatar } from "../../ui/avatar.js";
import { BotTitle } from "../../ui/bot-title.js";
import { EventLineButton } from "../../ui/chat-lines.js";
import { Composer } from "../../ui/composer.js";
import type { MenuItem } from "../../ui/menu.js";
import { PopupMenu } from "../../ui/popup-menu.js";
import { EmptyState } from "../../ui/primitives.js";
import { Panel } from "../panel/Panel.js";
import { MessageList } from "./MessageList.js";
import { buildTimeline } from "./timeline.js";

export function ChatScreen() {
  const selected = useUi((s) => s.selectedBotId);
  const bot = useData((s) => (selected === null ? undefined : s.bots[selected]));
  if (bot === undefined) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
        <EmptyState
          title="Nenhum bot selecionado"
          text="Escolha um bot na barra lateral ou crie um novo."
        />
      </div>
    );
  }
  return <ChatForBot key={bot.id} botId={bot.id} />;
}

const ACTIVE: ReadonlySet<Run["status"]> = new Set([
  "queued",
  "running",
  "waiting_user",
  "waiting_approval",
  "waiting_timer",
]);

/** The run controls and the bot's own options, as menu items (the chip's context menu, the palette). */
export function runMenuItems(
  active: Run | undefined,
  actions: { pause(): void; resume(): void; interrupt(): void; cancel(): void },
): MenuItem[] {
  const working =
    active !== undefined && (active.status === "queued" || active.status === "running");
  return [
    active?.paused === true
      ? { id: "resume", label: "Continuar", onSelect: actions.resume }
      : { id: "pause", label: "Pausar", disabled: !working, onSelect: actions.pause },
    {
      id: "interrupt",
      label: "Interromper agora",
      disabled: !working,
      onSelect: actions.interrupt,
    },
    {
      id: "cancel",
      label: "Cancelar a execução",
      danger: true,
      disabled: active === undefined || isTerminal(active.status),
      onSelect: actions.cancel,
    },
  ];
}

function ChatForBot({ botId }: { botId: string }) {
  const { sync } = useServices();
  const bot = useData((s) => s.bots[botId]);
  const runs = useData((s) => s.runs);
  const conversations = useData((s) => s.conversations);
  const messagesByConversation = useData((s) => s.messages);
  const eventsByRun = useData((s) => s.events);
  const approvals = useData((s) => s.approvals);
  const connectorsByName = useData((s) => s.connectors);
  const connectors = useMemo(() => Object.values(connectorsByName), [connectorsByName]);
  const fold = useSettings((s) => s.settings.fold);
  const panelOpen = useUi((s) => s.panelOpen);
  const togglePanel = useUi((s) => s.togglePanel);
  const openInspector = useUi((s) => s.openInspector);
  const openEditBot = useUi((s) => s.openEditBot);
  const [convId, setConvId] = useState<string | null>(bot?.conversationId ?? null);
  const [restore, setRestore] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  // Open (or create) the bot's conversation and keep it fresh while it is on screen.
  useEffect(() => {
    if (bot === undefined) return;
    let cancelled = false;
    let watching: string | null = null;
    void (async () => {
      const conversation = await sync.openBotConversation(bot);
      if (cancelled || conversation === undefined) return;
      watching = conversation.id;
      setConvId(conversation.id);
      // The first open of the chat starts the bot's welcome (the server does it once).
      void sync.startReceptionIfDue(bot, conversation);
      await sync.watchConversation(conversation.id);
    })();
    return () => {
      cancelled = true;
      if (watching !== null) sync.unwatchConversation(watching);
    };
  }, [botId, sync]);

  const conversation = convId === null ? undefined : conversations[convId];
  const slice = convId === null ? undefined : messagesByConversation[convId];
  const messages = useMemo(() => orderedMessages(slice), [slice]);

  const conversationRuns = useMemo(
    () =>
      Object.values(runs)
        .filter((r) => r.conversationId === convId && convId !== null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [runs, convId],
  );
  const latest: Run | undefined = conversationRuns[conversationRuns.length - 1];
  const active = [...conversationRuns].reverse().find((r) => ACTIVE.has(r.status));

  // The stream carries the events of the run that is on screen.
  useEffect(() => {
    sync.follow(latest === undefined ? [] : [latest.id]);
    return () => sync.follow([]);
  }, [latest?.id, sync]);

  const events = useMemo(
    () => orderedEvents(latest === undefined ? undefined : eventsByRun[latest.id]),
    [latest, eventsByRun],
  );
  const display = deriveRunDisplay(active ?? null, active === undefined ? [] : events);

  // Whatever the bot said is read when it is on screen: mark it.
  const unread = conversation?.unreadCount ?? 0;
  useEffect(() => {
    if (convId !== null && unread > 0 && document.visibilityState === "visible")
      void sync.markRead(convId);
  }, [convId, unread, messages.length, sync]);

  // The tool calls of the latest run are cards; what is expanded survives new events (keyed by call id).
  const actions = useMemo(
    () => (latest === undefined ? [] : actionsOf(latest.id, events, connectors)),
    [latest, events, connectors],
  );
  // The approval cards of the conversation (from the store: the stream and REST) and the secure form
  // of the run on screen, placed among the actions where they were asked.
  const cards = useMemo(
    () => (convId === null ? [] : approvalsOfConversation({ approvals, runs }, convId)),
    [approvals, runs, convId],
  );
  const secretRequests = useMemo(
    () => (latest === undefined ? [] : secretRequestsOf(latest, latest.id, events)),
    [latest, events],
  );
  const items = useMemo(
    () =>
      buildTimeline(
        messages,
        runs,
        actions,
        new Date(),
        fold === "on" ? VISIBLE_ACTIONS : Number.POSITIVE_INFINITY,
        { approvals: cards, secrets: secretRequests, connectors },
      ),
    [messages, runs, actions, fold, cards, secretRequests, connectors],
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
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
  const phrase =
    active === undefined ? "Pensando" : workingPhrase(active, actions, planOf(active, events));
  const color = bot === undefined ? "cinza" : effectiveColor(bot.color, bot.id);

  const send = useCallback(
    async (text: string) => {
      if (convId === null) return;
      const result = await sync.send(convId, text);
      if (!result.ok) setRestore((r) => ({ text: result.text, nonce: (r?.nonce ?? 0) + 1 }));
    },
    [convId, sync],
  );

  if (bot === undefined) return null;
  const archived = bot.archivedAt !== null;
  const lastBot = [...messages].reverse().find((m) => m.authorKind === "bot");
  const announce = [
    display.label !== "" ? `${bot.name}: ${display.label}` : "",
    lastBot === undefined ? "" : `Última mensagem de ${bot.name}: ${lastBot.text}`,
  ]
    .filter(Boolean)
    .join(". ");
  const description = bot.description.trim();

  const menuItems: MenuItem[] = [
    ...runMenuItems(active, {
      pause: () => active !== undefined && void sync.runAction(active.id, "pause"),
      resume: () => active !== undefined && void sync.runAction(active.id, "resume"),
      interrupt: () => active !== undefined && void sync.runAction(active.id, "interrupt"),
      cancel: () => active !== undefined && void sync.runAction(active.id, "cancel"),
    }),
    {
      id: "inspector",
      label: "Abrir o inspetor da última execução",
      disabled: latest === undefined,
      onSelect: () => latest !== undefined && openInspector(latest.id),
    },
    { id: "edit", label: "Editar o bot…", onSelect: () => openEditBot(bot.id) },
  ];

  const openQuestion = items.some((i) => i.kind === "bot" && i.ask?.open === true);
  const needsPersonality =
    slice?.loaded === true && messages.length === 0 && bot.personality.trim() === "";
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1"
      style={colorVars(color) as React.CSSProperties}
      data-testid="chat"
      data-bot={bot.name}
    >
      <section
        className="flex min-h-0 min-w-chat-min flex-[1_0_var(--width-chat-min)] flex-col"
        aria-label={`Conversa com ${bot.name}`}
      >
        <header className="flex min-h-15.5 flex-none justify-center px-4 pt-3">
          <button
            type="button"
            className="group/chip inline-flex h-control max-w-bot-chip items-center gap-2 rounded-pill border border-border-strong bg-transparent py-0 pr-3.5 pl-1.5 text-label hover:bg-hover"
            aria-expanded={panelOpen}
            aria-haspopup="menu"
            aria-label={`${bot.name}. ${panelOpen ? "Fechar" : "Abrir"} o painel do bot. Menu de contexto para controlar a execução`}
            data-testid="bot-chip"
            data-run={display.chip ?? ""}
            onClick={togglePanel}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            }}
            onKeyDown={(e) => {
              if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.left, y: rect.bottom + 4 });
              }
            }}
          >
            <Avatar
              avatar={bot.avatar}
              color={bot.color}
              seed={bot.id}
              size="sm"
              state={display.avatar}
            />
            <span className="min-w-0 truncate">
              <BotTitle name={bot.name} description={description} />
            </span>
            <ChevronDown
              size={16}
              aria-hidden="true"
              className={cx(
                "hidden flex-none transition-transform duration-(--duration-base) group-hover/chip:block group-focus-visible/chip:block",
                panelOpen && "rotate-180",
              )}
            />
          </button>
        </header>
        <MessageList
          items={items}
          botName={bot.name}
          hasOlder={slice?.hasOlder ?? false}
          onLoadOlder={() =>
            convId === null ? Promise.resolve(false) : sync.loadOlderMessages(convId)
          }
          runs={runs}
          onAnswer={(text) => void send(text)}
          onDecideTeam={(messageId, body) => sync.decideTeam(messageId, body)}
          onInspect={openInspector}
          expanded={expanded}
          onToggle={toggle}
          phrase={phrase}
          announce={announce}
          empty={
            needsPersonality ? (
              <EventLineButton
                data-testid="personality-hint"
                onClick={() => openEditBot(bot.id, 2)}
              >
                {bot.name} ainda não tem uma personalidade. Descrever o que ele faz
              </EventLineButton>
            ) : undefined
          }
        />
        <div
          className="mx-auto w-full max-w-[calc(var(--width-content)+var(--space-5)*2)] flex-none px-5 pt-2 pb-5"
          data-testid="chat-composer"
        >
          <Composer
            placeholder={
              openQuestion
                ? "Digite sua resposta ou fale sobre outra coisa"
                : `Mensagem para ${bot.name}`
            }
            disabled={archived || convId === null}
            disabledReason={archived ? "Este bot está arquivado" : "Abrindo a conversa…"}
            restore={restore}
            onSend={(text) => void send(text)}
            autoFocus
          />
        </div>
      </section>
      {panelOpen && <Panel botId={bot.id} />}
      {menu !== null && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label={`Opções de ${bot.name}`}
          items={menuItems}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
