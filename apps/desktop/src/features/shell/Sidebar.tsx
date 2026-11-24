import type { Bot } from "@suup/api";
import {
  Archive,
  Brain,
  Ellipsis,
  FolderInput,
  Inbox,
  Keyboard,
  LayoutGrid,
  LogOut,
  Pencil,
  Pin,
  PinOff,
  Plug,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { botDisplay, pendingQuestions, unreadOf } from "../../app/selectors.js";
import { useUi } from "../../app/ui-store.js";
import { arrangeBots, flatBots } from "../../data/botlist.js";
import { pendingApprovals } from "../../data/reducers.js";
import { cx } from "../../lib/cx.js";
import { friendlyError } from "../../lib/friendly-error.js";
import { plainText } from "../../lib/markdown.js";
import { SIDEBAR_SPEC } from "../../lib/pane-size.js";
import { Avatar } from "../../ui/avatar.js";
import { type BadgeKind, BotBadge } from "../../ui/bot-badge.js";
import { BotTitle } from "../../ui/bot-title.js";
import { MenuButton, type MenuSection, PopupMenu, popupKey } from "../../ui/menu.js";
import { Dialog, MutedText, Pill, RoundButton } from "../../ui/primitives.js";
import { ResizeHandle } from "../../ui/resize-handle.js";
import { ScrollFade } from "../../ui/scroll-fade.js";
import { Separator } from "../../ui/separator.js";
import { Tip } from "../../ui/tooltip.js";

/** How a bot's entry is laid out: a tile (pinned), a row (a list), or only the face (the rail). */
const ENTRY_MAIN = {
  tile: "w-full flex-col gap-2 px-2 pt-4 pb-2",
  row: "w-full gap-3 py-2 pr-9 pl-2.5",
  rail: "size-rail-tile justify-center p-0",
} as const;

/** The "more" button of an entry: shown on hover and on focus, over the end of a row or a tile's corner. */
/** The line under a bot that has not talked yet (owner, 23/11/2026). */
export const NO_MESSAGES = "Sem interação";

const ENTRY_MORE = {
  tile: "top-2 right-2",
  row: "top-1/2 right-1.5 -translate-y-1/2",
} as const;

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
  // An unread message is the blue dot in the avatar's corner (`unread` below), not a count.
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
  // O bot trabalhando (`data-working`): o rosto continua o rosto (docs/DESIGN.md §6).
  const working = ["working", "thinking", "resuming", "queued"].includes(display.chip ?? "");
  // The rail draws the face at the size of a row (42 px): "lg" filled the whole square (owner, 24/11/2026: "ainda estão gigantes").
  const size = variant === "tile" ? "tile" : "row";
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onMenu(bot, e.clientX, e.clientY);
  };
  const main = (
    <button
      ref={setRef}
      type="button"
      className={cx(
        "flex min-w-0 items-center rounded-card border border-transparent bg-transparent text-left hover:bg-hover aria-[current=page]:bg-sidebar-active",
        ENTRY_MAIN[variant],
      )}
      aria-label={label}
      aria-current={active ? "page" : undefined}
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
      <span className="relative inline-flex flex-none">
        <Avatar
          avatar={bot.avatar}
          avatarStyle={bot.avatarStyle}
          pixel3d={bot.avatarPixel3d}
          color={bot.color}
          seed={bot.id}
          size={size}
          state={display.avatar}
          supervisor={bot.isDefault}
          working={working}
          unread={unread > 0}
        />
        {badge !== undefined && (
          <BotBadge
            kind={badge.kind}
            data-testid="bot-badge"
            data-kind={badge.kind}
            aria-hidden="true"
          >
            {badge.text}
          </BotBadge>
        )}
      </span>
      {variant === "tile" && (
        <span className="max-w-full truncate text-label leading-inherit font-label">
          {bot.name}
        </span>
      )}
      {variant === "row" && (
        <span className="flex min-w-0 flex-1 flex-col" data-testid="bot-entry-text">
          <span className="truncate text-label">
            <BotTitle name={bot.name} description={bot.description} />
          </span>
          <MutedText className="truncate">{preview ?? NO_MESSAGES}</MutedText>
        </span>
      )}
    </button>
  );
  return (
    <div className="group/entry relative min-w-0">
      {variant === "rail" ? (
        // The rail: only the bot's name beside its face (owner, 23/11/2026), at once, in a portal
        // so no scrolling list clips it.
        <Tip label={bot.name} side="right" delay={0} testId="rail-tip">
          {main}
        </Tip>
      ) : (
        main
      )}
      {variant !== "rail" && (
        <button
          type="button"
          className={cx(
            "absolute inline-flex size-7 items-center justify-center rounded-pill border-0 bg-transparent text-text-muted opacity-0 transition-opacity group-focus-within/entry:opacity-100 group-hover/entry:opacity-100 hover:bg-raised hover:text-text",
            ENTRY_MORE[variant],
          )}
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
  const { api, sync, disconnect, mode } = useServices();
  const bots = useData((s) => s.bots);
  const runs = useData((s) => s.runs);
  const conversations = useData((s) => s.conversations);
  const approvals = useData((s) => s.approvals);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const sidebarWidth = useUi((s) => s.sidebarWidth);
  const view = useUi((s) => s.view);
  const selected = useUi((s) => s.selectedBotId);
  const picked = useUi((s) => s.botPicked);
  const ui = useUi.getState;
  const selectBot = useUi((s) => s.selectBot);
  const go = useUi((s) => s.go);
  const [menu, setMenu] = useState<{ bot: Bot; x: number; y: number; key: number } | null>(null);
  const [archiving, setArchiving] = useState<Bot | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const layout = useMemo(() => arrangeBots(bots), [bots]);
  const flat = useMemo(() => flatBots(layout), [layout]);
  // Questions, secret requests and approval cards: everything that waits for you.
  const pending = useMemo(
    () => pendingQuestions({ runs, bots }).length + pendingApprovals({ approvals, bots }).length,
    [runs, bots, approvals],
  );
  // Only a bot the person chose is marked; the one the app opened by itself is not.
  const activeId = view === "chat" && picked ? selected : null;
  const tabStop = flat.some((b) => b.id === activeId) ? activeId : flat[0]?.id;

  const previewOf = (bot: Bot): string => {
    const conversation =
      bot.conversationId === null ? undefined : conversations[bot.conversationId];
    return plainText(conversation?.lastMessage?.text ?? "") || NO_MESSAGES;
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
        useUi.getState().toast(friendlyError(error), "error");
      }
    },
    [api, sync],
  );

  const menuItems = (bot: Bot): MenuSection[] => [
    {
      id: "bot",
      items: [
        {
          id: "pin",
          label: bot.pinned ? "Desafixar" : "Fixar",
          icon: bot.pinned ? PinOff : Pin,
          onSelect: () => void patch(bot, { pinned: !bot.pinned }),
        },
        {
          id: "group",
          label: "Mover para grupo…",
          icon: FolderInput,
          onSelect: () => ui().setGroupBot(bot.id),
        },
        { id: "edit", label: "Editar…", icon: Pencil, onSelect: () => ui().openEditBot(bot.id) },
      ],
    },
    {
      id: "archive",
      items: [
        {
          id: "archive",
          label: "Arquivar…",
          icon: Archive,
          danger: true,
          onSelect: () => setArchiving(bot),
        },
      ],
    },
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
      onMenu={(b, x, y) => setMenu({ bot: b, x, y, key: popupKey() })}
      setRef={(el) => {
        refs.current[bot.id] = el;
      }}
      onKeyDown={(e) => move(e, bot.id)}
    />
  );

  // Three groups split by a line: the screens, the app, leaving (owner, 24/11/2026).
  const ownerItems: MenuSection[] = [
    {
      id: "screens",
      items: [
        {
          id: "pending",
          label: "Pendências",
          icon: Inbox,
          ...(pending > 0 ? { hint: String(pending) } : {}),
          onSelect: () => go("pending"),
        },
        { id: "memory", label: "Memória", icon: Brain, onSelect: () => go("memory") },
        { id: "plugins", label: "Conectores", icon: Plug, onSelect: () => go("connectors") },
      ],
    },
    {
      id: "app",
      items: [
        {
          id: "settings",
          label: "Configurações",
          icon: Settings,
          onSelect: () => ui().openSettings(),
        },
        {
          id: "shortcuts",
          label: "Atalhos de teclado",
          icon: Keyboard,
          onSelect: () => ui().setShortcuts(true),
        },
      ],
    },
    {
      id: "leave",
      items: [
        {
          id: "disconnect",
          label: mode === "local" ? "Trocar de servidor" : "Desconectar",
          icon: LogOut,
          danger: true,
          onSelect: () => void disconnect(),
        },
      ],
    },
  ];
  // The account button opens its menu above it, lined up with its start (the menu of sempre).
  const ownerButton = (variant: "bar" | "rail") => (
    <MenuButton
      label="Sua conta"
      items={ownerItems}
      placement="above"
      align="start"
      width="normal"
      trigger={(props) => (
        <button
          type="button"
          {...props}
          className={cx(
            "inline-flex items-center rounded-row border-0 bg-transparent transition-colors hover:bg-hover aria-expanded:bg-hover",
            variant === "bar" ? "min-w-0 flex-1 gap-2.5 py-1.5 pr-3 pl-1.5" : "p-1",
          )}
          aria-label={
            pending > 0 ? `Menu da sua conta (${pending} pendências)` : "Menu da sua conta"
          }
          data-testid="owner-menu"
        >
          <span
            className={cx(
              "relative inline-flex flex-none items-center justify-center rounded-pill border border-border-strong bg-raised font-label",
              variant === "rail" ? "size-11 text-label" : "size-avatar-sm text-small",
            )}
            aria-hidden="true"
          >
            V
            {pending > 0 && (
              <BotBadge kind="question" data-testid="pending-counter">
                {pending}
              </BotBadge>
            )}
          </span>
          {variant === "bar" && <span className="truncate text-label font-label">Você</span>}
        </button>
      )}
    />
  );

  const popups = (
    <>
      {menu !== null && (
        <PopupMenu
          key={menu.key}
          x={menu.x}
          y={menu.y}
          label={`Opções de ${menu.bot.name}`}
          items={menuItems(menu.bot)}
          onClose={() => setMenu((m) => (m?.key === menu.key ? null : m))}
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
              useUi.getState().toast(friendlyError(error), "error");
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
      className={cx(
        // Nothing to select in it (owner, 23/11/2026); the width eases between the rail and the bar
        // instead of jumping (docs/DESIGN.md §1 "Nada seco").
        "relative flex min-h-0 flex-none flex-col bg-sidebar transition-[width] duration-(--duration-base) ease-out select-none",
        collapsed
          ? "w-rail items-center gap-2 px-0 py-3.5"
          : "w-[var(--sidebar-w,var(--width-sidebar))] gap-2 border-r border-border p-3",
      )}
      aria-label="Bots e atalhos"
      data-testid="sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      data-tauri-drag-region
    >
      {collapsed ? (
        <>
          {/* The rail of the owner's reference (24/11/2026): the bots at the top, each in its rounded
              square; a line between the pinned and the rest; at the bottom "+", the plugins and the
              account. Search stays on Ctrl+K and in the open bar. */}
          <div className="h-6 flex-none" data-tauri-drag-region />
          <div className="relative flex min-h-0 w-full flex-1 flex-col">
            <div
              className="flex min-h-0 w-full flex-1 animate-fade-in flex-col items-center gap-0.5 overflow-y-auto py-fade"
              role="group"
              aria-label="Bots"
            >
              {/* One block per section of the open bar (the pinned, each group, the rest), a line
                  between each two (owner, 24/11/2026: "cada um ganha uma separação"). */}
              {[
                { key: "pinned", bots: layout.pinned },
                ...layout.groups.map((g) => ({ key: `group:${g.name}`, bots: g.bots })),
                { key: "rest", bots: layout.rest },
              ]
                .filter((section) => section.bots.length > 0)
                .map((section, i) => (
                  <div
                    key={section.key}
                    className="flex flex-col items-center gap-0.5"
                    data-testid="rail-section"
                  >
                    {i > 0 && <Separator tone="strong" className="my-1.5 w-rail-tile" />}
                    {section.bots.map((bot) => entry(bot, "rail"))}
                  </div>
                ))}
            </div>
            <ScrollFade tone="sidebar" />
          </div>
          <div className="relative flex w-full flex-none flex-col items-center gap-1 pt-2">
            <RoundButton label="Novo bot" tone="ghost" size="circle" onClick={ui().openNewBot}>
              <Plus size={22} aria-hidden="true" />
            </RoundButton>
            <RoundButton
              label="Conectores"
              tone="ghost"
              size="circle"
              onClick={() => go("connectors")}
              data-testid="rail-plugins"
            >
              <LayoutGrid size={18} aria-hidden="true" />
            </RoundButton>
            <div className="pt-1">{ownerButton("rail")}</div>
          </div>
        </>
      ) : (
        <>
          <div className="relative flex flex-none items-center gap-1" data-tauri-drag-region>
            <span className="flex-1" data-tauri-drag-region />
            <RoundButton label="Buscar" tone="raised" onClick={() => ui().setPalette(true)}>
              <Search size={20} aria-hidden="true" />
            </RoundButton>
            <RoundButton label="Novo bot" tone="raised" onClick={ui().openNewBot}>
              <Plus size={20} aria-hidden="true" />
            </RoundButton>
          </div>
          <div className="relative flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 animate-fade-in flex-col gap-4 overflow-y-auto py-fade">
              {layout.pinned.length > 0 && (
                <section aria-label="Fixados" data-testid="pinned-section">
                  <div
                    className="grid grid-cols-[repeat(auto-fill,var(--width-tile))] justify-center gap-1"
                    data-testid="pinned-tiles"
                  >
                    {layout.pinned.map((b) => entry(b, "tile"))}
                  </div>
                </section>
              )}
              {layout.groups.map((group) => (
                <section
                  key={group.name}
                  aria-label={`Grupo ${group.name}`}
                  data-testid="group-section"
                  data-group={group.name}
                >
                  <SidebarLabel>{group.name}</SidebarLabel>
                  <div className="flex flex-col gap-0.5">
                    {group.bots.map((b) => entry(b, "row"))}
                  </div>
                </section>
              ))}
              {layout.rest.length > 0 && (
                <section aria-label="Bots" data-testid="rest-section">
                  <SidebarLabel>Bots</SidebarLabel>
                  <div className="flex flex-col gap-0.5">
                    {layout.rest.map((b) => entry(b, "row"))}
                  </div>
                </section>
              )}
            </div>
            <ScrollFade tone="sidebar" />
          </div>
          <div className="relative flex flex-none items-center pt-2">{ownerButton("bar")}</div>
        </>
      )}
      {resizer}
      {popups}
    </nav>
  );
}

/** The name of a group of bots, above its rows. */
function SidebarLabel({ children }: { children: string }) {
  return <p className="px-3 pb-2 text-label leading-label text-text-muted">{children}</p>;
}

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
      <MutedText as="p" size="inherit">
        O bot para de receber trabalho; a conversa e a memória dele ficam guardadas.
      </MutedText>
    </Dialog>
  );
}
