import { Brain, FileText, Globe, SquareTerminal, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import type { ActionItem } from "../../data/actions.js";
import { diffLines } from "../../lib/diff.js";
import { ActionCard } from "../../ui/action-card.js";

const ICON: Record<ActionItem["kind"], ReactNode> = {
  terminal: <SquareTerminal size={16} />,
  files: <FileText size={16} />,
  web: <Globe size={16} />,
  memory: <Brain size={16} />,
  other: <Wrench size={16} />,
};

const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** What the details of an action say, as plain text: the command and its output, the path and the diff... */
export function ActionDetail({ item }: { item: ActionItem }) {
  const { args, output } = item;
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
  if (item.name === "shell" && str(args.command) !== undefined) {
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
}: {
  item: ActionItem;
  expanded: boolean;
  onToggle(): void;
}) {
  return (
    <ActionCard
      icon={ICON[item.kind]}
      kind={item.kindLabel}
      state={item.state}
      summary={item.summary}
      expanded={expanded}
      onToggle={onToggle}
    >
      <ActionDetail item={item} />
    </ActionCard>
  );
}
