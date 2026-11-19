// The appearance of the chat, as ONE typed object with defaults. It is validated whenever it is read
// (an unknown or invalid value falls back to its default), kept in the app's own configuration
// storage (per installation, never on the server), and exposed to the UI as data-attributes on the
// root element: the CSS reads them, so components never read settings one by one.

export const SETTINGS_VERSION = 1;

export interface Settings {
  /** Escuro ou claro. */
  theme: "dark" | "light";
  /** O balão do usuário: a cor do bot, ou sempre neutro. */
  bubble: "bot" | "neutral";
  /** A largura da coluna de leitura. */
  width: "default" | "wide";
  density: "comfortable" | "compact";
  /** A frase do indicador de trabalho: o estado real, ou só os três pontos. */
  phrase: "real" | "discreet";
  /** As ações dobradas ("Mais N ações"). */
  fold: "on" | "off";
  /** O ícone dos sites nos links: busca `https://<host>/favicon.ico`, por isso desligado por padrão. */
  favicons: "off" | "on";
  /** Movimento reduzido: segue o sistema, ou sempre. */
  motion: "system" | "reduce";
  /** Cartões de aprovação já decididos: uma linha que se abre ao clicar, ou já abertos. */
  approvalResolved: "collapsed" | "open";
  /** O conteúdo longo de um cartão de aprovação: recolhido (com "Mostrar tudo"), ou inteiro. */
  approvalLong: "collapse" | "full";
  /** Avisar pelo sistema (com a janela sem foco) quando um bot pede aprovação. */
  notifyApprovals: "on" | "off";
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  bubble: "bot",
  width: "default",
  density: "comfortable",
  phrase: "real",
  fold: "on",
  favicons: "off",
  motion: "system",
  approvalResolved: "collapsed",
  approvalLong: "collapse",
  notifyApprovals: "on",
};

/** What each setting accepts. */
export const SETTING_OPTIONS = {
  theme: ["dark", "light"],
  bubble: ["bot", "neutral"],
  width: ["default", "wide"],
  density: ["comfortable", "compact"],
  phrase: ["real", "discreet"],
  fold: ["on", "off"],
  favicons: ["off", "on"],
  motion: ["system", "reduce"],
  approvalResolved: ["collapsed", "open"],
  approvalLong: ["collapse", "full"],
  notifyApprovals: ["on", "off"],
} as const satisfies { [K in keyof Settings]: readonly Settings[K][] };

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

/**
 * Reads settings from whatever was stored (a JSON string, an object, nothing, rubbish) into a valid
 * `Settings`: every field that is missing, unknown or invalid takes its default. Older or newer
 * stored versions keep what they have in common with this one.
 */
export function parseSettings(raw: unknown): Settings {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  const settings: Settings = { ...DEFAULT_SETTINGS };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return settings;
  const stored = value as Record<string, unknown>;
  for (const key of KEYS) {
    const options = SETTING_OPTIONS[key] as readonly string[];
    const candidate = stored[key];
    if (typeof candidate === "string" && options.includes(candidate)) {
      (settings as unknown as Record<string, string>)[key] = candidate;
    }
  }
  return settings;
}

export function serializeSettings(settings: Settings): string {
  return JSON.stringify({ version: SETTINGS_VERSION, ...settings });
}

/** The data-attributes the root element carries; the stylesheet reads them. */
export function settingsAttributes(settings: Settings): Record<string, string> {
  return {
    "data-theme": settings.theme,
    "data-bubble": settings.bubble,
    "data-width": settings.width,
    "data-density": settings.density,
    "data-phrase": settings.phrase,
    "data-fold": settings.fold,
    "data-favicons": settings.favicons,
    "data-motion": settings.motion,
    "data-approval-resolved": settings.approvalResolved,
    "data-approval-long": settings.approvalLong,
    "data-notify-approvals": settings.notifyApprovals,
  };
}

export function applySettings(root: HTMLElement, settings: Settings): void {
  for (const [name, value] of Object.entries(settingsAttributes(settings)))
    root.setAttribute(name, value);
}

/** The key the app used before settings existed (the theme only): read once, then forgotten. */
export const LEGACY_THEME_KEY = "suup.theme";

/** Settings from the stored text, or, when there is none, from the older keys the app used. */
export function migrateSettings(stored: string | null, legacyTheme: string | null): Settings {
  if (stored !== null) return parseSettings(stored);
  return parseSettings({ theme: legacyTheme });
}
