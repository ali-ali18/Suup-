import { create } from "zustand";
import type { Platform } from "../lib/platform.js";
import {
  applySettings,
  DEFAULT_SETTINGS,
  LEGACY_THEME_KEY,
  migrateSettings,
  type Settings,
  serializeSettings,
} from "../lib/settings.js";

interface SettingsState {
  settings: Settings;
  /** Changes some settings: applied to the root at once and saved. */
  update(patch: Partial<Settings>): void;
}

let storage: Platform["settings"] | undefined;

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  update(patch) {
    const settings = { ...get().settings, ...patch };
    set({ settings });
    if (typeof document !== "undefined") applySettings(document.documentElement, settings);
    void storage?.save(serializeSettings(settings));
  },
}));

/** Reads the saved settings (validated; the old theme key migrated) and applies them to the root. */
export async function initSettings(platform: Platform): Promise<void> {
  storage = platform.settings;
  let stored: string | null = null;
  try {
    stored = await platform.settings.load();
  } catch {
    stored = null;
  }
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_THEME_KEY);
  } catch {
    legacy = null;
  }
  const settings = migrateSettings(stored, legacy);
  useSettings.setState({ settings });
  applySettings(document.documentElement, settings);
  // Written back in the current format, so the older key is not needed again.
  if (stored === null && legacy !== null) void platform.settings.save(serializeSettings(settings));
}
