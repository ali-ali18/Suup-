import type { Bot } from "@suup/api";
import {
  Ban,
  Brain,
  Inbox,
  Keyboard,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  Pause,
  Pencil,
  Play,
  Plus,
  Search,
  Settings,
  Square,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { arrangeBots, filterBots, flatBots, fold } from "../../data/botlist.js";
import { plainText } from "../../lib/markdown.js";
import { Avatar } from "../../ui/avatar.js";
import { Dialog, Pill } from "../../ui/primitives.js";

interface Entry {
  id: string;
  section: "Bots" | "Conversas" | "Ações";
  label: ReactNode;
  detail?: ReactNode;
  icon: ReactNode;
  text: string;
  run(): void;
}

const MIN_SEARCH = 2;
const DEBOUNCE_MS = 250;

/** Ctrl/Cmd+K: jump to a bot, to a message found by search, or run an action, all by keyboard. */
export function CommandPalette() {
  const { api, sync, disconnect } = useServices();
  const bots = useData((s) => s.bots);
  const conversations = useData((s) => s.conversations);
  const runs = useData((s) => s.runs);
  const selected = useUi((s) => s.selectedBotId);
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const ui = useUi.getState;
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<{ id: string; botId: string; excerpt: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const close = () => ui().setPalette(false);

  const ordered = useMemo(() => flatBots(arrangeBots(bots)), [bots]);
  const botOf = (conversationId: string): Bot | undefined =>
    Object.values(bots).find((b) => b.conversationId === conversationId) ??
    (() => {
      const member = conversations[conversationId]?.members[0];
      return member === undefined ? undefined : bots[member.botId];
    })();

  // Message search: after a pause in typing, and only the latest answer counts.
  useEffect(() => {
    const q = query.trim();
    if (q.length < MIN_SEARCH) {
      setHits([]);
      setSearching(false);
      return;
    }
    let current = true;
    setSearching(true);
    const timer = setTimeout(() => {
      api.search
        .messages({ q, limit: 8 })
        .then((items) => {
          if (!current) return;
          const found: { id: string; botId: string; excerpt: string }[] = [];
          for (const item of items) {
            const bot = botOf(item.message.conversationId);
            if (bot !== undefined)
              found.push({
                id: item.message.id,
                botId: bot.id,
                excerpt: plainText(item.excerpt.replaceAll("\u0002", "").replaceAll("\u0003", "")),
              });
          }
          setHits(found);
        })
        .catch(() => current && setHits([]))
        .finally(() => current && setSearching(false));
    }, DEBOUNCE_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [query, api]);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    for (const bot of filterBots(ordered, query)) {
      const conversation =
        bot.conversationId === null ? undefined : conversations[bot.conversationId];
      out.push({
        id: `bot-${bot.id}`,
        section: "Bots",
        label: (
          <>
            <strong>{bot.name}</strong>
            {bot.description !== "" && <span className="muted"> · {bot.description}</span>}
          </>
        ),
        detail: plainText(conversation?.lastMessage?.text ?? ""),
        icon: <Avatar avatar={bot.avatar} color={bot.color} seed={bot.id} size="md" />,
        text: bot.name,
        run: () => ui().selectBot(bot.id),
      });
    }
    for (const hit of hits) {
      const bot = bots[hit.botId];
      if (bot === undefined) continue;
      out.push({
        id: `msg-${hit.id}`,
        section: "Conversas",
        label: <strong>{bot.name}</strong>,
        detail: hit.excerpt,
        icon: <MessageSquare size={18} aria-hidden="true" />,
        text: hit.excerpt,
        run: () => ui().selectBot(bot.id),
      });
    }
    const actions: { id: string; label: string; icon: ReactNode; run(): void }[] = [];
    // Run controls: only while the selected bot has a run that can take them.
    const activeRun = Object.values(runs)
      .filter((r) => r.botId === selected && ["queued", "running"].includes(r.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    const selectedBot = selected === null ? undefined : bots[selected];
    if (activeRun !== undefined) {
      const act = (name: "pause" | "interrupt" | "cancel" | "resume") => () =>
        void sync.runAction(activeRun.id, name);
      if (activeRun.paused)
        actions.push({
          id: "resume",
          label: "Continuar a execução",
          icon: <Play size={18} />,
          run: act("resume"),
        });
      else
        actions.push({
          id: "pause",
          label: "Pausar a execução",
          icon: <Pause size={18} />,
          run: act("pause"),
        });
      actions.push({
        id: "interrupt",
        label: "Interromper agora",
        icon: <Square size={18} />,
        run: act("interrupt"),
      });
      actions.push({
        id: "cancel",
        label: "Cancelar a execução",
        icon: <Ban size={18} />,
        run: act("cancel"),
      });
    }
    if (selectedBot !== undefined)
      actions.push({
        id: "edit",
        label: `Editar ${selectedBot.name}`,
        icon: <Pencil size={18} />,
        run: () => ui().openEditBot(selectedBot.id),
      });
    actions.push(
      { id: "new", label: "Novo bot", icon: <Plus size={18} />, run: () => ui().openNewBot() },
      {
        id: "memory",
        label: "Abrir memória",
        icon: <Brain size={18} />,
        run: () => ui().go("memory"),
      },
      {
        id: "pending",
        label: "Pendências",
        icon: <Inbox size={18} />,
        run: () => ui().go("pending"),
      },
      {
        id: "settings",
        label: "Configurações",
        icon: <Settings size={18} />,
        run: () => ui().openSettings(),
      },
      {
        id: "sidebar",
        label: collapsed ? "Expandir a barra lateral" : "Recolher a barra lateral",
        icon: <PanelLeftClose size={18} />,
        run: () => ui().toggleSidebar(),
      },
      {
        id: "shortcuts",
        label: "Atalhos de teclado",
        icon: <Keyboard size={18} />,
        run: () => ui().setShortcuts(true),
      },
      {
        id: "disconnect",
        label: "Desconectar",
        icon: <LogOut size={18} />,
        run: () => void disconnect(),
      },
    );
    const q = fold(query.trim());
    for (const a of actions) {
      if (q === "" || fold(a.label).includes(q)) {
        out.push({
          id: `action-${a.id}`,
          section: "Ações",
          label: a.label,
          icon: a.icon,
          text: a.label,
          run: a.run,
        });
      }
    }
    return out;
  }, [ordered, query, hits, conversations, bots, runs, selected, collapsed, sync, disconnect]);

  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, entries.length - 1)));
  }, [entries.length]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }, [active, entries]);

  const choose = (entry: Entry | undefined) => {
    if (entry === undefined) return;
    close();
    entry.run();
  };

  const sections = ["Bots", "Conversas", "Ações"] as const;
  return (
    <div
      className="ui-scrim ui-scrim--top"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Busca e ações"
        className="palette"
        data-testid="palette"
        // A modal surface keeps the focus: if something else takes it while the palette is open,
        // the field gets it back.
        onBlur={(e) => {
          if (e.relatedTarget instanceof Node && !e.currentTarget.contains(e.relatedTarget))
            inputRef.current?.focus();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((i) => (entries.length === 0 ? 0 : (i + 1) % entries.length));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((i) =>
              entries.length === 0 ? 0 : (i - 1 + entries.length) % entries.length,
            );
          } else if (e.key === "Enter") {
            e.preventDefault();
            choose(entries[active]);
          } else if (e.key === "Tab") {
            // the focus trap: the field is the only stop
            e.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        <div className="palette__field">
          <Search size={20} aria-hidden="true" />
          <input
            ref={inputRef}
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={
              entries[active] === undefined ? undefined : `${listId}-${entries[active]?.id}`
            }
            aria-autocomplete="list"
            aria-label="Buscar Bots, chats, configurações"
            className="palette__input"
            placeholder="Buscar Bots, chats, configurações…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Resultados"
          className="palette__list"
        >
          {sections.map((section) => {
            const items = entries.filter((e) => e.section === section);
            if (items.length === 0) return null;
            return (
              <div key={section} role="group" aria-label={section}>
                <p className="section-label palette__section">{section}</p>
                {items.map((entry) => {
                  const index = entries.indexOf(entry);
                  return (
                    <div
                      key={entry.id}
                      id={`${listId}-${entry.id}`}
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === active}
                      className={`palette__option${index === active ? " palette__option--active" : ""}`}
                      data-testid="palette-option"
                      onMouseMove={() => setActive(index)}
                      onClick={() => choose(entry)}
                      onKeyDown={() => {}}
                    >
                      <span className="palette__icon">{entry.icon}</span>
                      <span className="palette__text">
                        <span className="palette__label">{entry.label}</span>
                        {entry.detail !== undefined && entry.detail !== "" && (
                          <span className="palette__detail muted">{entry.detail}</span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })}
          {entries.length === 0 && (
            <p className="palette__empty muted" role="status">
              {searching ? "Buscando…" : "Nada encontrado."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Ctrl/⌘ + K", "Abrir a busca e as ações"],
  ["Ctrl/⌘ + B", "Recolher ou expandir a barra lateral"],
  ["Enter", "Enviar a mensagem"],
  ["Shift + Enter", "Quebrar a linha na mensagem"],
  ["↑ ↓", "Mover entre os bots, as opções e os resultados"],
  ["Enter (na lista de bots)", "Abrir a conversa do bot"],
  [
    "Menu de contexto / Shift + F10",
    "Opções do bot na barra lateral, e controles da execução no chip do bot",
  ],
  ["Esc", "Fechar a janela, o menu ou a busca"],
];

export function ShortcutsDialog() {
  const close = () => useUi.getState().setShortcuts(false);
  return (
    <Dialog
      title="Atalhos de teclado"
      onClose={close}
      footer={
        <Pill tone="primary" onClick={close}>
          Fechar
        </Pill>
      }
    >
      <dl className="shortcuts">
        {SHORTCUTS.map(([keys, what]) => (
          <div key={keys} className="shortcuts__row">
            <dt>
              <kbd>{keys}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
