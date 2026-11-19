import { KeyRound, LoaderCircle, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { SecretRequestState } from "../data/secret-requests.js";
import type { SecretOutcome } from "../lib/secret-form.js";
import { ActionCard } from "./action-card.js";
import { DecisionCard } from "./decision-card.js";
import { Pill } from "./primitives.js";
import { userIsTyping } from "./question-card.js";
import { SecretInput, type SecretInputHandle } from "./secret-input.js";

export interface SecretRequestCardProps {
  name: string;
  /** What the bot said it is for. */
  reason: string | null;
  botName: string;
  state: SecretRequestState;
  /** Sends the value, straight to the vault. The card keeps no copy of it. */
  onSubmit(value: string): Promise<SecretOutcome<unknown>>;
  onDecline(): Promise<SecretOutcome<unknown>>;
  autoFocus?: boolean;
  expanded: boolean;
  onToggle(): void;
}

const LINE: Record<Exclude<SecretRequestState, "open">, (name: string) => string> = {
  provided: (name) => `Segredo ${name} disponível`,
  declined: (name) => `Você recusou o segredo ${name}`,
  closed: (name) => `Pedido do segredo ${name} encerrado`,
};

/**
 * The secure form: the bot asked for a credential. A password field (hidden, with a button to
 * reveal it), Enviar (waits for something typed) and Agora não. The value is read from the field once, sent to the vault through
 * the answer endpoint, and the field is cleared at once; it is never in the app's state, in a
 * message, or in an error. Answered, the card is one line that says only "segredo NOME disponível".
 */
export function SecretRequestCard(props: SecretRequestCardProps) {
  return props.state === "open" ? <OpenForm {...props} /> : <Answered {...props} />;
}

function OpenForm({
  name,
  reason,
  botName,
  onSubmit,
  onDecline,
  autoFocus,
}: SecretRequestCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const field = useRef<SecretInputHandle>(null);
  const [busy, setBusy] = useState<"save" | "decline" | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  // Only whether the field is empty (a boolean from its change event), never what is in it.
  const [empty, setEmpty] = useState(true);
  const [done, setDone] = useState<"provided" | "declined" | undefined>(undefined);

  // The form appears: the focus goes to the field (the person was asked for exactly this), unless
  // they are typing something else.
  useEffect(() => {
    if (autoFocus === true && !userIsTyping()) field.current?.focus();
  }, [autoFocus]);

  const save = async () => {
    const value = field.current?.take() ?? "";
    if (value === "") return;
    // Gone from the field before anything else happens: from here the value only travels.
    field.current?.clear();
    setBusy("save");
    setError(undefined);
    const outcome = await onSubmit(value);
    setBusy(null);
    if (outcome.ok) setDone("provided");
    else setError(outcome.message);
  };
  const decline = async () => {
    field.current?.clear();
    setBusy("decline");
    setError(undefined);
    const outcome = await onDecline();
    setBusy(null);
    if (outcome.ok) setDone("declined");
    else setError(outcome.message);
  };

  if (done !== undefined) {
    // Confirmed by the server: the run goes on by itself, and the log will say the same.
    return (
      <ActionCard
        testId="secret-card"
        icon={<KeyRound size={14} />}
        kind="Segredos"
        state={done === "provided" ? "done" : "stopped"}
        stateLabel=""
        summary={LINE[done](name)}
        expanded={false}
        onToggle={() => {}}
      />
    );
  }
  const waiting = busy !== null;
  return (
    <DecisionCard
      testId="secret-card"
      rootRef={root}
      groupLabel={`Pedido de segredo de ${botName}: ${name}`}
      busy={waiting}
      icon={<KeyRound size={14} />}
      category="Segredos"
      title={`${botName} pede um segredo`}
      lede={
        reason === null || reason === ""
          ? "O valor vai direto para o cofre. O bot só fica sabendo que o segredo está disponível."
          : `Motivo dado pelo bot: ${reason}`
      }
      footerNote={
        <span className="ui-decision__assure">
          <ShieldCheck size={14} aria-hidden="true" />
          Guardado no cofre; o bot nunca vê o valor.
        </span>
      }
      footer={
        <>
          <Pill
            tone="ghost"
            className="ui-decision__deny"
            disabled={waiting}
            data-testid="secret-decline"
            onClick={() => void decline()}
          >
            {busy === "decline" ? (
              <>
                <LoaderCircle size={16} className="ui-spin" aria-hidden="true" />
                Recusando…
              </>
            ) : (
              "Agora não"
            )}
          </Pill>
          <Pill
            tone="primary"
            className="ui-split__main"
            disabled={waiting || empty}
            data-testid="secret-save"
            onClick={() => void save()}
          >
            {busy === "save" ? (
              <>
                <LoaderCircle size={16} className="ui-spin" aria-hidden="true" />
                Enviando…
              </>
            ) : (
              "Enviar"
            )}
          </Pill>
        </>
      }
    >
      <form
        className="secret-form"
        data-testid="secret-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <SecretInput
          ref={field}
          label={name}
          disabled={waiting}
          error={error}
          onEmptyChange={setEmpty}
          onEnter={() => void save()}
        />
      </form>
    </DecisionCard>
  );
}

function Answered({ name, reason, state, expanded, onToggle }: SecretRequestCardProps) {
  if (state === "open") return null;
  return (
    <ActionCard
      testId="secret-card"
      icon={<KeyRound size={14} />}
      kind="Segredos"
      state={state === "provided" ? "done" : "stopped"}
      stateLabel=""
      summary={LINE[state](name)}
      expanded={expanded}
      onToggle={onToggle}
    >
      <p className="ui-action__label">
        {state === "provided"
          ? `O bot recebeu só o aviso de que ${name} está disponível. O valor está cifrado no cofre e não aparece em lugar nenhum.`
          : state === "declined"
            ? "Você recusou, e o bot seguiu sem o segredo."
            : "A execução terminou sem que o segredo fosse respondido."}
        {reason !== null && reason !== "" && ` Motivo dado pelo bot: ${reason}`}
      </p>
    </ActionCard>
  );
}
