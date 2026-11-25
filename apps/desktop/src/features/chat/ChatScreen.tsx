import type { Run } from "@suup/api";
import { ChevronRight, CircleStop, CircleX, Pause, Pencil, Play, ScanSearch } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { connectCardsOfConversation } from "../../data/connect-cards.js";
import { deriveRunDisplay, planOf } from "../../data/derive.js";
import {
  approvalsOfConversation,
  isTerminal,
  orderedEvents,
  orderedMessages,
} from "../../data/reducers.js";
import { secretRequestsOf } from "../../data/secret-requests.js";
import { approvalLeads } from "../../data/turn-lead.js";
import { activityPhrase, chatActivityOf } from "../../lib/chat-activity.js";
import { colorVars, themeColor } from "../../lib/mascots.js";
import { Avatar } from "../../ui/avatar.js";
import { EventLineButton } from "../../ui/chat-lines.js";
import { Composer } from "../../ui/composer.js";
import { DraftReference } from "../../ui/draft-reference.js";
import { type MenuItem, type MenuSection, PopupMenu, popupKey } from "../../ui/menu.js";
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
      ? { id: "resume", label: "Continuar", icon: Play, onSelect: actions.resume }
      : { id: "pause", label: "Pausar", icon: Pause, disabled: !working, onSelect: actions.pause },
    {
      id: "interrupt",
      label: "Interromper agora",
      icon: CircleStop,
      disabled: !working,
      onSelect: actions.interrupt,
    },
    {
      id: "cancel",
      label: "Cancelar a execução",
      icon: CircleX,
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
  const panelOpen = useUi((s) => s.panelOpen);
  const togglePanel = useUi((s) => s.togglePanel);
  const openInspector = useUi((s) => s.openInspector);
  const openEditBot = useUi((s) => s.openEditBot);
  const [convId, setConvId] = useState<string | null>(bot?.conversationId ?? null);
  const [restore, setRestore] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const [menu, setMenu] = useState<{ x: number; y: number; key: number } | null>(null);
  // "Editar" on a routine (docs/ROTINAS.md): a draft for the composer and the routine bound to it.
  // The reference lives with THIS chat's draft: clearing the draft drops it, and another bot is
  // another chat (this component is keyed by the bot), so it never follows to another one.
  const chatPrefill = useUi((s) => s.chatPrefill);
  const takeChatPrefill = useUi((s) => s.takeChatPrefill);
  const [prefill, setPrefill] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const [routineRef, setRoutineRef] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => {
    if (chatPrefill === null || chatPrefill.botId !== botId) return;
    setRoutineRef(chatPrefill.routine);
    setPrefill({ text: chatPrefill.text, nonce: chatPrefill.nonce });
    takeChatPrefill();
  }, [chatPrefill, botId, takeChatPrefill]);

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

  // The chat shows results only (the tool calls and the steps are in the Inspector): the approval
  // cards of the conversation (from the store: the stream and REST) and the secure form of the run
  // on screen, placed where they were asked.
  const cards = useMemo(
    () => (convId === null ? [] : approvalsOfConversation({ approvals, runs }, convId)),
    [approvals, runs, convId],
  );
  const secretRequests = useMemo(
    () => (latest === undefined ? [] : secretRequestsOf(latest, latest.id, events)),
    [latest, events],
  );
  const connectCards = useMemo(
    () =>
      connectCardsOfConversation(
        conversationRuns,
        Object.fromEntries(
          conversationRuns.map((r) => [
            r.id,
            eventsByRun[r.id] === undefined ? undefined : orderedEvents(eventsByRun[r.id]),
          ]),
        ),
        cards,
      ),
    [conversationRuns, eventsByRun, cards],
  );
  const approvalLeadsOfCards = useMemo(
    () =>
      approvalLeads(
        cards,
        Object.fromEntries(
          conversationRuns.map((r) => [
            r.id,
            eventsByRun[r.id] === undefined ? undefined : orderedEvents(eventsByRun[r.id]),
          ]),
        ),
      ),
    [conversationRuns, eventsByRun, cards],
  );
  const items = useMemo(
    () =>
      buildTimeline(messages, runs, new Date(), {
        approvals: cards,
        secrets: secretRequests,
        connectCards,
        approvalLeads: approvalLeadsOfCards,
      }),
    [messages, runs, cards, secretRequests, connectCards, approvalLeadsOfCards],
  );
  // What the user opened, in THIS conversation: another chat starts with every row collapsed.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [composerFocus, setComposerFocus] = useState(0);
  useEffect(() => {
    if (convId !== null) setExpanded(new Set());
  }, [convId]);
  // The X of a question card: the focus goes to the composer at once (the person will type), and the
  // server locks the card ("Não respondido") and tells the run (docs/API.md, "Fechar a pergunta").
  const dismissQuestion = useCallback(
    (messageId: string) => {
      setComposerFocus((n) => n + 1);
      void sync.dismissQuestion(messageId);
    },
    [sync],
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
  // What the run on screen is doing now: the expression of the live avatar and its phrase.
  const activity = chatActivityOf(active ?? null, active === undefined ? [] : events) ?? "thinking";
  const phrase = activityPhrase(
    activity,
    active ?? null,
    active === undefined ? [] : planOf(active, events),
  );
  const color = bot === undefined ? "cinza" : themeColor(bot, bot.id);

  const send = useCallback(
    async (text: string, ref: { id: string; name: string } | null = null) => {
      if (convId === null) return;
      const result = await sync.send(
        convId,
        text,
        ref === null ? {} : { routineRef: { id: ref.id } },
      );
      if (!result.ok) {
        setRestore((r) => ({ text: result.text, nonce: (r?.nonce ?? 0) + 1 }));
        // the draft comes back, and the routine with it
        if (ref !== null) setRoutineRef(ref);
      }
    },
    [convId, sync],
  );
  const sendDraft = (text: string) => {
    const ref = routineRef;
    setRoutineRef(null);
    void send(text, ref);
  };

  if (bot === undefined) return null;
  const archived = bot.archivedAt !== null;
  const lastBot = [...messages].reverse().find((m) => m.authorKind === "bot");
  const announce = [
    display.label !== "" ? `${bot.name}: ${display.label}` : "",
    lastBot === undefined ? "" : `Última mensagem de ${bot.name}: ${lastBot.text}`,
  ]
    .filter(Boolean)
    .join(". ");

  // The run's controls under their title, then the bot's (owner, 24/11/2026: groups and labels).
  const menuItems: MenuSection[] = [
    {
      id: "run",
      label: "Execução",
      items: runMenuItems(active, {
        pause: () => active !== undefined && void sync.runAction(active.id, "pause"),
        resume: () => active !== undefined && void sync.runAction(active.id, "resume"),
        interrupt: () => active !== undefined && void sync.runAction(active.id, "interrupt"),
        cancel: () => active !== undefined && void sync.runAction(active.id, "cancel"),
      }),
    },
    {
      id: "bot",
      items: [
        {
          id: "inspector",
          label: "Abrir o inspetor da última execução",
          icon: ScanSearch,
          disabled: latest === undefined,
          onSelect: () => latest !== undefined && openInspector(latest.id),
        },
        { id: "edit", label: "Editar o bot…", icon: Pencil, onSelect: () => openEditBot(bot.id) },
      ],
    },
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
        <MessageList
          onDismissQuestion={dismissQuestion}
          head={
            <button
              type="button"
              className="group/chip inline-flex h-11 max-w-bot-chip items-center gap-2.5 rounded-pill border border-border-strong bg-bg py-0 pr-4 pl-2 text-label transition-colors hover:bg-hover"
              aria-expanded={panelOpen}
              aria-haspopup="menu"
              aria-label={`${bot.name}. ${panelOpen ? "Fechar" : "Abrir"} o painel do bot. Menu de contexto para controlar a execução`}
              data-testid="bot-chip"
              data-run={display.chip ?? ""}
              onClick={togglePanel}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, key: popupKey() });
              }}
              onKeyDown={(e) => {
                if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setMenu({ x: rect.left, y: rect.bottom + 4, key: popupKey() });
                }
              }}
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
              <span className="min-w-0 truncate font-label">{bot.name}</span>
              {/* The chevron grows in on hover or focus, never pops (docs/DESIGN.md §1 "Nada seco"). */}
              <ChevronRight
                size={16}
                aria-hidden="true"
                data-testid="bot-chip-chevron"
                className="-ml-2.5 w-0 flex-none -translate-x-1 opacity-0 transition-all duration-(--duration-base) ease-out group-hover/chip:ml-0 group-hover/chip:w-4 group-hover/chip:translate-x-0 group-hover/chip:opacity-100 group-focus-visible/chip:ml-0 group-focus-visible/chip:w-4 group-focus-visible/chip:translate-x-0 group-focus-visible/chip:opacity-100"
              />
            </button>
          }
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
            prefill={prefill}
            focusRequest={composerFocus}
            onTextChange={(text) => {
              if (text.trim() === "") setRoutineRef(null);
            }}
            attachment={
              routineRef === null ? undefined : (
                <DraftReference name={routineRef.name} onRemove={() => setRoutineRef(null)} />
              )
            }
            onSend={sendDraft}
            autoFocus
          />
        </div>
      </section>
      {panelOpen && <Panel botId={bot.id} />}
      {menu !== null && (
        <PopupMenu
          key={menu.key}
          x={menu.x}
          y={menu.y}
          label={`Opções de ${bot.name}`}
          items={menuItems}
          onClose={() => setMenu((m) => (m?.key === menu.key ? null : m))}
        />
      )}
    </div>
  );
}
