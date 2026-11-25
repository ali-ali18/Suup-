import { useEffect, useRef, useState } from "react";
import type { Connection } from "../../lib/platform.js";
import { CONNECT_THINK_MS, STAGE_SURPRISED_MS } from "../../lib/welcome.js";
import { FieldError, Pill, TextField } from "../../ui/primitives.js";
import { StageForm } from "../../ui/welcome.js";
import { useStageStatus } from "../welcome/Stage.js";

type Step = "address" | "token";

/**
 * Connecting, one step at a time (owner, 24/11/2026): first the address, and the bot thinks while
 * the app checks that a Suup server answers there; then the token, the same way, until it is
 * accepted. Nothing is kept before the server says yes. The arrow goes back one step (from the
 * address, to what came before: `onBack`).
 */
export function ConnectScreen({
  initial,
  error,
  busy,
  onCheckAddress,
  onSubmit,
  onBack,
  leaving,
}: {
  initial: Connection | null;
  error: string | undefined;
  busy: boolean;
  /** Checks that a Suup server answers at this address: `undefined` when it does, else the friendly reason. */
  onCheckAddress(serverUrl: string): Promise<string | undefined>;
  onSubmit(serverUrl: string, token: string): void;
  /** Back from the first step (to the first-run choice, or to the welcome). */
  onBack?: () => void;
  /** The connection went through: the screen fades out before the next one comes. */
  leaving?: boolean;
}) {
  const [step, setStep] = useState<Step>("address");
  const [serverUrl, setServerUrl] = useState(initial?.serverUrl ?? "http://127.0.0.1:8787");
  const [token, setToken] = useState(initial?.token ?? "");
  const [checking, setChecking] = useState(false);
  const [addressError, setAddressError] = useState<string | undefined>(undefined);
  const alive = useRef(true);
  // Set on every mount: React's development mode mounts twice, and a flag only cleared on unmount
  // stayed false for good (the first step hung on "Conferindo…").
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // The address was confirmed: the bot's eyes go wide for a moment (owner, 24/11/2026).
  const [confirmed, setConfirmed] = useState(false);
  // The next step starting ends the wide eyes at once.
  useEffect(() => {
    if (busy) setConfirmed(false);
  }, [busy]);
  useEffect(() => {
    if (!confirmed) return;
    const timer = setTimeout(() => setConfirmed(false), STAGE_SURPRISED_MS);
    return () => clearTimeout(timer);
  }, [confirmed]);

  const thinking = checking || busy;
  const shownError = step === "address" ? addressError : error;
  // The stage's bot ponders while a step is checked and is sorry when it did not go through.
  useStageStatus(
    thinking ? "busy" : confirmed ? "confirmed" : shownError !== undefined ? "error" : "idle",
  );

  const checkAddress = async () => {
    if (serverUrl.trim() === "" || thinking) return;
    setChecking(true);
    setAddressError(undefined);
    // The bot takes a moment to think even when the server answers at once.
    const [problem] = await Promise.all([
      onCheckAddress(serverUrl),
      new Promise((done) => setTimeout(done, CONNECT_THINK_MS)),
    ]);
    if (!alive.current) return;
    setChecking(false);
    if (problem === undefined) {
      setConfirmed(true);
      setStep("token");
    } else setAddressError(problem);
  };

  const back = step === "token" ? () => setStep("address") : onBack;

  if (step === "address") {
    return (
      <StageForm
        key="address"
        title="Conectar ao Suup"
        subtitle="Primeiro, o endereço do seu servidor."
        onSubmit={() => void checkAddress()}
        onBack={back}
        backDisabled={thinking}
        leaving={leaving === true}
        testId="connect-address"
      >
        <TextField
          label="Endereço do servidor"
          name="server"
          raised
          value={serverUrl}
          onChange={(value) => {
            setServerUrl(value);
            setAddressError(undefined);
          }}
          type="url"
          placeholder="http://127.0.0.1:8787"
          autoFocus
        />
        {addressError !== undefined && (
          <FieldError data-testid="connect-error">{addressError}</FieldError>
        )}
        <Pill
          tone="primary"
          type="submit"
          disabled={serverUrl.trim() === "" || thinking}
          data-testid="connect-next"
        >
          {checking ? "Conferindo…" : "Continuar"}
        </Pill>
      </StageForm>
    );
  }

  const ready = token.trim() !== "" && !thinking;
  return (
    <StageForm
      key="token"
      title="Agora, o token de acesso"
      subtitle="O token que você configurou no servidor; ele fica guardado no chaveiro do sistema."
      onSubmit={() => ready && onSubmit(serverUrl, token)}
      onBack={back}
      backDisabled={thinking}
      leaving={leaving === true}
      testId="connect-token"
    >
      <TextField
        label="Token"
        name="token"
        raised
        type="password"
        value={token}
        onChange={setToken}
        autoFocus
      />
      {error !== undefined && <FieldError data-testid="connect-error">{error}</FieldError>}
      <Pill tone="primary" type="submit" disabled={!ready} data-testid="connect-submit">
        {busy ? "Conectando…" : "Conectar"}
      </Pill>
    </StageForm>
  );
}
