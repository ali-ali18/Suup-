import type { Page } from "@playwright/test";
import type { World } from "./harness.js";

/** What the fake shell does when asked for the embedded server. */
export interface MockOptions {
  /** The bots' machine as the shell reports it. */
  isolation?: { mode: "docker" | "local"; reason: string | null; detail: string | null };
  /** The first start fails with this reason (a second one, after "Tentar de novo", works). */
  failFirstStartWith?: string;
}

/**
 * Plays the Tauri shell in the browser: the app detects Tauri by `__TAURI_INTERNALS__`, so this
 * defines it before the page's own scripts run. The keychain and the files are `localStorage`; the
 * requests go through the page's `fetch`; "the server this computer carries" is the test's real
 * server (the harness), reached after the stages the real shell would report.
 */
export async function installTauriMock(
  page: Page,
  world: World,
  options: MockOptions = {},
): Promise<void> {
  await page.addInitScript(
    ({ serverUrl, token, options }) => {
      const store = (key: string): string | null => localStorage.getItem(`mock.${key}`);
      const put = (key: string, value: string | null) =>
        value === null
          ? localStorage.removeItem(`mock.${key}`)
          : localStorage.setItem(`mock.${key}`, value);
      const w = window as unknown as Record<string, unknown>;
      const callbacks = new Map<number, unknown>();
      let nextCallback = 1;
      // The embedded server, simulated: stages one after the other, then ready.
      let status = {
        state: "idle",
        stage: null as string | null,
        message: null as string | null,
        url: null as string | null,
        isolation: null as unknown,
        attempt: 0,
        restartInSeconds: null,
        hasApiKey: store("apiKey") !== null,
        logsDir: "/mock/logs",
      };
      let failures = 0;
      const begin = () => {
        status = {
          ...status,
          state: "starting",
          stage: "database",
          message: null,
          attempt: status.attempt + 1,
        };
        const steps: [number, () => void][] = [
          [250, () => (status = { ...status, stage: "migrations" })],
          [500, () => (status = { ...status, stage: "machine" })],
          [750, () => (status = { ...status, stage: "server" })],
          [
            1000,
            () => {
              if (options.failFirstStartWith !== undefined && failures === 0) {
                failures += 1;
                status = {
                  ...status,
                  state: "failed",
                  stage: null,
                  message: options.failFirstStartWith,
                };
              } else {
                status = {
                  ...status,
                  state: "ready",
                  stage: null,
                  url: serverUrl,
                  isolation: options.isolation ?? {
                    mode: "local",
                    reason: "docker_missing",
                    detail: null,
                  },
                };
              }
            },
          ],
        ];
        for (const [ms, run] of steps) setTimeout(run, ms);
      };
      const commands: Record<string, (args: Record<string, unknown>) => unknown> = {
        mode_load: () => store("mode"),
        mode_save: (a) => put("mode", a.mode as string),
        mode_clear: () => {
          put("mode", null);
          put("connection", null);
        },
        connection_load: () =>
          store("mode") === "vps" ? JSON.parse(store("connection") ?? "null") : null,
        connection_save: (a) =>
          put("connection", JSON.stringify({ serverUrl: a.serverUrl, token: a.token })),
        connection_clear: () => put("connection", null),
        connection_allow: () => undefined,
        settings_load: () => store("settings"),
        settings_save: (a) => put("settings", a.json as string),
        local_status: () => status,
        local_select: () => {
          put("mode", "local");
          begin();
        },
        local_start: () => begin(),
        local_stop: () => {
          status = { ...status, state: "idle", stage: null, url: null };
        },
        local_connection: () => ({ serverUrl, token }),
        local_set_api_key: (a) => {
          put("apiKey", "saved");
          (w as { __mockKeyLength?: number }).__mockKeyLength = String(a.key).length;
          status = { ...status, hasApiKey: true };
        },
        local_open_logs: () => undefined,
        local_database_url: () => "postgres://suup:senha-de-mentira@127.0.0.1:5999/suup",
        open_url: () => undefined,
        http_abort: () => undefined,
        http_fetch: async (a) => {
          const channel = a.onEvent as { onmessage(m: unknown): void };
          try {
            const response = await fetch(a.url as string, {
              method: a.method as string,
              headers: Object.fromEntries(a.headers as [string, string][]),
              body: (a.body as string | null) ?? null,
            });
            channel.onmessage({
              kind: "head",
              status: response.status,
              statusText: response.statusText,
              headers: [...response.headers.entries()],
            });
            const reader = response.body?.getReader();
            for (;;) {
              const next = await reader?.read();
              if (next === undefined || next.done) break;
              channel.onmessage({ kind: "chunk", data: [...next.value] });
            }
            channel.onmessage({ kind: "end" });
          } catch (e) {
            channel.onmessage({ kind: "error", message: String(e) });
          }
        },
      };
      // The real shell starts the server at launch when "neste computador" is the saved mode
      // (`local::start_if_selected`): a reloaded page finds it starting again.
      if (store("mode") === "local") begin();
      w.__TAURI_INTERNALS__ = {
        transformCallback(callback: unknown) {
          const id = nextCallback++;
          callbacks.set(id, callback);
          return id;
        },
        unregisterCallback: (id: number) => callbacks.delete(id),
        convertFileSrc: (p: string) => p,
        async invoke(cmd: string, args: Record<string, unknown> = {}) {
          const run = commands[cmd];
          if (run === undefined) throw new Error(`comando desconhecido no mock: ${cmd}`);
          return run(args);
        },
      };
    },
    { serverUrl: world.serverUrl, token: world.token, options },
  );
}
