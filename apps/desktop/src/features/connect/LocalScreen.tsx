import { useEffect, useRef, useState } from "react";
import { friendlyError } from "../../lib/friendly-error.js";
import type { LocalServer, LocalStatus } from "../../lib/platform.js";
import { FieldError, MutedText, Notice, Pill } from "../../ui/primitives.js";
import { SecretInput, type SecretInputHandle } from "../../ui/secret-input.js";
import { WelcomeCard } from "../../ui/welcome.js";
import { STAGE_TEXT } from "./local-text.js";

/**
 * "Usar neste computador": first the model provider's key (once, in a password field that is never
 * shown back), then the calm "Iniciando…" while the app starts its own database and server, or the
 * reason it could not.
 */
export function LocalScreen({
  local,
  askKey,
  connectError,
  onReady,
  onSwitch,
}: {
  local: LocalServer;
  /** First run: the key step comes first (it can be skipped). */
  askKey: boolean;
  /** Set when the server was running but the app could not connect to it: no automatic retry. */
  connectError?: string | undefined;
  /** The server answers: the app connects. Called once on its own, again by "Tentar de novo". */
  onReady(): void;
  /** Back to the first-run choice. */
  onSwitch(): void;
}) {
  const [step, setStep] = useState<"key" | "start">(askKey ? "key" : "start");
  const [status, setStatus] = useState<LocalStatus | undefined>(undefined);
  const [keyError, setKeyError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [empty, setEmpty] = useState(true);
  const field = useRef<SecretInputHandle>(null);
  const announced = useRef(connectError !== undefined);
  const selected = useRef(false);

  useEffect(() => {
    if (step !== "start") return;
    let off: (() => void) | undefined;
    let gone = false;
    void (async () => {
      if (askKey && !selected.current) {
        selected.current = true;
        await local.select();
      }
      off = await local.onStatus(setStatus);
      const now = await local.status();
      if (!gone) setStatus(now);
      if (gone) off();
    })().catch((e: unknown) => setKeyError(friendlyError(e)));
    return () => {
      gone = true;
      off?.();
    };
  }, [step, askKey, local]);

  useEffect(() => {
    if (status?.state === "ready" && !announced.current) {
      announced.current = true;
      onReady();
    }
  }, [status, onReady]);

  const saveKey = async () => {
    const key = (field.current?.take() ?? "").trim();
    if (key === "") return;
    setSaving(true);
    setKeyError(undefined);
    try {
      await local.setApiKey(key);
      field.current?.clear();
      setStep("start");
    } catch (e) {
      setKeyError("Não deu para guardar a chave. Tenta de novo?");
      friendlyError(e);
    } finally {
      setSaving(false);
    }
  };

  if (step === "key") {
    return (
      <WelcomeCard
        title="A chave do modelo"
        subtitle="Digite a chave da Anthropic uma vez; ela fica guardada no chaveiro do sistema."
        onSubmit={() => void saveKey()}
        testId="local-key"
      >
        <SecretInput
          label="Chave da Anthropic"
          ref={field}
          autoFocus
          disabled={saving}
          onEmptyChange={setEmpty}
          error={keyError}
          hint="Cole aqui, nunca numa conversa. Dá para trocar depois em Configurações."
          testId="api-key-input"
        />
        <Pill tone="primary" type="submit" disabled={empty || saving}>
          {saving ? "Guardando…" : "Guardar e continuar"}
        </Pill>
        <Pill
          tone="quiet"
          onClick={() => setStep("start")}
          disabled={saving}
          data-testid="key-later"
        >
          Fazer depois
        </Pill>
        <Pill tone="quiet" onClick={onSwitch} disabled={saving}>
          Voltar
        </Pill>
      </WelcomeCard>
    );
  }

  if (connectError !== undefined) {
    return (
      <WelcomeCard title="O Suup não conseguiu conectar" testId="local-start">
        <FieldError data-testid="connect-error">{connectError}</FieldError>
        <Pill tone="primary" onClick={onReady}>
          Tentar de novo
        </Pill>
        <Pill tone="quiet" onClick={onSwitch}>
          Escolher outro servidor
        </Pill>
      </WelcomeCard>
    );
  }
  const failed = status?.state === "failed";
  const restarting = status?.state === "restarting";
  return (
    <WelcomeCard
      title={failed ? "O Suup não conseguiu iniciar" : "Iniciando o Suup…"}
      subtitle={
        failed ? undefined : "O banco de dados e o servidor estão subindo neste computador."
      }
      testId="local-start"
    >
      {!failed && (
        <MutedText as="p" role="status" data-testid="local-stage">
          {status?.stage != null ? STAGE_TEXT[status.stage] : "Começando…"}
        </MutedText>
      )}
      {restarting && (
        <Notice role="status" data-testid="local-restarting">
          {/* The reason is a log line (the supervisor's words): the logs keep it. */}O Suup parou e
          vai tentar de novo
          {status.restartInSeconds === null ? "" : ` em ${status.restartInSeconds} s`}.
        </Notice>
      )}
      {failed && (
        <>
          {/* The reason is a log line, never parsed: one friendly sentence, the logs have the rest. */}
          <FieldError data-testid="local-error">
            Algo impediu o Suup de iniciar neste computador. Tenta de novo?
          </FieldError>
          <Pill tone="primary" onClick={() => void local.start()} data-testid="local-retry">
            Tentar de novo
          </Pill>
          <Pill tone="secondary" onClick={() => void local.openLogs()} data-testid="local-logs">
            Abrir a pasta de registros
          </Pill>
        </>
      )}
      <Pill tone="quiet" onClick={onSwitch} data-testid="local-switch">
        Escolher outro servidor
      </Pill>
    </WelcomeCard>
  );
}
