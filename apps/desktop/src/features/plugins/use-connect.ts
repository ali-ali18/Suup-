import type { CatalogItem, OAuthStatus } from "@suup/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { useServices } from "../../app/context.js";
import { messageOf } from "../../data/sync.js";

// How a person connects an entry of the server's gallery (docs/FRONTEND.md, "Galeria de
// conectores"; docs/CONECTORES.md, "Galeria" and "OAuth"). The steps are the server's: install
// (`POST /v1/connector-catalog/{id}/install`) and follow `next`: `login` (the OAuth of the MCP in the
// system browser, then wait for the server to receive the callback), `secret` (the secure form of
// the vault, then install again), `none` (done). The browser comes back to the server on its own
// (its loopback, or its public address): there is never an address to paste (the owner, 23/11/2026).
// Nothing is optimistic: the screen shows what the server answers.

/** How often the app asks where a browser login stands. */
export const POLL_MS = 1500;

export type ConnectFlow =
  | { kind: "idle" }
  /** A call is on its way (`label`: what the button says meanwhile). */
  | { kind: "busy"; label: string }
  /** The browser login is open: the app asks the server until it is connected, fails or expires. */
  | { kind: "waiting"; connector: string; flowId: string; expiresAt: number; url: string }
  /** The secure form is open for the token the entry declares. */
  | { kind: "secret"; connector: string }
  /** "Desconectar" asks first. */
  | { kind: "confirm-disconnect"; connector: string };

export interface Connect {
  flow: ConnectFlow;
  /** The last failed step, in one friendly sentence (never the server's raw text). */
  error: string | undefined;
  /** The main action of the entry as it stands (Conectar, Fazer login, Informar token, Tentar de novo). */
  connect(): Promise<void>;
  /** The token was saved in the vault: install again, which turns the connector on. */
  secretSaved(): Promise<void>;
  /** Opens the secure form again for a connected token entry ("Trocar o token"). */
  changeToken(): void;
  closeSecret(): void;
  /** Stops waiting for the browser (the server forgets the login when it expires). */
  cancel(): void;
  /** Opens the login page again (a blocked pop-up, a closed tab). */
  reopen(): void;
  askDisconnect(): void;
  closeDisconnect(): void;
  disconnect(): Promise<void>;
  /** Turns an installed connector that is off back on. */
  turnOn(): Promise<void>;
}

