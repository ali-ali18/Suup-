import type { ApprovalRule, WrittenRule } from "@suup/api";
import type { ReactNode } from "react";
import {
  type ActionItem,
  blockedRuleText,
  callStateLabel,
  waitedText,
} from "../../data/actions.js";
import { type RuleContext, ruleSentence, STATUS_DETAIL } from "../../data/approval-text.js";
import { diffLines } from "../../lib/diff.js";
import { ActionCard, ActionLabel, ActionPre, DiffLine } from "../../ui/action-card.js";
import { ArgsView } from "../../ui/args-view.js";
import { categoryGlyph } from "../../ui/category-icon.js";

/** What the row of a call with an approval needs from the app, besides the call itself. */
export interface CallContext {
  botName?: string;
  /** The rule an "always allow" of the approval created, when it is known. */
  rule?: ApprovalRule | undefined;
  connectors?: RuleContext["connectors"];
  /** The written rule that refused the call, when it is loaded (its text is the row's). */
  writtenRule?: WrittenRule | undefined;
  /** Long content is collapsed with a button to show it all. */
  collapseLong?: boolean;
}

/** What a failed call says in the chat, instead of the tool's raw error. */
export const FAILED_TEXT =
  "Não deu certo. O bot recebeu o aviso e seguiu; o detalhe fica no Inspetor.";

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** What the details of an action say, as plain text: the command and its output, the path and the diff... */
export function ActionDetail({ item, context = {} }: { item: ActionItem; context?: CallContext }) {
  const { args, approval } = item;
  // A call that never ran has no result to show.
  const output = item.state === "stopped" ? undefined : item.output;
  const blocks: ReactNode[] = [];
  const label = (text: string, key: string) => <ActionLabel key={key}>{text}</ActionLabel>;
  const pre = (text: string, key: string, error = false) => (
    <ActionPre key={key} error={error}>
      {text}
    </ActionPre>
  );
  const oldText = str(args.old_string);
  const newText = str(args.new_string);
  if (approval !== undefined) {
    // What was approved: the exact content, as the card showed it (a secret stays its placeholder).
    const decided = approval.decidedAt === null ? undefined : new Date(approval.decidedAt);
    blocks.push(
      <ActionLabel key="approval" data-testid="approval-detail">
        {approval.stale && approval.waitedMs !== null
          ? `Você aprovou depois de ${waitedText(approval.waitedMs)}: a ação não rodou na hora. O bot foi avisado, conferiu se ainda fazia sentido e só então seguiu.`
          : (STATUS_DETAIL[approval.status] ?? "")}
        {decided !== undefined &&
          ` Decidido às ${decided.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`}
      </ActionLabel>,
    );
    if (approval.status === "denied" && approval.reason !== null && approval.reason !== "") {
      blocks.push(
        <ActionLabel key="denial" data-testid="approval-denial">
          Motivo da recusa: <span className="wrap-anywhere text-text">{approval.reason}</span>
        </ActionLabel>,
      );
    }
    blocks.push(
      <ArgsView
        key="approved"
        args={approval.args}
        collapse={context.collapseLong ?? true}
        testId="approval-content"
      />,
    );
    if (approval.ruleId !== null) {
      blocks.push(
        <ActionLabel key="rule" data-testid="approval-rule">
          {context.rule === undefined
            ? "Criou uma regra para este destinatário."
            : `Criou a regra: ${ruleSentence(context.rule, {
                botName: context.botName,
                ...(context.connectors === undefined ? {} : { connectors: context.connectors }),
              })}`}
        </ActionLabel>,
      );
    }
  } else if (item.blocked !== undefined) {
    blocks.push(
      <ActionLabel key="blocked" data-testid="action-blocked-detail">
        Não rodou: uma regra que você escreveu proíbe isto (“
        {blockedRuleText(item.blocked, context.writtenRule)}”). O bot recebeu o aviso e seguiu.
      </ActionLabel>,
    );
  } else if (item.allowedByRule === true) {
    blocks.push(
      <ActionLabel key="allowed" data-testid="action-rule-allowed">
        Permitido por uma regra sua: rodou sem pedir aprovação.
      </ActionLabel>,
    );
  }
  if (approval !== undefined) {
    // The exact content is already shown above.
  } else if (item.name === "shell" && str(args.command) !== undefined) {
    blocks.push(pre(`$ ${str(args.command)}`, "cmd"));
  } else if (item.name === "edit_file" && oldText !== undefined && newText !== undefined) {
    blocks.push(label(str(args.path) ?? "Arquivo", "path"));
    blocks.push(
      <ActionPre key="diff" data-testid="diff">
        {diffLines(oldText, newText).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a diff have no identity
          <DiffLine key={`${i}-${line.kind}`} kind={line.kind}>
            {line.kind === "removed" ? "- " : line.kind === "added" ? "+ " : "  "}
            {line.text}
            {"\n"}
          </DiffLine>
        ))}
      </ActionPre>,
    );
  } else if (item.kind === "files") {
    const where = str(args.path) ?? str(args.pattern);
    if (where !== undefined) blocks.push(pre(where, "where"));
  } else if (item.kind === "web" && str(args.url) !== undefined) {
    blocks.push(label("Endereço", "url"));
    blocks.push(pre(str(args.url) as string, "urltext"));
  } else if (item.kind === "memory") {
    const what = str(args.text) ?? str(args.query) ?? str(args.id);
    if (what !== undefined) blocks.push(pre(what, "what"));
  } else if (Object.keys(args).length > 0) {
    blocks.push(pre(JSON.stringify(args, null, 2), "args"));
  }
  if (item.state === "failed") {
    // Never the tool's raw error in the chat (docs/DESIGN.md §1 "Amigável"): it may be English, an
    // envelope of external data, a stack. One plain sentence; the detail stays in the Inspector.
    blocks.push(
      <ActionLabel key="failed" data-testid="action-failed">
        {FAILED_TEXT}
      </ActionLabel>,
    );
  } else if (output !== undefined && output !== "") {
    const limit = item.kind === "web" ? 1500 : undefined;
    const shown =
      limit !== undefined && output.length > limit ? `${output.slice(0, limit)}…` : output;
    blocks.push(label(item.kind === "web" ? "Trecho" : "Resultado", "out-label"));
    blocks.push(
      <ActionPre key="out" data-testid="action-output">
        {shown}
        {item.truncated ? "\n(saída cortada)" : ""}
      </ActionPre>,
    );
  }
  if (blocks.length === 0)
    blocks.push(label(item.state === "running" ? "Em andamento…" : "Sem detalhes.", "none"));
  return <>{blocks}</>;
}

/** One action of the bot as a card: collapsed to a row, expanded in place on click. */
export function ActionRow({
  item,
  expanded,
  onToggle,
  context,
}: {
  item: ActionItem;
  expanded: boolean;
  onToggle(): void;
  context?: CallContext;
}) {
  const stateLabel = callStateLabel(item);
  return (
    <ActionCard
      icon={categoryGlyph(item.icon)}
      kind={item.kindLabel}
      state={item.state}
      summary={
        item.blocked === undefined
          ? item.summary
          : blockedRuleText(item.blocked, context?.writtenRule)
      }
      {...(stateLabel === undefined ? {} : { stateLabel })}
      expanded={expanded}
      onToggle={onToggle}
    >
      <ActionDetail item={item} {...(context === undefined ? {} : { context })} />
    </ActionCard>
  );
}
