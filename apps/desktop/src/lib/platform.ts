// The few things that differ between the Tauri shell and a plain browser (dev, e2e): where the
// connection is stored, how requests leave the app, and how a notification is shown. Everything
// else in the app is the same code.

export interface Connection {
  serverUrl: string;
  token: string;
}

/** Where the server address and the token live. The token never goes to a plain file or localStorage. */
export interface ConnectionStore {
  load(): Promise<Connection | null>;
  save(connection: Connection): Promise<void>;
  clear(): Promise<void>;
}

export interface AppNotification {
  title: string;
  body: string;
}

/** Where the app keeps its own settings (per installation; the server never sees them). */
export interface SettingsStore {
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
}

/**
 * Which server this device uses: the one the app carries (`local`, "neste computador") or the
 * owner's own (`vps`). One brain at a time, no sync (docs/PLANO.md, "app embutido").
 */
export type ServerMode = "local" | "vps";

/** Where the choice is kept: per device, next to the server address (never on the server). */
export interface ModeStore {
  load(): Promise<ServerMode | null>;
  save(mode: ServerMode): Promise<void>;
  /** Forgets the choice (and what was kept for it): the next start asks again. */
  clear(): Promise<void>;
}

/** What the embedded server is doing, in the order it gets there. */
export type LocalStage = "database" | "migrations" | "machine" | "server";

export type LocalState = "idle" | "starting" | "ready" | "restarting" | "failed" | "stopping";

/**
 * Why the bots' machine is NOT isolated, as a code (the app writes the sentence): there is no
 * Docker, or it cannot serve the bots' network from this computer, or its images could not be built.
 */
export type NoIsolationReason =
  | "docker_missing"
  | "gateway_unreachable"
  | "image_failed"
  | "network_failed";

export interface LocalIsolation {
  /** `docker`: a container with no network of its own. `local`: the bots run on this computer. */
  mode: "docker" | "local";
  reason: NoIsolationReason | null;
  /** The technical detail of the reason, for the log line under it (never parsed). */
  detail: string | null;
}

export interface LocalStatus {
  state: LocalState;
  stage: LocalStage | null;
  /** The reason of a failure or of a wait, in words (from the supervisor; shown, never parsed). */
  message: string | null;
  url: string | null;
  isolation: LocalIsolation | null;
  /** Which start this is (1 for the first); grows with every restart after a crash. */
  attempt: number;
  restartInSeconds: number | null;
  /** Whether an API key of the model provider is saved (the key itself never comes back). */
  hasApiKey: boolean;
  /** The folder of the log files. */
  logsDir: string;
}

/** The server the app carries: only the Tauri shell has it (the browser build has no `local`). */
export interface LocalServer {
  status(): Promise<LocalStatus>;
  /** Calls `handler` on every change of the status; resolves to the function that stops it. */
  onStatus(handler: (status: LocalStatus) => void): Promise<() => void>;
  /** Chooses "neste computador" for this device and starts the server. */
  select(): Promise<void>;
  /** Starts it again (after a failure the supervisor gave up on). */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The address and token of the running server (the token comes from the OS keychain). */
  connection(): Promise<Connection>;
  /** Saves the model provider's key in the OS keychain; a running server restarts to take it. */
  setApiKey(key: string): Promise<void>;
  /** Opens the folder of the log files in the system's file manager. */
  openLogs(): Promise<void>;
  /** The address of the app's own database, password included (to back it up or move it to a VPS). */
  databaseUrl(): Promise<string>;
}

/**
 * The window's frame (Tauri only). When the window has no system title bar the app draws its own
 * controls, inside itself, like the Grok Bot (owner's decision, 22/11/2026).
 */
export interface WindowFrame {
  /** True when the window has no system title bar: the app draws minimize, maximize and close. */
  custom(): Promise<boolean>;
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
}

export interface Platform {
  /** `"tauri"` (token in the OS keychain, requests through the Rust side) or `"browser"`. */
  kind: "tauri" | "browser";
  connection: ConnectionStore;
  /** Which server this device uses (Tauri only: the browser build always connects to one address). */
  mode?: ModeStore;
  /** The server the app carries (Tauri only). */
  local?: LocalServer;
  /** The window's frame (Tauri only). */
  frame?: WindowFrame;
  settings: SettingsStore;
  /** The `fetch` every request of the app goes through. */
  fetch: typeof fetch;
  /** Shows a system notification (the caller already checked the window is not focused). */
  notify(notification: AppNotification): Promise<void>;
  /**
   * Lets the app talk to this server (Tauri: the Rust side only reaches the one server that was
   * allowed). Called with what the person typed, before the connection is tested. Browser: nothing.
   */
  allowServer?(serverUrl: string): Promise<void>;
  /** Opens a link outside the app (the system browser). Only http(s) and mailto get here. */
  openUrl(url: string): void;
}

const KEY = "suup.connection";

/** Browser / dev mode: `sessionStorage` behind the same interface (gone when the tab closes). */
export function browserConnectionStore(
  storage: () => Storage = () => sessionStorage,
): ConnectionStore {
  return {
    async load() {
      try {
        const raw = storage().getItem(KEY);
        if (raw === null) return null;
        const parsed = JSON.parse(raw) as Partial<Connection>;
        return typeof parsed.serverUrl === "string" && typeof parsed.token === "string"
          ? { serverUrl: parsed.serverUrl, token: parsed.token }
          : null;
      } catch {
        return null;
      }
    },
    async save(connection) {
      try {
        storage().setItem(KEY, JSON.stringify(connection));
      } catch {
        // storage blocked: the app keeps working for this session, it just will not remember
      }
    },
    async clear() {
      try {
        storage().removeItem(KEY);
      } catch {
        // idem
      }
    },
  };
}

const SETTINGS_KEY = "suup.settings";

/** Browser / dev mode: `localStorage` (the settings are not secret and should outlive the tab). */
export function browserSettingsStore(storage: () => Storage = () => localStorage): SettingsStore {
  return {
    async load() {
      try {
        return storage().getItem(SETTINGS_KEY);
      } catch {
        return null;
      }
    },
    async save(json) {
      try {
        storage().setItem(SETTINGS_KEY, json);
      } catch {
        // blocked storage: the settings apply for this session only
      }
    },
  };
}

export function browserPlatform(): Platform {
  return {
    kind: "browser",
    connection: browserConnectionStore(),
    settings: browserSettingsStore(),
    fetch: (input, init) => fetch(input, init),
    openUrl(url) {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    async notify({ title, body }) {
      try {
        if (typeof Notification === "undefined") return;
        if (Notification.permission === "default") await Notification.requestPermission();
        if (Notification.permission === "granted") new Notification(title, { body });
      } catch {
        // notifications are a courtesy
      }
    },
  };
}

let current: Platform | undefined;

/** Picks the platform once: Tauri when its bridge is there, the browser otherwise. */
export async function getPlatform(): Promise<Platform> {
  if (current !== undefined) return current;
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    const { tauriPlatform } = await import("./tauri.js");
    current = tauriPlatform();
  } else {
    current = browserPlatform();
  }
  return current;
}

/** For tests. */
export function setPlatform(platform: Platform | undefined): void {
  current = platform;
}
