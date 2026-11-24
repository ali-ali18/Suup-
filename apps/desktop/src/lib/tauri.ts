import { Channel, invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type {
  AppNotification,
  AppUpdater,
  Connection,
  LocalServer,
  LocalStatus,
  Platform,
  ServerMode,
  UpdateInfo,
  UpdateProgress,
  WindowFrame,
} from "./platform.js";

// The Tauri side. Everything that leaves the app goes through Rust commands, never through the
// webview's own network: the page's CSP allows no network origin at all (see src-tauri), and the
// Rust side only talks to the server address the person configured (and re-checks every URL).

type FetchEvent =
  | { kind: "head"; status: number; statusText: string; headers: [string, string][] }
  | { kind: "chunk"; data: number[] }
  | { kind: "end" }
  | { kind: "error"; message: string };

let nextId = 1;

/** A `fetch` that runs in Rust: same `Response` (with a streaming body, for the SSE stream). */
export const tauriFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  const id = nextId++;
  const body = request.body === null ? null : await request.text();
  const channel = new Channel<FetchEvent>();
  const headers: [string, string][] = [];
  for (const [key, value] of request.headers.entries()) headers.push([key, value]);

  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    let settled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        void invoke("http_abort", { id });
      },
    });
    const fail = (message: string) => {
      if (!settled) {
        settled = true;
        reject(new TypeError(message));
      } else {
        try {
          controller?.error(new TypeError(message));
        } catch {
          // already closed
        }
      }
    };
    request.signal.addEventListener("abort", () => {
      void invoke("http_abort", { id });
      fail("aborted");
    });
    channel.onmessage = (event) => {
      if (event.kind === "head") {
        settled = true;
        const nullBody = [101, 204, 205, 304].includes(event.status);
        resolve(
          new Response(nullBody ? null : stream, {
            status: event.status,
            statusText: event.statusText,
            headers: event.headers,
          }),
        );
      } else if (event.kind === "chunk") {
        controller?.enqueue(new Uint8Array(event.data));
      } else if (event.kind === "end") {
        try {
          controller?.close();
        } catch {
          // already closed
        }
      } else {
        fail(event.message);
      }
    };
    invoke("http_fetch", {
      id,
      method: request.method,
      url: request.url,
      headers,
      body,
      onEvent: channel,
    }).catch((e: unknown) => fail(String(e)));
  });
};

/** How often the app asks the shell what the embedded server is doing (a cheap, local call). */
const STATUS_POLL_MS = 700;

/** The embedded server: the Rust side runs and supervises it; the app only asks and tells. */
export function tauriLocal(): LocalServer {
  const status = () => invoke<LocalStatus>("local_status");
  return {
    status,
    async onStatus(handler) {
      let last = "";
      let stopped = false;
      const tick = async () => {
        try {
          const now = await status();
          const text = JSON.stringify(now);
          if (!stopped && text !== last) {
            last = text;
            handler(now);
          }
        } catch {
          // the shell is busy for a moment: the next tick tries again
        }
      };
      const timer = setInterval(() => void tick(), STATUS_POLL_MS);
      return () => {
        stopped = true;
        clearInterval(timer);
      };
    },
    select: () => invoke("local_select"),
    start: () => invoke("local_start"),
    stop: () => invoke("local_stop"),
    connection: () => invoke<Connection>("local_connection"),
    setApiKey: (key) => invoke("local_set_api_key", { key }),
    openLogs: () => invoke("local_open_logs"),
    databaseUrl: () => invoke<string>("local_database_url"),
  };
}

/** The updater lives in Rust (`src-tauri/src/update.rs`); the page only asks. */
export function tauriUpdater(): AppUpdater {
  return {
    info: () => invoke<UpdateInfo>("update_info"),
    check: () => invoke<{ version: string } | null>("update_check"),
    async download(onProgress) {
      const channel = new Channel<{ kind: "progress" } & UpdateProgress>();
      channel.onmessage = (event) =>
        onProgress({ downloaded: event.downloaded, total: event.total });
      await invoke("update_download", { onEvent: channel });
    },
    install: () => invoke("update_install"),
  };
}

/** The window of the shell: a title bar of the system, or none (then the app draws its controls). */
function tauriFrame(): WindowFrame {
  return {
    custom: async () => !(await getCurrentWindow().isDecorated()),
    minimize: () => getCurrentWindow().minimize(),
    toggleMaximize: () => getCurrentWindow().toggleMaximize(),
    close: () => getCurrentWindow().close(),
    isMaximized: () => getCurrentWindow().isMaximized(),
  };
}

export function tauriPlatform(): Platform {
  return {
    kind: "tauri",
    frame: tauriFrame(),
    connection: {
      load: () => invoke<Connection | null>("connection_load"),
      save: (connection) =>
        invoke("connection_save", { serverUrl: connection.serverUrl, token: connection.token }),
      clear: () => invoke("connection_clear"),
    },
    local: tauriLocal(),
    updater: tauriUpdater(),
    mode: {
      load: () => invoke<ServerMode | null>("mode_load"),
      save: (mode) => invoke("mode_save", { mode }),
      clear: () => invoke("mode_clear"),
    },
    settings: {
      load: () => invoke<string | null>("settings_load"),
      save: (json) => invoke("settings_save", { json }),
    },
    fetch: tauriFetch,
    allowServer: (serverUrl) => invoke("connection_allow", { serverUrl }),
    async notify({ title, body }: AppNotification) {
      try {
        const { isPermissionGranted, requestPermission, sendNotification } = await import(
          "@tauri-apps/plugin-notification"
        );
        let granted = await isPermissionGranted();
        if (!granted) granted = (await requestPermission()) === "granted";
        if (granted) sendNotification({ title, body });
      } catch {
        // notifications are a courtesy
      }
    },
    openUrl(url) {
      void invoke("open_url", { url });
    },
    // The download, the "Salvar como" window and the opening happen in Rust (`files.rs`), through
    // the same single allowed server as every request.
    files: {
      save: (file) => invoke<boolean>("file_save", { ...file }),
      open: (file) => invoke("file_open", { ...file }),
    },
  };
}
