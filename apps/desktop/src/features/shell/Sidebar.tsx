import type { Bot } from "@suup/api";
import { Ellipsis, LayoutGrid, PanelLeftClose, PanelLeftOpen, Plus, Search } from "lucide-react";
import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { botDisplay, pendingQuestions, unreadOf } from "../../app/selectors.js";
import { useUi } from "../../app/ui-store.js";
import { arrangeBots, flatBots } from "../../data/botlist.js";
import { pendingApprovals } from "../../data/reducers.js";
import { plainText } from "../../lib/markdown.js";
import { SIDEBAR_SPEC } from "../../lib/pane-size.js";
import { Avatar } from "../../ui/avatar.js";
import type { MenuItem } from "../../ui/menu.js";
import { PopupMenu } from "../../ui/popup-menu.js";
import { RoundButton } from "../../ui/primitives.js";
import { ResizeHandle } from "../../ui/resize-handle.js";

type BadgeKind = "working" | "question" | "unread" | "paused" | "failed";

interface EntryProps {
  bot: Bot;
  variant: "tile" | "row" | "rail";
  active: boolean;
  tabStop: boolean;
  preview?: string;
  onSelect(): void;
  onMenu(bot: Bot, x: number, y: number): void;
  setRef(el: HTMLButtonElement | null): void;
  onKeyDown(e: KeyboardEvent): void;
}

