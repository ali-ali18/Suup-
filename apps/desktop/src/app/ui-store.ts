import { create } from "zustand";
import type { ToastItem } from "../ui/primitives.js";

export type View = "chat" | "pending" | "memory" | "settings" | "inspector";
export type PanelTab = "activity" | "library";

export interface UiState {
  view: View;
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
  paletteOpen: boolean;
  shortcutsOpen: boolean;
  groupBotId: string | null;
  openEditBot(botId: string, step?: 1 | 2): void;
  toggleSidebar(): void;
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

let toastId = 0;

/** What the person is looking at: screen, selected bot, panel, theme, toasts. Never server data. */
export const useUi = create<UiState>((set, get) => ({
  view: "chat",
  selectedBotId: null,
  // Closed by default on narrow windows (the layout has no room for three columns there).
  panelOpen: typeof window === "undefined" ? true : window.innerWidth >= 1280,
  panelTab: "activity",
  inspectorRunId: null,
  inspectorFrom: "chat",
  newBotOpen: false,
  editBotId: null,
  editBotStep: 1,
  sidebarCollapsed: readFlag(COLLAPSED_KEY),
  paletteOpen: false,
  shortcutsOpen: false,
  groupBotId: null,
  openEditBot: (botId, step = 1) => set({ newBotOpen: true, editBotId: botId, editBotStep: step }),
  toggleSidebar: () => {
    const next = !get().sidebarCollapsed;
    writeFlag(COLLAPSED_KEY, next);
    set({ sidebarCollapsed: next });
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
  selectBot: (botId) => set({ view: "chat", selectedBotId: botId }),
  openPanel: (tab) => set((s) => ({ panelOpen: true, panelTab: tab ?? s.panelTab })),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
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
