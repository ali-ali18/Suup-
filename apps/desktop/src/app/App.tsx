import { useCallback, useEffect, useRef, useState } from "react";
import { ConnectScreen } from "../features/connect/ConnectScreen.js";
import { Shell } from "../features/shell/Shell.js";
import { type Connection, getPlatform, type Platform } from "../lib/platform.js";
import { ToastStack } from "../ui/primitives.js";
import { connect, describeConnectError, normalizeServerUrl } from "./connect.js";
import { type Services, ServicesProvider } from "./context.js";
import { initSettings } from "./settings-store.js";
import { useUi } from "./ui-store.js";

type Phase = { kind: "boot" } | { kind: "connect" } | { kind: "ready"; services: Services };

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "boot" });
  const [saved, setSaved] = useState<Connection | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const platformRef = useRef<Platform | null>(null);
  const servicesRef = useRef<Services | null>(null);
  const toasts = useUi((s) => s.toasts);
  const dismissToast = useUi((s) => s.dismissToast);

  const disconnect = useCallback(async () => {
    servicesRef.current?.sync.stop();
    servicesRef.current = null;
    await platformRef.current?.connection.clear();
    setSaved(null);
    setPhase({ kind: "connect" });
  }, []);

  const open = useCallback(
    async (connection: Connection, platform: Platform) => {
      setBusy(true);
      setError(undefined);
      try {
        const services = await connect(connection, platform, disconnect);
        await platform.connection.save(connection);
        servicesRef.current = services;
        setSaved(connection);
        setPhase({ kind: "ready", services });
      } catch (e) {
        setSaved(connection);
        setError(describeConnectError(e));
        setPhase({ kind: "connect" });
      } finally {
        setBusy(false);
      }
    },
    [disconnect],
  );

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const platform = await getPlatform();
      platformRef.current = platform;
      await initSettings(platform);
      const stored = await platform.connection.load();
      if (cancelled) return;
      if (stored === null) setPhase({ kind: "connect" });
      else await open(stored, platform);
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  return (
    <>
      {phase.kind === "boot" && (
        <div className="boot" role="status">
          Conectando…
        </div>
      )}
      {phase.kind === "connect" && (
        <ConnectScreen
          initial={saved}
          error={error}
          busy={busy}
          onSubmit={(serverUrl, token) => {
            const platform = platformRef.current;
            if (platform === null) return;
            void open({ serverUrl: normalizeServerUrl(serverUrl), token: token.trim() }, platform);
          }}
        />
      )}
      {phase.kind === "ready" && (
        <ServicesProvider services={phase.services}>
          <Shell />
        </ServicesProvider>
      )}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