export function useConnect(
  item: CatalogItem,
  reload: () => Promise<void>,
  pollMs: number = POLL_MS,
): Connect {
  const { api, sync, platform } = useServices();
  const [flow, setFlow] = useState<ConnectFlow>({ kind: "idle" });
  const [error, setError] = useState<string | undefined>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /** Runs one step: the error of the server is kept in words; the flow goes back to idle. */
  const step = useCallback(async (label: string, job: () => Promise<void>): Promise<void> => {
    setError(undefined);
    setFlow({ kind: "busy", label });
    try {
      await job();
    } catch (e) {
      if (!mounted.current) return;
      setError(messageOf(e));
      setFlow({ kind: "idle" });
    }
  }, []);

  const finished = useCallback(async () => {
    await reload();
    await sync.loadConnectors();
  }, [reload, sync]);

  const startLogin = useCallback(
    async (connector: string) => {
      const start = await api.connectors.oauthStart(connector);
      platform.openUrl(start.authorizationUrl);
      if (!mounted.current) return;
      setFlow({
        kind: "waiting",
        connector,
        flowId: start.flowId,
        expiresAt: new Date(start.expiresAt).getTime(),
        url: start.authorizationUrl,
      });
    },
    [api, platform],
  );

  /** What a status of the login means for the screen. */
  const settle = useCallback(
    async (status: OAuthStatus): Promise<boolean> => {
      if (status.status === "pending") return false;
      if (status.status === "connected") {
        setFlow({ kind: "idle" });
        await finished();
        return true;
      }
      // The server's reason is a log line (it may be the authorization server's own words).
      if (status.error !== null) console.warn("[suup] login:", status.error);
      setError("O login não terminou. Tenta de novo?");
      setFlow({ kind: "idle" });
      await reload();
      return true;
    },
    [finished, reload],
  );

  // While the browser login is open, ask the server where it stands.
  const waiting = flow.kind === "waiting" ? flow : undefined;
  useEffect(() => {
    if (waiting === undefined) return;
    let stopped = false;
    const timer = setInterval(() => {
      void (async () => {
        if (Date.now() > waiting.expiresAt) {
          stopped = true;
          clearInterval(timer);
          setError("O login demorou demais. Tenta de novo?");
          setFlow({ kind: "idle" });
          return;
        }
        try {
          const status = await api.connectors.oauthStatus(waiting.connector);
          if (stopped || !mounted.current) return;
          if (await settle(status)) {
            stopped = true;
            clearInterval(timer);
          }
        } catch (e) {
          if (stopped || !mounted.current) return;
          stopped = true;
          clearInterval(timer);
          setError(messageOf(e));
          setFlow({ kind: "idle" });
        }
      })();
    }, pollMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [waiting, api, settle, pollMs]);

  const install = useCallback(async () => {
    const result = await api.connectorCatalog.install(item.entry.id);
    const connector = result.item.connector ?? result.connector.name;
    if (result.next === "login") {
      await startLogin(connector);
    } else if (result.next === "secret") {
      await reload();
      if (mounted.current) setFlow({ kind: "secret", connector });
    } else {
      if (mounted.current) setFlow({ kind: "idle" });
      await finished();
    }
  }, [api, item.entry.id, startLogin, reload, finished]);

  const connect = useCallback(async () => {
    const connector = item.connector;
    const label = item.entry.auth.kind === "oauth" ? "Abrindo o navegador…" : "Conectando…";
    await step(label, async () => {
      // An installed OAuth entry logs in again; anything else goes through install, which also
      // turns a token entry on once its token is in the vault.
      if (
        connector !== null &&
        item.entry.auth.kind === "oauth" &&
        (item.status === "needs_login" || item.status === "error")
      ) {
        await startLogin(connector);
      } else if (connector !== null && item.status === "needs_secret") {
        setFlow({ kind: "secret", connector });
      } else {
        await install();
      }
    });
  }, [item, step, startLogin, install]);

  const secretSaved = useCallback(async () => {
    await step("Ligando…", async () => {
      const result = await api.connectorCatalog.install(item.entry.id);
      if (result.next === "secret") {
        if (mounted.current) {
          setError("O token ainda não chegou. Tenta de novo?");
          setFlow({ kind: "idle" });
        }
        return;
      }
      if (mounted.current) setFlow({ kind: "idle" });
      await finished();
    });
  }, [api, item.entry.id, step, finished]);

  const disconnect = useCallback(async () => {
    if (flow.kind !== "confirm-disconnect") return;
    const connector = flow.connector;
    await step("Desconectando…", async () => {
      const outcome = await sync.connectorCall(() => api.connectors.oauthDisconnect(connector));
      if (!outcome.ok) {
        if (mounted.current) {
          setError(outcome.message);
          setFlow({ kind: "idle" });
        }
        return;
      }
      if (mounted.current) setFlow({ kind: "idle" });
      await reload();
    });
  }, [api, sync, flow, step, reload]);

  const turnOn = useCallback(async () => {
    const connector = item.connector;
    if (connector === null) return;
    await step("Ligando…", async () => {
      const outcome = await sync.connectorCall(() =>
        api.connectors.update(connector, { enabled: true }),
      );
      if (!outcome.ok) {
        if (mounted.current) {
          setError(outcome.message);
          setFlow({ kind: "idle" });
        }
        return;
      }
      if (mounted.current) setFlow({ kind: "idle" });
      await reload();
    });
  }, [api, sync, item.connector, step, reload]);

  return {
    flow,
    error,
    connect,
    secretSaved,
    changeToken: () => {
      if (item.connector !== null) setFlow({ kind: "secret", connector: item.connector });
    },
    // The form closes itself after saving, while the install that follows is on its way: only a
    // form that is still the flow closes to idle.
    closeSecret: () => setFlow((f) => (f.kind === "secret" ? { kind: "idle" } : f)),
    cancel: () => {
      setFlow({ kind: "idle" });
      void reload();
    },
    reopen: () => {
      if (waiting !== undefined) platform.openUrl(waiting.url);
    },
    askDisconnect: () => {
      if (item.connector !== null) {
        setError(undefined);
        setFlow({ kind: "confirm-disconnect", connector: item.connector });
      }
    },
    closeDisconnect: () => setFlow({ kind: "idle" }),
    disconnect,
    turnOn,
  };
}
