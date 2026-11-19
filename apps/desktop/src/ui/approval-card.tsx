import type { Approval, ApprovalRule, DecideApprovalBody } from "@suup/api";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type AlwaysMatch,
  type AlwaysScope,
  alwaysSentence,
  approvalTitle,
  expiryText,
  instructionLine,
  LEVEL_HINT,
  LEVEL_LABEL,
  parseConnectorTool,
  ruleSentence,
  SOURCE_REASON,
  STATUS_DETAIL,
  STATUS_LABEL,
  toolCategory,
  toolTitle,
} from "../data/approval-text.js";
import type { DecideOutcome } from "../data/sync.js";
import { focusOnAppearance } from "../lib/focus.js";
import { ActionCard } from "./action-card.js";
import { ArgRow, ArgsView } from "./args-view.js";
import { categoryGlyph } from "./category-icon.js";
import { DecisionCard } from "./decision-card.js";
import { MenuButton, type MenuItem } from "./menu.js";
import { Pill } from "./primitives.js";
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
  /** "Gerenciar regras": opens Configurações > Aprovações. No item when it is missing. */
  onManageRules?(): void;
  now?: () => number;
}

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
 * The approval card of the chat and of the Pendências screen. Waiting for you it is a calm bordered
 * card: category, a bold title, one muted paragraph, the exact content as quiet rows, and on the
 * right Recusar (one click, no reason) and a split button Aprovar whose menu has "Sempre permitir"
 * (this bot or all, exactly this or any use), "Precisa de aprovação" and "Gerenciar regras". Decided,
 * it is one line (Aprovado, Recusado, Expirou, Cancelado) that opens on click. Nothing here is
 * optimistic: while a decision is on its way every button waits, and the card changes when the
 * server answers.
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
  onManageRules,
  now = clock,
}: ApprovalCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  // "Precisa de aprovação" is on until the person turns it off: then Aprovar also makes the rule.
  const [needsApproval, setNeedsApproval] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const current = useNow(approval.expiresAt !== null, now);
  const ref = parseConnectorTool(approval.tool, connectors);
  const category = toolCategory(approval.tool, connectors);
  const title = approvalTitle(approval.tool, approval.args, approval.summary, connectors);
  const tool = toolTitle(approval.tool, connectors);

  // The card appears: take the focus on the card itself (not on a button, so a stray Enter cannot
  // decide), unless the person is in the middle of typing something.
  useEffect(() => {
    if (autoFocus === true && !userIsTyping()) focusOnAppearance(root.current);
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

  const always = (scope: AlwaysScope, match: AlwaysMatch): DecideApprovalBody => ({
    decision: "approve",
    always: { scope, ...(match === "any" ? { matchers: [] } : {}) },
  });

  const waiting = busy !== null;
  const approving = busy === "approve" || busy === "always";
  const items: MenuItem[] = [];
  for (const scope of defaultScope === "bot"
    ? (["bot", "global"] as const)
    : (["global", "bot"] as const)) {
    for (const match of ["exact", "any"] as const) {
      items.push({
        id: `always-${scope}-${match}`,
        testId: `always-${scope}-${match}`,
        label: `Sempre permitir ${match === "exact" ? "isto" : "esta ferramenta"}, ${scope === "bot" ? "neste bot" : "em todos os bots"}`,
        description:
          match === "exact"
            ? "Só quando o conteúdo for idêntico a este."
            : `Qualquer uso de ${tool}, com quaisquer argumentos.`,
        onSelect: () => void send("always", always(scope, match)),
      });
    }
  }
  items.push({
    id: "needs-approval",
    testId: "approval-needs",
    label: "Precisa de aprovação",
    description: needsApproval
      ? "Pergunta de novo na próxima vez."
      : "Aprovar passa a criar uma regra também.",
    checked: needsApproval,
    onSelect: () => setNeedsApproval(!needsApproval),
  });
  if (onManageRules !== undefined) {
    items.push({
      id: "manage-rules",
      testId: "approval-manage-rules",
      label: "Gerenciar regras",
      onSelect: onManageRules,
    });
  }

  const note = (): ReactNode => {
    if (error !== undefined) {
      return (
        <span className="ui-field__error" role="alert" data-testid="approval-error">
          {error}
        </span>
      );
    }
    if (!needsApproval) {
      return (
        <span data-testid="always-sentence" aria-live="polite">
          {alwaysSentence({
            scope: defaultScope,
            match: "exact",
            botName,
            tool: approval.tool,
            args: approval.args,
            connectors,
          })}
        </span>
      );
    }
    if (approval.expiresAt !== null) {
      return <span data-testid="approval-expiry">{expiryText(approval.expiresAt, current)}.</span>;
    }
    return null;
  };

  return (
    <DecisionCard
      testId="approval-card"
      rootRef={root}
      groupLabel={`Pedido de aprovação de ${botName}: ${title}`}
      busy={waiting}
      icon={categoryGlyph(category.icon)}
      category={category.label}
      aside={
        <span
          data-testid="approval-risk"
          data-level={approval.level}
          title={LEVEL_HINT[approval.level]}
        >
          <span className="sr-only">Risco: </span>
          {LEVEL_LABEL[approval.level]}
        </span>
      }
      title={title}
      lede={`${instructionLine(botName, approval.tool, ref?.connector ?? null)} Está perguntando porque ${SOURCE_REASON[approval.source]}.`}
      ledeTestId="approval-why"
      footerNote={note()}
      footer={
        <>
          <Pill
            tone="ghost"
            className="ui-decision__deny"
            disabled={waiting}
            data-testid="approval-deny"
            onClick={() => void send("deny", { decision: "deny" })}
          >
            {busy === "deny" ? (
              <>
                <LoaderCircle size={16} className="ui-spin" aria-hidden="true" />
                Recusando…
              </>
            ) : (
              "Recusar"
            )}
          </Pill>
          <div className="ui-split">
            <Pill
              tone="primary"
              className="ui-split__main"
              disabled={waiting}
              data-testid="approval-approve"
              onClick={() =>
                void send(
                  needsApproval ? "approve" : "always",
                  needsApproval ? { decision: "approve" } : always(defaultScope, "exact"),
                )
              }
            >
              {approving ? (
                <>
                  <LoaderCircle size={16} className="ui-spin" aria-hidden="true" />
                  Aprovando…
                </>
              ) : needsApproval ? (
                "Aprovar"
              ) : (
                "Aprovar e permitir"
              )}
            </Pill>
            <MenuButton
              label="Mais opções de aprovação"
              items={items}
              placement="above"
              trigger={(props) => (
                <button
                  type="button"
                  className="ui-pill ui-pill--primary ui-split__more"
                  aria-label="Mais opções de aprovação"
                  disabled={waiting}
                  data-testid="approval-more"
                  {...props}
                >
                  <ChevronDown size={16} aria-hidden="true" />
                </button>
              )}
            />
          </div>
        </>
      }
    >
      <ArgsView args={approval.args} collapse={collapseLong} testId="approval-content">
        {ref !== null && (
          <>
            <ArgRow label="Conector" testId="approval-connector">
              {ref.connector}
            </ArgRow>
            {ref.tool !== "" && <ArgRow label="Ferramenta">{ref.tool}</ArgRow>}
          </>
        )}
      </ArgsView>
    </DecisionCard>
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
  const category = toolCategory(approval.tool, connectors);
  const state = approval.status === "approved" ? "done" : "stopped";
  const decided = approval.decidedAt === null ? undefined : new Date(approval.decidedAt);
  const title = approvalTitle(approval.tool, approval.args, approval.summary, connectors);
  return (
    <ActionCard
      testId="approval-card"
      icon={categoryGlyph(category.icon)}
      kind={category.label}
      state={state}
      stateLabel={STATUS_LABEL[approval.status] ?? approval.status}
      summary={title}
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
          Motivo da recusa: <span className="ui-approval__quote">{approval.reason}</span>
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
