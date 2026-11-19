import type { Approval, ApprovalRule, DecideApprovalBody } from "@suup/api";
import { ChevronDown, LoaderCircle } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  allowRecipientSentence,
  approvalTitle,
  expiryText,
  instructionLine,
  LEVEL_HINT,
  LEVEL_LABEL,
  NETWORK_SCOPE_NOTE,
  networkLede,
  networkRequestOf,
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
  /** Long content is collapsed with a button to show it all. */
  collapseLong?: boolean;
  /** Take the focus when the card appears (unless the person is typing). */
  autoFocus?: boolean;
  /** The decision, sent to the server. The card changes only when the store says so. */
  onDecide(body: DecideApprovalBody): Promise<DecideOutcome>;
  /** Called when the server says the card was already decided elsewhere. */
  onDecidedElsewhere?(approval: Approval | undefined): void;
  /** "Gerenciar regras" (message cards only): opens Configurações > Aprovações. No item when it is missing. */
  onManageRules?(): void;
  now?: () => number;
}

type Busy = "approve" | "allow" | "deny";

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
 * card: category, a bold title, one muted paragraph, the exact content as quiet rows. The footer
 * depends only on what the call DECLARES:
 *  - a normal action (files, terminal, memory, web, connector tools): plain text "Recusar" and a
 *    primary pill "Aprovar". Nothing else: no menu, no standing rule from the card;
 *  - a message to another person (`approval.outbound`): "Descartar" and a split button "Enviar"
 *    whose menu is about the recipient (Permitir destinatário, Precisa de aprovação, Gerenciar
 *    regras). This is the only place the split button exists.
 * Decided, it is one line (Aprovado, Recusado, Expirou, Cancelado) that opens on click. Nothing here
 * is optimistic: while a decision is on its way every button waits, and the card changes when the
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
  collapseLong = true,
  autoFocus,
  onDecide,
  onDecidedElsewhere,
  onManageRules,
  now = clock,
}: ApprovalCardProps) {
  const root = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  // Message cards only: "Precisa de aprovação" is on until the person turns it off; then Enviar
  // also allows this recipient.
  const [needsApproval, setNeedsApproval] = useState(true);
  const current = useNow(approval.expiresAt !== null, now);
  const ref = parseConnectorTool(approval.tool, connectors);
  const outbound = approval.outbound;
  const category = toolCategory(approval.tool, connectors, outbound !== null);
  const title = approvalTitle(approval.tool, approval.args, approval.summary, connectors);
  // A request to reach one more host: the bot's reason in its own words, and how far "Aprovar" goes.
  const network = networkRequestOf(approval.tool, approval.args);

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

  const waiting = busy !== null;
  const approving = busy === "approve" || busy === "allow";
  const recipients = outbound?.recipients ?? null;
  const note = (): ReactNode => {
    if (error !== undefined) {
      return (
        <span className="ui-field__error" role="alert" data-testid="approval-error">
          {error}
        </span>
      );
    }
    if (outbound !== null && !needsApproval && recipients !== null) {
      return (
        <span data-testid="allow-recipient-sentence" aria-live="polite">
          {allowRecipientSentence({ botName, tool: approval.tool, recipients, connectors })}
        </span>
      );
    }
    if (network !== null) {
      return (
        <span data-testid="network-scope">
          {NETWORK_SCOPE_NOTE}
          {approval.expiresAt !== null && ` ${expiryText(approval.expiresAt, current)}.`}
        </span>
      );
    }
    if (approval.expiresAt !== null) {
      return <span data-testid="approval-expiry">{expiryText(approval.expiresAt, current)}.</span>;
    }
    return null;
  };
  const verb = outbound === null ? "Aprovar" : "Enviar";
  const denyLabel = outbound === null ? "Recusar" : "Descartar";

  const denyButton = (
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
          {outbound === null ? "Recusando…" : "Descartando…"}
        </>
      ) : (
        denyLabel
      )}
    </Pill>
  );

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
      lede={
        network === null
          ? `${instructionLine(botName, approval.tool, ref?.connector ?? null)} Está perguntando porque ${SOURCE_REASON[approval.source]}.`
          : networkLede(botName, network.reason)
      }
      ledeTestId="approval-why"
      footerNote={note()}
      footer={
        outbound === null ? (
          <>
            {denyButton}
            <Pill
              tone="primary"
              className="ui-decision__primary"
              disabled={waiting}
              data-testid="approval-approve"
              onClick={() => void send("approve", { decision: "approve" })}
            >
              {approving ? (
                <>
                  <LoaderCircle size={16} className="ui-spin" aria-hidden="true" />
                  Aprovando…
                </>
              ) : (
                verb
              )}
            </Pill>
          </>
        ) : (
          <MessageFooter
            recipients={recipients}
            busy={busy}
            deny={denyButton}
            needsApproval={needsApproval}
            onNeedsApproval={setNeedsApproval}
            send={send}
            onManageRules={onManageRules}
          />
        )
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

/**
 * The footer of a message to another person: Descartar, and the split button Enviar whose menu is
 * about the recipient. The ONLY place a split button is drawn (`design-rules.test.ts` checks it).
 * "Permitir destinatário" sends and creates an allow rule for exactly this recipient, for this bot;
 * it is offered only when the recipient can be said exactly (one text value per recipient field).
 */
function MessageFooter({
  recipients,
  busy,
  deny,
  needsApproval,
  onNeedsApproval,
  send,
  onManageRules,
}: {
  recipients: { field: string; value: string }[] | null;
  busy: Busy | null;
  deny: ReactNode;
  needsApproval: boolean;
  onNeedsApproval(next: boolean): void;
  send(kind: Busy, body: DecideApprovalBody): Promise<void>;
  onManageRules?: (() => void) | undefined;
}) {
  const waiting = busy !== null;
  const approving = busy === "approve" || busy === "allow";
  const canAllow = recipients !== null;
  const items: MenuItem[] = [
    {
      id: "allow-recipient",
      testId: "allow-recipient",
      label: "Permitir destinatário",
      description: canAllow
        ? "Envia e libera este destinatário, neste bot."
        : "Indisponível: não há um único destinatário em texto.",
      disabled: !canAllow,
      onSelect: () => void send("allow", { decision: "approve", allowRecipient: true }),
    },
    {
      id: "needs-approval",
      testId: "approval-needs",
      label: "Precisa de aprovação",
      description: needsApproval
        ? "Pergunta de novo na próxima vez."
        : "Enviar passa a liberar este destinatário também.",
      checked: needsApproval,
      disabled: !canAllow,
      onSelect: () => onNeedsApproval(!needsApproval),
    },
  ];
  if (onManageRules !== undefined) {
    items.push({
      id: "manage-rules",
      testId: "approval-manage-rules",
      label: "Gerenciar regras",
      onSelect: onManageRules,
    });
  }
  const allowing = !needsApproval && canAllow;
  return (
    <>
      {deny}
      <div className="ui-split">
        <Pill
          tone="primary"
          className="ui-split__main"
          disabled={waiting}
          data-testid="approval-approve"
          onClick={() =>
            void send(
              allowing ? "allow" : "approve",
              allowing ? { decision: "approve", allowRecipient: true } : { decision: "approve" },
            )
          }
        >
          {approving ? (
            <>
              <LoaderCircle size={16} className="ui-spin" aria-hidden="true" />
              Enviando…
            </>
          ) : allowing ? (
            "Enviar e permitir"
          ) : (
            "Enviar"
          )}
        </Pill>
        <MenuButton
          label="Mais opções de envio"
          items={items}
          placement="above"
          trigger={(props) => (
            <button
              type="button"
              className="ui-pill ui-pill--primary ui-split__more"
              aria-label="Mais opções de envio"
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
  const category = toolCategory(approval.tool, connectors, approval.outbound !== null);
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
            ? "Criou uma regra para este destinatário."
            : `Criou a regra: ${ruleSentence(rule, { botName, connectors })}`}
        </p>
      )}
    </ActionCard>
  );
}
