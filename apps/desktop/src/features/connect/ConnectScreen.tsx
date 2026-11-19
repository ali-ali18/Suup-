import { useState } from "react";
import type { Connection } from "../../lib/platform.js";
import { Avatar } from "../../ui/avatar.js";
import { FieldError, MutedText, Pill, TextField } from "../../ui/primitives.js";

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
    <main className="flex min-h-full items-center justify-center overflow-auto p-6">
      <form
        className="flex w-connect flex-col gap-4 rounded-card border border-border bg-surface p-8"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <Avatar avatar="mascot:blob" seed="suup" size="lg" />
          <h1 className="text-heading font-bold">Conectar ao Suup</h1>
          <MutedText as="p">Informe o endereço do servidor e o token de acesso.</MutedText>
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
        {error !== undefined && <FieldError data-testid="connect-error">{error}</FieldError>}
        <Pill tone="primary" type="submit" disabled={!ready}>
          {busy ? "Conectando…" : "Conectar"}
        </Pill>
      </form>
    </main>
  );
}
