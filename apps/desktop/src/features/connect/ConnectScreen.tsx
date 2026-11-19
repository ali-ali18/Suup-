import { useState } from "react";
import type { Connection } from "../../lib/platform.js";
import { Avatar } from "../../ui/avatar.js";
import { Pill, TextField } from "../../ui/primitives.js";

/** First open: server address and token, checked against the server before anything is kept. */
export function ConnectScreen({
  initial,
  error,
  busy,
  onSubmit,
}: {
  initial: Connection | null;
  error: string | undefined;
  busy: boolean;
  onSubmit(serverUrl: string, token: string): void;
}) {
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? "http://127.0.0.1:8787");
  const [token, setToken] = useState(initial?.token ?? "");
  const ready = serverUrl.trim() !== "" && token.trim() !== "" && !busy;
  const submit = () => ready && onSubmit(serverUrl, token);
  return (
    <main className="connect">
      <form
        className="connect__card"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="connect__brand">
          <Avatar avatar="mascot:blob" seed="suup" size="lg" />
          <h1 className="connect__title">Conectar ao Suup</h1>
          <p className="muted small">Informe o endereço do servidor e o token de acesso.</p>
        </div>
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
          hint="O mesmo valor de SUUP_SERVER_TOKEN. No app de desktop ele fica guardado no chaveiro do sistema."
        />
        {error !== undefined && (
          <p className="connect__error" role="alert" data-testid="connect-error">
            {error}
          </p>
        )}
        <Pill tone="primary" type="submit" disabled={!ready}>
          {busy ? "Conectando…" : "Conectar"}
        </Pill>
      </form>
    </main>
  );
}
