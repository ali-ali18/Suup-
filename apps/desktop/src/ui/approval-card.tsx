import type { Approval, ApprovalRule, DecideApprovalBody } from "@suup/api";
import { Ban, Clock, LoaderCircle, ShieldCheck, ShieldQuestion, ShieldX } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  type AlwaysMatch,
  type AlwaysScope,
  alwaysSentence,
  expiryText,
  instructionLine,
  LEVEL_LABEL,
  parseConnectorTool,
  ruleSentence,
  SOURCE_REASON,
  STATUS_DETAIL,
  STATUS_LABEL,
  toolTitle,
} from "../data/approval-text.js";
import type { DecideOutcome } from "../data/sync.js";
import { ActionCard } from "./action-card.js";
import { ArgsView } from "./args-view.js";
import { Pill, Tag } from "./primitives.js";
import { userIsTyping } from "./question-card.js";

type ConnectorRefs = readonly {
  name: string;
  tools?: readonly { name: string; tool: string }[] | null;
}[];

export interface ApprovalCardProps {
  approval: Approval;
  botName: string;
  connectors?: ConnectorRefs;
  /** The rule an "always allow" of this card created, when it is known (to say what it does). */
  rule?: ApprovalRule | undefined;
  expanded: boolean;
  onToggle(): void;
  /** What the settings propose for "always allow": this bot, or every bot. */
  defaultScope?: AlwaysScope;
  /** Long content is collapsed with a button to show it all. */
  collapseLong?: boolean;
  /** Take the focus when the card appears (unless the person is typing). */
  autoFocus?: boolean;
  /** The decision, sent to the server. The card changes only when the store says so. */
  onDecide(body: DecideApprovalBody): Promise<DecideOutcome>;
  /** Called when the server says the card was already decided elsewhere. */
  onDecidedElsewhere?(approval: Approval | undefined): void;
  now?: () => number;
}

const RESOLVED_ICON = {
  approved: ShieldCheck,
  denied: ShieldX,
  cancelled: Ban,
  expired: Clock,
  pending: ShieldQuestion,
} as const;

type Busy = "approve" | "always" | "deny";

/** Re-reads the clock while a card that expires is on screen. */
function useNow(active: boolean, now: () => number): number {
  const [value, setValue] = useState(now());
  useEffect(() => {
    if (!active) return;
    setValue(now());
    const timer = setInterval(() => setValue(now()), 15_000);
    return () => clearInterval(timer);
  }, [active, now]);
  return value;
}

const clock = () => Date.now();

/**
 * The approval card of the chat and of the Pendências screen. Waiting for you it shows the exact
 * content that will run, why it asked, and the buttons underneath: Negar (with an optional reason),
 * Aprovar e sempre permitir (with the scope, and what the rule will match), Aprovar. Decided, it is
 * one line (approved, denied, expired, cancelled) that opens on click. Nothing here is optimistic:
 * while a decision is on its way every button waits, and the card changes when the server answers.
 */
export function ApprovalCard(props: ApprovalCardProps) {
  return props.approval.status === "pending" ? (
    <PendingCard {...props} />
  ) : (
    <ResolvedCard {...props} />
  );
}

