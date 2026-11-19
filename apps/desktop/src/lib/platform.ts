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

export interface Platform {
  /** `"tauri"` (token in the OS keychain, requests through the Rust side) or `"browser"`. */
  kind: "tauri" | "browser";
  connection: ConnectionStore;
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