function BotEntry({
  bot,
  variant,
  active,
  tabStop,
  preview,
  onSelect,
  onMenu,
  setRef,
  onKeyDown,
}: EntryProps) {
  const runs = useData((s) => s.runs);
  const conversations = useData((s) => s.conversations);
  const approvals = useData((s) => s.approvals);
  const display = botDisplay(bot, runs);
  const unread = unreadOf(bot, conversations);
  // The cards waiting for you from this bot: the count is the badge (the same "question" kind).
  const waitingCards = Object.values(approvals).filter(
    (a) => a.botId === bot.id && a.status === "pending",
  ).length;
  let badge: { kind: BadgeKind; text: string } | undefined;
  if (waitingCards > 0)
    badge = { kind: "question", text: waitingCards > 9 ? "9+" : String(waitingCards) };
  else if (display.chip === "doubt" || display.chip === "permission")
    badge = { kind: "question", text: "?" };
  else if (display.chip === "paused") badge = { kind: "paused", text: "" };
  else if (unread > 0) badge = { kind: "unread", text: unread > 9 ? "9+" : String(unread) };
  else if (display.chip === "failed") badge = { kind: "failed", text: "!" };
  const status = [
    display.label,
    waitingCards > 0
      ? `${waitingCards} ${waitingCards === 1 ? "aprovação esperando" : "aprovações esperando"} você`
      : "",
    unread > 0 ? `${unread} não lida${unread === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  const label = status === "" ? bot.name : `${bot.name} — ${status}`;
  // Enquanto o bot trabalha o rosto vira o indicador de pontos (`data-working`, `data-state`).
  const working = ["working", "thinking", "resuming", "queued"].includes(display.chip ?? "");
  const size = variant === "tile" ? "tile" : variant === "row" ? "md" : "lg";
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onMenu(bot, e.clientX, e.clientY);
  };
  return (
    <div className={`bot-entry bot-entry--${variant}${active ? " bot-entry--active" : ""}`}>
      <button
        ref={setRef}
        type="button"
        className="bot-entry__main"
        aria-label={label}
        aria-current={active ? "page" : undefined}
        data-tip={variant === "rail" ? bot.name : undefined}
        data-testid="bot-item"
        data-bot={bot.name}
        data-chip={display.chip ?? ""}
        data-working={working}
        tabIndex={tabStop ? 0 : -1}
        onClick={onSelect}
        onKeyDown={(e) => {
          if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            onMenu(bot, rect.left + 24, rect.bottom);
            return;
          }
          onKeyDown(e);
        }}
        onContextMenu={openMenu}
      >
        <span className="bot-entry__avatar">
          <Avatar
            avatar={bot.avatar}
            color={bot.color}
            seed={bot.id}
            size={size}
            state={display.avatar}
          />
          {badge !== undefined && (
            <span
              className={`bot-badge bot-badge--${badge.kind}`}
              data-testid="bot-badge"
              data-kind={badge.kind}
              aria-hidden="true"
            >
              {badge.text}
            </span>
          )}
        </span>
        {variant === "tile" && <span className="bot-entry__name">{bot.name}</span>}
        {variant === "row" && (
          <span className="bot-entry__text">
            <span className="bot-entry__line1">
              <strong>{bot.name}</strong>
              {bot.description !== "" && <span className="muted"> · {bot.description}</span>}
            </span>
            <span className="bot-entry__line2 muted">{preview ?? "Sem mensagens"}</span>
          </span>
        )}
      </button>
      {variant !== "rail" && (
        <button
          type="button"
          className="bot-entry__more"
          aria-label={`Mais opções de ${bot.name}`}
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            onMenu(bot, rect.left, rect.bottom + 4);
          }}
        >
          <Ellipsis size={16} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * The left column, in two states the person toggles (and the app remembers): the expanded sidebar
 * (pinned tiles, groups, the default list, a bottom bar) and the narrow rail of avatars.
 */
export function Sidebar() {
  const { api, sync, disconnect } = useServices();
  const bots = useData((s) => s.bots);
  const runs = useData((s) => s.runs);
  const conversations = useData((s) => s.conversations);
  const approvals = useData((s) => s.approvals);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const view = useUi((s) => s.view);
  const selected = useUi((s) => s.selectedBotId);
  const ui = useUi.getState;
  const selectBot = useUi((s) => s.selectBot);
  const go = useUi((s) => s.go);
  const [menu, setMenu] = useState<{ bot: Bot; x: number; y: number } | null>(null);
  const [ownerMenu, setOwnerMenu] = useState<{ x: number; y: number } | null>(null);
  const [archiving, setArchiving] = useState<Bot | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const layout = useMemo(() => arrangeBots(bots), [bots]);
  const flat = useMemo(() => flatBots(layout), [layout]);
  // Questions, secret requests and approval cards: everything that waits for you.
  const pending = useMemo(
    () => pendingQuestions({ runs, bots }).length + pendingApprovals({ approvals, bots }).length,
    [runs, bots, approvals],
  );
  const activeId = view === "chat" ? selected : null;
  const tabStop = flat.some((b) => b.id === activeId) ? activeId : flat[0]?.id;

  const previewOf = (bot: Bot): string => {
    const conversation =
      bot.conversationId === null ? undefined : conversations[bot.conversationId];
    return plainText(conversation?.lastMessage?.text ?? "") || "Sem mensagens";
  };

  const move = (e: KeyboardEvent, id: string) => {
    const index = flat.findIndex((b) => b.id === id);
    const delta =
      e.key === "ArrowDown" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowUp" || e.key === "ArrowLeft"
          ? -1
          : e.key === "Home"
            ? -index
            : e.key === "End"
              ? flat.length
              : 0;
    if (delta === 0) return;
    e.preventDefault();
    const target = flat[Math.max(0, Math.min(flat.length - 1, index + delta))];
    if (target !== undefined) refs.current[target.id]?.focus();
  };

  const patch = useCallback(
    async (bot: Bot, body: Parameters<typeof api.bots.update>[1]) => {
      try {
        sync.mergeBotNow(await api.bots.update(bot.id, body));
      } catch (error) {
        useUi
          .getState()
          .toast(
            error instanceof Error ? error.message : "Não foi possível alterar o bot.",
            "error",
          );
      }
    },
    [api, sync],
  );

  const menuItems = (bot: Bot): MenuItem[] => [
    {
      id: "pin",
      label: bot.pinned ? "Desafixar" : "Fixar",
      onSelect: () => void patch(bot, { pinned: !bot.pinned }),
    },
    { id: "group", label: "Mover para grupo…", onSelect: () => ui().setGroupBot(bot.id) },
    { id: "edit", label: "Editar…", onSelect: () => ui().openEditBot(bot.id) },
    { id: "archive", label: "Arquivar…", danger: true, onSelect: () => setArchiving(bot) },
  ];

  const entry = (bot: Bot, variant: EntryProps["variant"]) => (
    <BotEntry
      key={bot.id}
      bot={bot}
      variant={variant}
      active={bot.id === activeId}
      tabStop={bot.id === tabStop}
      preview={previewOf(bot)}
      onSelect={() => selectBot(bot.id)}
      onMenu={(b, x, y) => setMenu({ bot: b, x, y })}
      setRef={(el) => {
        refs.current[bot.id] = el;
      }}
      onKeyDown={(e) => move(e, bot.id)}
    />
  );

  const ownerItems: MenuItem[] = [
    { id: "memory", label: "Memória", onSelect: () => go("memory") },
    {
      id: "pending",
      label: pending > 0 ? `Pendências (${pending})` : "Pendências",
      onSelect: () => go("pending"),
    },
    { id: "settings", label: "Configurações", onSelect: () => ui().openSettings() },
    { id: "shortcuts", label: "Atalhos de teclado", onSelect: () => ui().setShortcuts(true) },
    { id: "disconnect", label: "Desconectar", danger: true, onSelect: () => void disconnect() },
  ];
  const ownerButton = (variant: "bar" | "rail") => (
    <button
      type="button"
      className={`sidebar__owner sidebar__owner--${variant}`}
      aria-haspopup="menu"
      aria-label={pending > 0 ? `Menu da sua conta (${pending} pendências)` : "Menu da sua conta"}
      data-testid="owner-menu"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setOwnerMenu({ x: rect.left, y: rect.top - ownerItems.length * 40 - 16 });
      }}
    >
      <span className="sidebar__me" aria-hidden="true">
        V
        {pending > 0 && (
          <span className="bot-badge bot-badge--question" data-testid="pending-counter">
            {pending}
          </span>
        )}
      </span>
      {variant === "bar" && <span className="sidebar__me-name">Você</span>}
    </button>
  );

  const popups = (
    <>
      {ownerMenu !== null && (
        <PopupMenu
          x={ownerMenu.x}
          y={ownerMenu.y}
          label="Sua conta"
          items={ownerItems}
          onClose={() => setOwnerMenu(null)}
        />
      )}
      {menu !== null && (
        <PopupMenu
          x={menu.x}
          y={menu.y}
          label={`Opções de ${menu.bot.name}`}
          items={menuItems(menu.bot)}
          onClose={() => setMenu(null)}
        />
      )}
      {archiving !== null && (
        <ArchiveDialog
          bot={archiving}
          onClose={() => setArchiving(null)}
          onConfirm={async () => {
            const bot = archiving;
            setArchiving(null);
            try {
              sync.mergeBotNow(await api.bots.archive(bot.id));
            } catch (error) {
              useUi
                .getState()
                .toast(
                  error instanceof Error ? error.message : "Não foi possível arquivar.",
                  "error",
                );
            }
          }}
        />
      )}
    </>
  );

  const resizer = (
    <ResizeHandle
      key="resize"
      spec={SIDEBAR_SPEC}
      edge="end"
      layout={{ collapsed, width: sidebarWidth }}
      cssVar="--sidebar-w"
      label="Redimensionar a barra lateral"
      liveCollapse
      onCollapsedChange={ui().setSidebarCollapsed}
      onCommit={ui().setSidebarLayout}
    />
  );

  // Um só <nav> nos dois estados: a alça de arrastar continua montada quando o arrasto vira o trilho.
  return (
    <nav
      className={collapsed ? "sidebar sidebar--rail" : "sidebar"}
      aria-label="Bots e atalhos"
      data-testid="sidebar"
      data-collapsed={collapsed ? "true" : "false"}
    >
      {collapsed ? (
        <>
          <RoundButton label="Expandir a barra lateral" tone="ghost" onClick={ui().toggleSidebar}>
            <PanelLeftOpen size={20} aria-hidden="true" />
          </RoundButton>
          <div className="sidebar__scroll sidebar__scroll--rail" role="group" aria-label="Bots">
            {layout.pinned.map((bot) => entry(bot, "rail"))}
            {layout.pinned.length > 0 && flat.length > layout.pinned.length && (
              <hr className="sidebar__divider" />
            )}
            {flat.filter((b) => !b.pinned).map((bot) => entry(bot, "rail"))}
          </div>
          <div className="sidebar__bottom sidebar__bottom--rail">
            <RoundButton label="Novo bot" tone="ghost" onClick={ui().openNewBot}>
              <Plus size={20} aria-hidden="true" />
            </RoundButton>
            <RoundButton label="Buscar e ações" tone="raised" onClick={() => ui().setPalette(true)}>
              <LayoutGrid size={18} aria-hidden="true" />
            </RoundButton>
            {ownerButton("rail")}
          </div>
        </>
      ) : (
        <>
          <div className="sidebar__top">
            <RoundButton label="Recolher a barra lateral" tone="ghost" onClick={ui().toggleSidebar}>
              <PanelLeftClose size={20} aria-hidden="true" />
            </RoundButton>
            <span className="sidebar__spacer" />
            <RoundButton label="Buscar" tone="raised" onClick={() => ui().setPalette(true)}>
              <Search size={20} aria-hidden="true" />
            </RoundButton>
            <RoundButton label="Novo bot" tone="raised" onClick={ui().openNewBot}>
              <Plus size={20} aria-hidden="true" />
            </RoundButton>
          </div>
          <div className="sidebar__scroll">
            {layout.pinned.length > 0 && (
              <section aria-label="Fixados" data-testid="pinned-section">
                <div className="sidebar__tiles">{layout.pinned.map((b) => entry(b, "tile"))}</div>
              </section>
            )}
            {layout.groups.map((group) => (
              <section
                key={group.name}
                aria-label={`Grupo ${group.name}`}
                data-testid="group-section"
                data-group={group.name}
              >
                <p className="sidebar__label">{group.name}</p>
                <div className="sidebar__rows">{group.bots.map((b) => entry(b, "row"))}</div>
              </section>
            ))}
            {layout.rest.length > 0 && (
              <section aria-label="Bots" data-testid="rest-section">
                <p className="sidebar__label">Bots</p>
                <div className="sidebar__rows">{layout.rest.map((b) => entry(b, "row"))}</div>
              </section>
            )}
          </div>
          <div className="sidebar__bottom">
            {ownerButton("bar")}
            <span className="sidebar__spacer" />
            <RoundButton label="Buscar e ações" tone="raised" onClick={() => ui().setPalette(true)}>
              <LayoutGrid size={18} aria-hidden="true" />
            </RoundButton>
          </div>
        </>
      )}
      {resizer}
      {popups}
    </nav>
  );
}

import { Dialog, Pill } from "../../ui/primitives.js";

function ArchiveDialog({
  bot,
  onClose,
  onConfirm,
}: {
  bot: Bot;
  onClose(): void;
  onConfirm(): void;
}) {
  return (
    <Dialog
      title={`Arquivar ${bot.name}?`}
      onClose={onClose}
      footer={
        <>
          <Pill tone="ghost" onClick={onClose}>
            Cancelar
          </Pill>
          <Pill tone="danger" onClick={onConfirm}>
            Arquivar
          </Pill>
        </>
      }
    >
      <p className="muted">
        O bot deixa de receber trabalho novo. A conversa e a memória dele continuam guardadas.
      </p>
    </Dialog>
  );
}