function PendingCard({
  approval,
  botName,
  connectors = [],
  defaultScope = "bot",
  collapseLong = true,
  autoFocus,
  onDecide,
  onDecidedElsewhere,
  now = clock,
}: ApprovalCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const alwaysId = useId();
  const [busy, setBusy] = useState<Busy | null>(null);
  const [alwaysOpen, setAlwaysOpen] = useState(false);
  const [scope, setScope] = useState<AlwaysScope>(defaultScope);
  const [match, setMatch] = useState<AlwaysMatch>("exact");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const current = useNow(approval.expiresAt !== null, now);
  const ref = parseConnectorTool(approval.tool, connectors);

  // The card appears: take the focus on the card itself (not on a button, so a stray Enter cannot
  // decide), unless the person is in the middle of typing something.
  useEffect(() => {
    if (autoFocus === true && !userIsTyping()) root.current?.focus();
  }, [autoFocus]);

  const send = async (kind: Busy, body: DecideApprovalBody) => {
    setBusy(kind);
    setError(undefined);
    const outcome = await onDecide(body);
    if (!outcome.ok) {
      if (outcome.reason === "decided_elsewhere") onDecidedElsewhere?.(outcome.approval);
      else if (outcome.reason === "error") setError(outcome.message);
    }
    setBusy(null);
  };

  const waiting = busy !== null;
  const label = (kind: Busy, idle: string, doing: string) =>
    busy === kind ? (
      <>
        <LoaderCircle size={16} className="ui-spin" aria-hidden="true" />
        {doing}
      </>
    ) : (
      idle
    );

  return (
    <ActionCard
      testId="approval-card"
      rootRef={root}
      groupLabel={`Pedido de aprovação de ${botName}: ${approval.summary}`}
      busy={waiting}
      icon={<ShieldQuestion size={16} />}
      kind={`Aprovação · ${toolTitle(approval.tool, connectors)}`}
      state="needs-action"
      summary={approval.summary}
      expanded
      onToggle={() => {}}
      needsAction={{
        title: approval.summary,
        instruction: instructionLine(botName, approval.tool, ref?.connector ?? null),
        header: (
          <Tag tone={approval.level === "external_irreversible" ? "danger" : "outline"}>
            {LEVEL_LABEL[approval.level]}
          </Tag>
        ),
        preview: (
          <div className="ui-approval__content" data-testid="approval-content">
            {ref !== null && (
              <p className="ui-action__label" data-testid="approval-connector">
                Conector <strong>{ref.connector}</strong>
                {ref.tool !== "" && (
                  <>
                    {" "}
                    · ferramenta <strong>{ref.tool}</strong>
                  </>
                )}
              </p>
            )}
            <ArgsView args={approval.args} collapse={collapseLong} />
            <p className="ui-action__label" data-testid="approval-why">
              Está perguntando porque {SOURCE_REASON[approval.source]}.
              {approval.expiresAt !== null && (
                <span data-testid="approval-expiry">
                  {" "}
                  {expiryText(approval.expiresAt, current)}.
                </span>
              )}
            </p>
          </div>
        ),
        extra: (
          <div className="ui-approval__extra">
            {alwaysOpen && (
              <div
                className="ui-approval__always"
                data-testid="approval-always"
                role="group"
                aria-labelledby={alwaysId}
              >
                <p className="ui-action__label" id={alwaysId}>
                  Aprovar e sempre permitir
                </p>
                <div className="ui-approval__choices" role="radiogroup" aria-label="Vale para">
                  <Pill
                    tone={scope === "bot" ? "primary" : "secondary"}
                    role="radio"
                    aria-checked={scope === "bot"}
                    data-testid="always-scope-bot"
                    disabled={waiting}
                    onClick={() => setScope("bot")}
                  >
                    Este bot
                  </Pill>
                  <Pill
                    tone={scope === "global" ? "primary" : "secondary"}
                    role="radio"
                    aria-checked={scope === "global"}
                    data-testid="always-scope-global"
                    disabled={waiting}
                    onClick={() => setScope("global")}
                  >
                    Todos os bots
                  </Pill>
                </div>
                <div className="ui-approval__choices" role="radiogroup" aria-label="Vale quando">
                  <Pill
                    tone={match === "exact" ? "primary" : "secondary"}
                    role="radio"
                    aria-checked={match === "exact"}
                    data-testid="always-match-exact"
                    disabled={waiting}
                    onClick={() => setMatch("exact")}
                  >
                    Exatamente isto
                  </Pill>
                  <Pill
                    tone={match === "any" ? "primary" : "secondary"}
                    role="radio"
                    aria-checked={match === "any"}
                    data-testid="always-match-any"
                    disabled={waiting}
                    onClick={() => setMatch("any")}
                  >
                    Qualquer uso desta ferramenta
                  </Pill>
                </div>
                <p className="ui-action__label" data-testid="always-sentence" aria-live="polite">
                  {alwaysSentence({
                    scope,
                    match,
                    botName,
                    tool: approval.tool,
                    args: approval.args,
                    connectors,
                  })}
                </p>
                <div className="ui-approval__confirm">
                  <Pill tone="secondary" disabled={waiting} onClick={() => setAlwaysOpen(false)}>
                    Voltar
                  </Pill>
                  <Pill
                    tone="primary"
                    disabled={waiting}
                    data-testid="approval-always-confirm"
                    onClick={() =>
                      void send("always", {
                        decision: "approve",
                        always: { scope, ...(match === "any" ? { matchers: [] } : {}) },
                      })
                    }
                  >
                    {label("always", "Aprovar e sempre permitir", "Aprovando…")}
                  </Pill>
                </div>
              </div>
            )}
            <div className="ui-approval__reason">
              <label className="ui-action__label" htmlFor={reasonId}>
                Motivo, se for negar (opcional; o bot lê)
              </label>
              <input
                id={reasonId}
                className="ui-field__control"
                value={reason}
                maxLength={2000}
                disabled={waiting}
                autoComplete="off"
                data-testid="approval-reason"
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            {error !== undefined && (
              <p className="ui-field__error" role="alert" data-testid="approval-error">
                {error}
              </p>
            )}
          </div>
        ),
        actions: (
          <>
            <Pill
              tone="secondary"
              disabled={waiting}
              data-testid="approval-deny"
              onClick={() =>
                void send("deny", {
                  decision: "deny",
                  ...(reason.trim() === "" ? {} : { reason: reason.trim() }),
                })
              }
            >
              {label("deny", "Negar", "Negando…")}
            </Pill>
            <Pill
              tone="secondary"
              disabled={waiting}
              aria-expanded={alwaysOpen}
              data-testid="approval-always-toggle"
              onClick={() => {
                setScope(defaultScope);
                setAlwaysOpen(!alwaysOpen);
              }}
            >
              Aprovar e sempre permitir…
            </Pill>
            <Pill
              tone="primary"
              disabled={waiting}
              data-testid="approval-approve"
              onClick={() => void send("approve", { decision: "approve" })}
            >
              {label("approve", "Aprovar", "Aprovando…")}
            </Pill>
          </>
        ),
      }}
    />
  );
}

