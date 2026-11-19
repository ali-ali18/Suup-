import { create } from "zustand";
import {
  PANEL_SPEC,
  type PaneLayout,
  type PaneSpec,
  parseStoredFlag,
  parseStoredWidth,
  SIDEBAR_SPEC,
} from "../lib/pane-size.js";
import type { ToastItem } from "../ui/primitives.js";

export type View = "chat" | "pending" | "memory" | "inspector";
export type PanelTab = "activity" | "library";
/** The sections of the settings dialog. */
export type SettingsTab = "general" | "permissions" | "memory" | "vault" | "connectors";

export interface UiState {
  view: View;
  /** The settings dialog (a modal over whatever screen is open). */
  settingsOpen: boolean;
  /** The section of the settings dialog that is open. */
  settingsTab: SettingsTab;
  /** The connector whose details are open in Conectores (`null`: the list). Clicking "Conectores" in the nav, or Esc, goes back to the list. */
  settingsConnector: string | null;
  selectedBotId: string | null;
  panelOpen: boolean;
  panelTab: PanelTab;
  /** The run the inspector looks at. */
  inspectorRunId: string | null;
  /** Where "back" from the inspector goes. */
  inspectorFrom: View;
  newBotOpen: boolean;
  /** The bot being edited in the same dialog as "Novo bot" (`null`: creating). */
  editBotId: string | null;
  /** Which step the bot dialog opens on (the empty chat hint opens the second). */
  editBotStep: 1 | 2;
  sidebarCollapsed: boolean;
  /** A última largura aberta da barra lateral (continua guardada com ela recolhida). */
  sidebarWidth: number;
  /** A última largura do painel do bot (continua guardada com ele fechado). */
  panelWidth: number;
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  groupBotId: string | null;
  openEditBot(botId: string, step?: 1 | 2): void;
  toggleSidebar(): void;
  /** Recolhe ou expande sem mexer na largura guardada (usado durante o arrasto). */
  setSidebarCollapsed(collapsed: boolean): void;
  /** Grava o resultado de um arrasto ou de uma tecla na alça da barra lateral. */
  setSidebarLayout(layout: PaneLayout): void;
  /** Idem para o painel do bot (`collapsed`: fechado). */
  setPanelLayout(layout: PaneLayout): void;
  setPalette(open: boolean): void;
  setShortcuts(open: boolean): void;
  setGroupBot(botId: string | null): void;
  /** Which memories the full Memory screen starts on: every bot, or this one. */
  memoryBot: string;
  setMemoryBot(botId: string): void;
  toasts: ToastItem[];
  openNewBot(): void;
  closeNewBot(): void;
  go(view: View): void;
  /** Opens the settings dialog on a section. */
  openSettings(tab?: SettingsTab): void;
  closeSettings(): void;
  /** Selects a section. Always lands on its first view: a connector's details close. */
  setSettingsTab(tab: SettingsTab): void;
  /** Opens a connector's details (or goes back to the list with `null`). */
  setSettingsConnector(name: string | null): void;
  selectBot(botId: string): void;
  openPanel(tab?: PanelTab): void;
  togglePanel(): void;
  setPanelTab(tab: PanelTab): void;
  openInspector(runId: string): void;
  closeInspector(): void;
  toast(text: string, tone?: ToastItem["tone"]): void;
  dismissToast(id: number): void;
}

const COLLAPSED_KEY = "suup.sidebarCollapsed";
const PANEL_OPEN_KEY = "suup.panelOpen";

// Per-viewer conveniences only (the layout, the theme): never anything the server must know.
function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}
function writeFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // not remembered
  }
}

