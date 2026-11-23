import { useState } from "react";
import type { Connection } from "../../lib/platform.js";
import { FieldError, Pill, TextField } from "../../ui/primitives.js";
import { WelcomeCard } from "../../ui/welcome.js";

/** First open: server address and token, checked against the server before anything is kept. */
export function ConnectScreen({
  initial,
  error,
  busy,
  onSubmit,
  onBack,
}: {
  initial: Connection | null;
  error: string | undefined;
  busy: boolean;
  onSubmit(serverUrl: string, token: string): void;
  /** Back to the first-run choice (only offered where there is one). */
  onBack?: () => void;
}) {
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? "http://127.0.0.1:8787");
  const [token, setToken] = useState(initial?.token ?? "");
  const ready = serverUrl.trim() !== "" && token.trim() !== "" && !busy;
  const submit = () => ready && onSubmit(serverUrl, token);
  return (
    <WelcomeCard
      title="Conectar ao Suup"
      subtitle="Informe o endereço do servidor e o token de acesso."
      onSubmit={submit}
    >
      <TextField
        label="Endereço do servidor"
        name="server"
        value={serverUrl}
        onChange={setServerUrl}
        type="url"
        placeholder="http://127.0.0.1:8787"
        autoFocus
      />
      <TextField
        label="Token"
        name="token"
        type="password"
        value={token}
        onChange={setToken}
        hint="O token que você configurou no servidor; fica guardado no chaveiro do sistema."
      />
      {error !== undefined && <FieldError data-testid="connect-error">{error}</FieldError>}
      <Pill tone="primary" type="submit" disabled={!ready}>
        {busy ? "Conectando…" : "Conectar"}
      </Pill>
      {onBack !== undefined && (
        <Pill tone="quiet" onClick={onBack} disabled={busy} data-testid="connect-back">
          Voltar
        </Pill>
      )}
    </WelcomeCard>
  );
}