function ResolvedCard({
  approval,
  botName,
  connectors = [],
  rule,
  expanded,
  onToggle,
  collapseLong = true,
}: ApprovalCardProps) {
  const Icon = RESOLVED_ICON[approval.status];
  const state = approval.status === "approved" ? "done" : "stopped";
  const decided = approval.decidedAt === null ? undefined : new Date(approval.decidedAt);
  return (
    <ActionCard
      testId="approval-card"
      icon={<Icon size={16} />}
      kind="Aprovação"
      state={state}
      stateLabel={STATUS_LABEL[approval.status] ?? approval.status}
      summary={approval.summary}
      expanded={expanded}
      onToggle={onToggle}
    >
      <p className="ui-action__label" data-testid="approval-detail">
        {toolTitle(approval.tool, connectors)} · {botName}. {STATUS_DETAIL[approval.status] ?? ""}
        {decided !== undefined &&
          ` Decidido às ${decided.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`}
      </p>
      {approval.status === "denied" && approval.reason !== null && approval.reason !== "" && (
        <p className="ui-action__label" data-testid="approval-denial">
          Motivo da negação: <span className="ui-approval__quote">{approval.reason}</span>
        </p>
      )}
      <ArgsView args={approval.args} collapse={collapseLong} />
      {approval.ruleId !== null && (
        <p className="ui-action__label" data-testid="approval-rule">
          {rule === undefined
            ? "Criou uma regra “sempre permitir”."
            : `Criou a regra: ${ruleSentence(rule, { botName, connectors })}`}
        </p>
      )}
    </ActionCard>
  );
}