function readText(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeText(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}
const readWidth = (spec: PaneSpec) => parseStoredWidth(spec, readText(spec.key));

let toastId = 0;

/** What the person is looking at: screen, selected bot, panel, theme, toasts. Never server data. */
export const useUi = create<UiState>((set, get) => ({
  view: "chat",
  settingsOpen: false,
  settingsTab: "general",
  settingsConnector: null,
  selectedBotId: null,
  // Closed by default on narrow windows (the layout has no room for three columns there).
  // Quem abriu ou fechou o painel guardou a escolha; sem ela, aberto só em janelas largas.
  panelOpen: parseStoredFlag(
    readText(PANEL_OPEN_KEY),
    typeof window === "undefined" ? true : window.innerWidth >= 1280,
  ),
  panelWidth: readWidth(PANEL_SPEC),
  panelTab: "activity",
  inspectorRunId: null,
  inspectorFrom: "chat",
  newBotOpen: false,
  editBotId: null,
  editBotStep: 1,
  sidebarCollapsed: readFlag(COLLAPSED_KEY),
  sidebarWidth: readWidth(SIDEBAR_SPEC),
  paletteOpen: false,
  shortcutsOpen: false,
  groupBotId: null,
  openEditBot: (botId, step = 1) => set({ newBotOpen: true, editBotId: botId, editBotStep: step }),
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    writeFlag(COLLAPSED_KEY, next);
    set({ sidebarCollapsed: next });
  },
  setSidebarCollapsed: (collapsed) => {
    writeFlag(COLLAPSED_KEY, collapsed);
    set({ sidebarCollapsed: collapsed });
  },
  setSidebarLayout: ({ collapsed, width }) => {
    writeFlag(COLLAPSED_KEY, collapsed);
    if (collapsed) return set({ sidebarCollapsed: true });
    writeText(SIDEBAR_SPEC.key, String(width));
    set({ sidebarCollapsed: false, sidebarWidth: width });
  },
  setPanelLayout: ({ collapsed, width }) => {
    writeText(PANEL_OPEN_KEY, collapsed ? "0" : "1");
    if (collapsed) return set({ panelOpen: false });
    writeText(PANEL_SPEC.key, String(width));
    set({ panelOpen: true, panelWidth: width });
  },
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setShortcuts: (shortcutsOpen) => set({ shortcutsOpen }),
  setGroupBot: (groupBotId) => set({ groupBotId }),
  memoryBot: "all",
  setMemoryBot: (memoryBot) => set({ memoryBot }),
  toasts: [],
  openNewBot: () => set({ newBotOpen: true, editBotId: null, editBotStep: 1 }),
  closeNewBot: () => set({ newBotOpen: false, editBotId: null }),
  go: (view) => set({ view }),
  openSettings: (settingsTab) =>
    set((s) => ({
      settingsOpen: true,
      settingsTab: settingsTab ?? s.settingsTab,
      settingsConnector: null,
    })),
  closeSettings: () => set({ settingsOpen: false, settingsConnector: null }),
  leaveServer: () =>
    set({
      view: "chat",
      settingsOpen: false,
      settingsConnector: null,
      selectedBotId: null,
      inspectorRunId: null,
      newBotOpen: false,
      editBotId: null,
      paletteOpen: false,
      shortcutsOpen: false,
      groupBotId: null,
    }),
  setSettingsTab: (settingsTab) => set({ settingsTab, settingsConnector: null }),
  setSettingsConnector: (settingsConnector) => set({ settingsConnector }),
  selectBot: (botId) => set({ view: "chat", selectedBotId: botId }),
  openPanel: (tab) => set((s) => ({ panelOpen: true, panelTab: tab ?? s.panelTab })),
  togglePanel: () => {
    const next = !get().panelOpen;
    writeText(PANEL_OPEN_KEY, next ? "1" : "0");
    set({ panelOpen: next });
  },
  setPanelTab: (panelTab) => set({ panelTab }),
  openInspector: (runId) =>
    set((s) => ({
      view: "inspector",
      inspectorRunId: runId,
      inspectorFrom: s.view === "inspector" ? s.inspectorFrom : s.view,
    })),
  closeInspector: () => set((s) => ({ view: s.inspectorFrom })),
  toast: (text, tone = "info") =>
    set({ toasts: [...get().toasts.slice(-3), { id: ++toastId, tone, text }] }),
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));
