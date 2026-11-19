import type { ApprovalRule } from "@suup/api";
import type { ReactNode } from "react";
import { type ActionItem, callStateLabel } from "../../data/actions.js";
import { type RuleContext, ruleSentence, STATUS_DETAIL } from "../../data/approval-text.js";
import { diffLines } from "../../lib/diff.js";
import { ActionCard } from "../../ui/action-card.js";
import { ArgsView } from "../../ui/args-view.js";
import { categoryGlyph } from "../../ui/category-icon.js";

/** What the row of a call with an approval needs from the app, besides the call itself. */
export interface CallContext {
  botName?: string;
  /** The rule an "always allow" of the approval created, when it is known. */
  rule?: ApprovalRule | undefined;
  connectors?: RuleContext["connectors"];
  /** Long content is collapsed with a button to show it all. */
  collapseLong?: boolean;
}

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** What the details of an action say, as plain text: the command and its output, the path and the diff... */
export function ActionDetail({ item, context = {} }: { item: ActionItem; context?: CallContext }) {
  const { args, approval } = item;
  // A call that never ran has no result to show.
  const output = item.state === "stopped" ? undefined : item.output;
  const blocks: ReactNode[] = [];
  const label = (text: string, key: string) => (
    <p key={key} className="ui-action__label">
      {text}
    </p>
  );
  const pre = (text: string, key: string, error = false) => (
    <pre key={key} className={`ui-action__pre${error ? " ui-action__pre--error" : ""}`}>
      {text}
    </pre>
  );
  const oldText = str(args.old_string);
  const newText = str(args.new_string);
  if (approval !== undefined) {
    // What was approved: the exact content, as the card showed it (a secret stays its placeholder).
    const decided = approval.decidedAt === null ? undefined : new Date(approval.decidedAt);
    blocks.push(
      <p key="approval" className="ui-action__label" data-testid="approval-detail">
        {STATUS_DETAIL[approval.status] ?? ""}
        {decided !== undefined &&
          ` Decidido às ${decided.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`}
      </p>,
    );
    if (approval.status === "denied" && approval.reason !== null && approval.reason !== "") {
      blocks.push(
        <p key="denial" className="ui-action__label" data-testid="approval-denial">
          Motivo da recusa: <span className="ui-approval__quote">{approval.reason}</span>
        </p>,
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
        <p key="rule" className="ui-action__label" data-testid="approval-rule">
          {context.rule === undefined
            ? "Criou uma regra “sempre permitir”."
            : `Criou a regra: ${ruleSentence(context.rule, {
                botName: context.botName,
                ...(context.connectors === undefined ? {} : { connectors: context.connectors }),
              })}`}
        </p>,
      );
    }
  } else if (item.allowedByRule === true) {
    blocks.push(
      <p key="allowed" className="ui-action__label" data-testid="action-rule-allowed">
        Permitido por uma regra sua: rodou sem pedir aprovação.
      </p>,
    );
  }
  if (approval !== undefined) {
    // The exact content is already shown above.
  } else if (item.name === "shell" && str(args.command) !== undefined) {
    blocks.push(pre(`$ ${str(args.command)}`, "cmd"));
  } else if (item.name === "edit_file" && oldText !== undefined && newText !== undefined) {
    blocks.push(label(str(args.path) ?? "Arquivo", "path"));
    blocks.push(
      <pre key="diff" className="ui-action__pre" data-testid="diff">
        {diffLines(oldText, newText).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the lines of a diff have no identity
          <span key={`${i}-${line.kind}`} className={`ui-action__line--${line.kind}`}>
            {line.kind === "removed" ? "- " : line.kind === "added" ? "+ " : "  "}
            {line.text}
            {"\n"}
          </span>
        ))}
      </pre>,
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
  if (output !== undefined && output !== "") {
    const limit = item.kind === "web" ? 1500 : undefined;
    const shown =
      limit !== undefined && output.length > limit ? `${output.slice(0, limit)}…` : output;
    blocks.push(
      label(
        item.state === "failed" ? "Erro" : item.kind === "web" ? "Trecho" : "Resultado",
        "out-label",
      ),
    );
    blocks.push(
      <pre
        key="out"
        className={`ui-action__pre${item.state === "failed" ? " ui-action__pre--error" : ""}`}
        data-testid="action-output"
      >
        {shown}
        {item.truncated ? "\n(saída cortada)" : ""}
      </pre>,
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
      summary={item.summary}
      {...(stateLabel === undefined ? {} : { stateLabel })}
      expanded={expanded}
      onToggle={onToggle}
    >
      <ActionDetail item={item} {...(context === undefined ? {} : { context })} />
    </ActionCard>
  );
}
