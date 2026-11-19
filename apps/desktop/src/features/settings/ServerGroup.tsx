import { Activity, Box, FolderOpen, Key, Server, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useServices } from "../../app/context.js";
import type { LocalServer, LocalState, LocalStatus } from "../../lib/platform.js";
import { Dialog, FieldHint, Pill } from "../../ui/primitives.js";
import { SecretInput, type SecretInputHandle } from "../../ui/secret-input.js";
import { machineLine, NO_ISOLATION_WARNING } from "../connect/local-text.js";
import { RowAction, RowValue, SettingsGroup, SettingsRow } from "./parts.js";

const STATE_TEXT: Record<LocalState, string> = {
  idle: "Parado",
  starting: "Iniciando…",
  ready: "Rodando",
  restarting: "Reiniciando…",
  failed: "Parou com erro",
  stopping: "Parando…",
};

/** The status of the embedded server, kept up to date while the settings are open. */
export function useLocalStatus(local: LocalServer | undefined): LocalStatus | undefined {
  const [status, setStatus] = useState<LocalStatus | undefined>(undefined);
  useEffect(() => {
    if (local === undefined) return;
    let off: (() => void) | undefined;
    let gone = false;
    void (async () => {
      off = await local.onStatus(setStatus);
      const now = await local.status();
      if (!gone) setStatus(now);
      else off();
    })();
    return () => {
      gone = true;
      off?.();
    };
  }, [local]);
  return status;
}

function SwitchDialog({ onClose, onConfirm }: { onClose(): void; onConfirm(): void }) {
  return (
    <Dialog
      title="Trocar de servidor?"
      onClose={onClose}
      footer={
        <>
          <Pill tone="secondary" onClick={onClose}>
            Cancelar
          </Pill>
          <Pill tone="primary" onClick={onConfirm} data-testid="switch-confirm">
            Trocar
          </Pill>
        </>
      }
    >
      <FieldHint>
        O Suup usa um servidor de cada vez e os dois não se sincronizam: os bots e as conversas de
        um não aparecem no outro. Nada é apagado, e dá para voltar a este depois.
      </FieldHint>
    </Dialog>
  );
}

function ApiKeyDialog({ local, onClose }: { local: LocalServer; onClose(): void }) {
  const field = useRef<SecretInputHandle>(null);
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const save = async () => {
    const key = (field.current?.take() ?? "").trim();
    if (key === "") return;
    setBusy(true);
    try {
      await local.setApiKey(key);
      field.current?.clear();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Chave da Anthropic"
      onClose={onClose}
      footer={
        <>
          <Pill tone="secondary" onClick={onClose} disabled={busy}>
            Cancelar
          </Pill>
          <Pill tone="primary" onClick={() => void save()} disabled={empty || busy}>
            {busy ? "Guardando…" : "Guardar"}
          </Pill>
        </>
      }
    >
      <SecretInput
        label="Chave"
        ref={field}
        autoFocus
        disabled={busy}
        onEmptyChange={setEmpty}
        onEnter={() => void save()}
        error={error}
        hint="Fica no chaveiro do sistema e nunca é mostrada de novo. O servidor local reinicia para usá-la."
        testId="api-key-input"
      />
    </Dialog>
  );
}

/** Settings > Geral > Servidor: which server this device uses, and, for the one the app carries, its state. */
export function ServerGroup() {
  const { connection, mode, platform, switchServer } = useServices();
  const status = useLocalStatus(mode === "local" ? platform.local : undefined);
  const [switching, setSwitching] = useState(false);
  const [keying, setKeying] = useState(false);
  const canSwitch = platform.local !== undefined || mode === "vps";
  const local = platform.local;
  return (
    <>
      <SettingsGroup label="Servidor" testId="server-group">
        <SettingsRow
          icon={Server}
          title={mode === "local" ? "Neste computador" : "Minha VPS"}
          description={connection.serverUrl}
          descriptionTestId="server-url"
          testId="server-mode"
          control={
            <RowAction onClick={() => setSwitching(true)} data-testid="server-switch">
              {canSwitch ? "Trocar" : "Desconectar"}
            </RowAction>
          }
        />
        {mode === "vps" && (
          <SettingsRow
            icon={Key}
            title="Token de acesso"
            description={
              platform.kind === "tauri"
                ? "Guardado no chaveiro do sistema."
                : "Modo navegador: fica só nesta aba, até ela ser fechada."
            }
          />
        )}
        {mode === "local" && status !== undefined && local !== undefined && (
          <>
            <SettingsRow
              icon={Activity}
              title="Estado"
              testId="local-state"
              control={<RowValue>{STATE_TEXT[status.state]}</RowValue>}
            />
            <SettingsRow
              icon={Box}
              title="Máquina dos bots"
              description={machineLine(status)}
              testId="local-machine"
            />
            {status.isolation?.mode === "local" && (
              <SettingsRow
                icon={ShieldAlert}
                title="Sem isolamento"
                description={NO_ISOLATION_WARNING}
                role="note"
                testId="local-warning"
              />
            )}
            <SettingsRow
              icon={Key}
              title="Chave da Anthropic"
              description={
                status.hasApiKey ? "Guardada no chaveiro do sistema." : "Ainda não definida."
              }
              control={
                <RowAction onClick={() => setKeying(true)} data-testid="api-key-open">
                  {status.hasApiKey ? "Trocar" : "Definir"}
                </RowAction>
              }
            />
            <SettingsRow
              icon={FolderOpen}
              title="Registros"
              description={status.logsDir}
              control={<RowAction onClick={() => void local.openLogs()}>Abrir pasta</RowAction>}
            />
          </>
        )}
      </SettingsGroup>
      {switching && (
        <SwitchDialog
          onClose={() => setSwitching(false)}
          onConfirm={() => {
            setSwitching(false);
            void switchServer();
          }}
        />
      )}
      {keying && local !== undefined && (
        <ApiKeyDialog local={local} onClose={() => setKeying(false)} />
      )}
    </>
  );
}
