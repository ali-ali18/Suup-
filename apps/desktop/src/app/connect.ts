import { ApiError, createClient } from "@suup/api";
import { createDataStore } from "../data/store.js";
import { Sync } from "../data/sync.js";
import { friendlyError } from "../lib/friendly-error.js";
import type { Connection, Platform, ServerMode } from "../lib/platform.js";
import type { Services } from "./context.js";
import { useSettings } from "./settings-store.js";
import { useUi } from "./ui-store.js";

/** `localhost:8787` -> `http://localhost:8787`; no trailing slash. */
export function normalizeServerUrl(input: string): string {
  let text = input.trim();
  if (text === "") return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `http://${text}`;
  return text.replace(/\/+$/, "");
}

/** What went wrong while connecting, in words a person can act on. */
export function describeConnectError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "unauthorized":
        return "O servidor recusou o token. Confira se é o mesmo que você configurou nele.";
      case "origin_not_allowed":
        return "Este servidor ainda não aceita o app: libere o app na configuração do servidor.";
      case "network":
        return "Não consegui falar com o servidor. Confira o endereço e se ele está no ar.";
      case "invalid_response":
        return "Esse endereço respondeu, mas não parece ser um servidor Suup.";
      default:
        return friendlyError(error);
    }
  }
  return friendlyError(error);
}

/**
 * Validates the address (`/health`) and the token (an authenticated call), then opens the stream.
 * Throws an `ApiError` the connect screen turns into a message.
 */
export async function connect(
  connection: Connection,
  platform: Platform,
  hooks: { mode: ServerMode; disconnect: () => Promise<void>; switchServer: () => Promise<void> },
): Promise<Services> {
  const onDisconnect = hooks.disconnect;
  const api = createClient({
    baseUrl: connection.serverUrl,
    token: connection.token,
    fetch: platform.fetch,
  });
  await api.health();
  await api.bots.list(); // 401 here means a wrong token
  const data = createDataStore();
  const sync = new Sync({
    api,
    store: data,
    onError: (message) => useUi.getState().toast(message, "error"),
    onNotice: (notice) => {
      // Only when the person is not looking at the window.
      if (typeof document !== "undefined" && document.hasFocus()) return;
      if (notice.kind === "approval" && useSettings.getState().settings.notifyApprovals === "off") {
        return;
      }
      const bot = notice.botId === null ? undefined : data.getState().bots[notice.botId];
      const name = bot?.name ?? "Suup";
      const title =
        notice.kind === "question"
          ? `${name} tem uma pergunta`
          : notice.kind === "approval"
            ? `${name} pede a sua aprovação`
            : notice.kind === "done"
              ? `${name} terminou`
              : `${name} não conseguiu concluir`;
      void platform.notify({ title, body: notice.text.slice(0, 160) });
    },
    onRefused: (error) => {
      useUi.getState().toast(describeConnectError(error), "error");
      void onDisconnect();
    },
  });
  const ok = await sync.start();
  if (!ok) {
    sync.stop();
    throw new ApiError("unauthorized", "O servidor recusou a conexão em tempo real.");
  }
  return {
    api,
    sync,
    data,
    platform,
    connection,
    mode: hooks.mode,
    disconnect: onDisconnect,
    switchServer: hooks.switchServer,
  };
}
