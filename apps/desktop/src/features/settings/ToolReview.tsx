import {
  ApiError,
  type Connector,
  type ConnectorToolEvent,
  type ConnectorToolReview,
} from "@suup/api";
import { History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { cx } from "../../lib/cx.js";
import {
  type Cell,
  CHANGED_AGAIN,
  changeSummary,
  compareDefinitions,
  EVENT_LABEL,
  type Section,
} from "../../lib/tool-review.js";
import {
  Dialog,
  FieldError,
  FormStack,
  MutedText,
  Notice,
  Pill,
  Tag,
} from "../../ui/primitives.js";
import { formatWhen } from "./formatting.js";
import { RowAction, SettingsFold, SettingsGroup, SettingsHint, SettingsRow } from "./parts.js";
import { useTask } from "./use-task.js";

// The review of a definition: what the server showed when you approved it next to what it shows now.
// Differences are marked by a sign in front of the line and by bold underlined words, never by colour
// alone, and the whole comparison says it is text written by the connector's server.

/** A cell of the comparison; the description is prose, the rest is code. */
const cellClass = (side: "left" | "right", prose: boolean, mark?: Cell["mark"]): string =>
  cx(
    "flex min-w-0 gap-2 px-3 py-1 wrap-anywhere whitespace-pre-wrap",
    prose ? "font-sans text-small" : "font-mono text-code",
    side === "right" && "border-l border-border",
    mark === "removed" && "bg-danger-subtle",
    mark === "added" && "bg-success-subtle",
  );

function CellView({
  cell,
  side,
  prose,
}: {
  cell: Cell | null;
  side: "left" | "right";
  prose: boolean;
}) {
  if (cell === null) return <div className={cellClass(side, prose)} aria-hidden="true" />;
  const sign = cell.mark === "removed" ? "−" : cell.mark === "added" ? "+" : " ";
  const spoken =
    cell.mark === "removed" ? "Linha removida: " : cell.mark === "added" ? "Linha nova: " : "";
  return (
    <div className={cellClass(side, prose, cell.mark)} data-side={side} data-mark={cell.mark}>
      <span className="w-[1ch] flex-none text-text-muted" aria-hidden="true">
        {sign}
      </span>
      <span>
        {spoken !== "" && <span className="sr-only">{spoken}</span>}
        {cell.parts === undefined
          ? cell.text
          : cell.parts.map((part, i) =>
              part.changed ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the words never reorder
                <strong key={i} className="diff-word font-bold underline">
                  {part.text}
                </strong>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: the words never reorder
                <span key={i}>{part.text}</span>
              ),
            )}
      </span>
    </div>
  );
}

function SectionView({ section, isNew }: { section: Section; isNew: boolean }) {
  return (
    <div className="flex flex-col gap-1" data-testid="review-section" data-section={section.id}>
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="m-0 text-section font-label tracking-section text-text-muted uppercase">
          {section.title}
        </h4>
        <MutedText data-testid="review-changes">
          {isNew ? "tudo é novo" : changeSummary(section)}
        </MutedText>
      </div>
      <div
        className="flex min-w-0 flex-col overflow-hidden rounded-inner border border-border"
        role="group"
        aria-label={`${section.title}: antes e agora`}
      >
        {section.rows.map((row, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
            key={i}
            className={cx("grid min-w-0 grid-cols-2", i > 0 && "border-t border-border")}
          >
            <CellView cell={row.left} side="left" prose={section.id === "description"} />
            <CellView cell={row.right} side="right" prose={section.id === "description"} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ReviewItem({
  connector,
  review,
  note,
  onApproved,
  onChangedAgain,
}: {
  connector: Connector;
  review: ConnectorToolReview;
  note: string | undefined;
  onApproved(tool: string): void;
  onChangedAgain(tool: string): void;
}) {
  const { sync, api } = useServices();
  const task = useTask();
  // "Keep it off" belongs to the definition the person is looking at: it is stored WITH that
  // definition's fingerprint, so a new fingerprint is simply not kept. (An effect that reset a
  // boolean on every new fingerprint also ran after the first render and could undo a click made
  // right after the item appeared.)
  const [keptFingerprint, setKeptFingerprint] = useState<string | undefined>(undefined);
  const kept = keptFingerprint === review.currentFingerprint;
  const setKept = (value: boolean) =>
    setKeptFingerprint(value ? review.currentFingerprint : undefined);
  const sections = compareDefinitions(review);
  const isNew = review.status === "new";

  const approve = () =>
    task.run(async () => {
      let again = false;
      const result = await sync.connectorCall(async () => {
        try {
          // The fingerprint is the one of the definition on screen: if the server changed it
          // meanwhile, it refuses, and nothing the person did not read is approved.
          return await api.connectors.approveTool(connector.name, review.tool, {
            fingerprint: review.currentFingerprint,
          });
        } catch (error) {
          if (error instanceof ApiError && error.code === "conflict") again = true;
          throw error;
        }
      });
      if (result.ok) {
        onApproved(review.tool);
        return { ok: true };
      }
      if (again) {
        onChangedAgain(review.tool);
        return { ok: true };
      }
      return { ok: false, message: result.message };
    });

  return (
    <ReviewFrame
      title={review.tool}
      status={isNew ? "nova" : "mudou"}
      testTool={review.tool}
      kept={kept}
      onReopen={() => setKept(false)}
    >
      {!kept && (
        <>
          <Notice role="note" data-testid="review-server-text">
            <strong>Texto escrito pelo servidor</strong>
            Descrição e esquema abaixo vêm do servidor do conector, não do Suup. Leia o que mudou
            antes de aprovar.
          </Notice>
          <div
            className="grid grid-cols-2 gap-2 pl-[calc(var(--space-4)+var(--space-1))] text-label leading-inherit font-label"
            aria-hidden="true"
          >
            <span>
              Antes <span className="text-text-muted">(o que você aprovou)</span>
            </span>
            <span>
              Agora <span className="text-text-muted">(o que o servidor mostra)</span>
            </span>
          </div>
          {isNew && (
            <MutedText as="p" data-testid="review-new">
              Ferramenta nova: nada foi aprovado antes, então o lado esquerdo está vazio.
            </MutedText>
          )}
          {sections.map((section) => (
            <SectionView key={section.id} section={section} isNew={isNew} />
          ))}
          {note !== undefined && <FieldError data-testid="review-again">{note}</FieldError>}
          {task.error !== undefined && <FieldError>{task.error}</FieldError>}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Pill
              tone="ghost"
              disabled={task.busy}
              data-testid="review-keep"
              onClick={() => setKept(true)}
            >
              Manter desligada
            </Pill>
            <Pill
              tone="primary"
              disabled={task.busy}
              data-testid="review-approve"
              onClick={() => void approve()}
            >
              {task.busy ? "Aprovando…" : "Aprovar esta definição"}
            </Pill>
          </div>
        </>
      )}
    </ReviewFrame>
  );
}

/** The frame of one tool under review: a title with its status, and the comparison below. */
function ReviewFrame({
  title,
  status,
  testTool,
  kept,
  onReopen,
  children,
}: {
  title: string;
  status: string;
  testTool: string;
  kept: boolean;
  onReopen(): void;
  children: React.ReactNode;
}) {
  return (
    <section
      className="flex flex-col gap-3 rounded-row border border-border p-4"
      data-testid="review-item"
      data-tool={testTool}
      aria-label={`Revisão de ${title}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="m-0 text-title font-title">
          {title} <Tag tone="outline">{status}</Tag>
        </h3>
        {kept && (
          <MutedText data-testid="review-kept">
            Mantida desligada. Nada foi enviado ao servidor.{" "}
            <button
              type="button"
              className="cursor-pointer border-0 bg-transparent p-0 text-inherit underline [font:inherit]"
              onClick={onReopen}
            >
              Rever
            </button>
          </MutedText>
        )}
      </div>
      {children}
    </section>
  );
}

/** The surface where the definitions that changed (or are new) are read and, one by one, approved. */
export function ReviewDialog({ connector, onClose }: { connector: Connector; onClose(): void }) {
  const { sync, api } = useServices();
  const [items, setItems] = useState<ConnectorToolReview[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setItems(await api.connectors.review(connector.name));
      setError(undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Não foi possível carregar a revisão.");
    }
  }, [api, connector.name]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Dialog
      wide
      title={`Revisar as ferramentas de ${connector.name}`}
      onClose={onClose}
      footer={
        <Pill tone="primary" onClick={onClose} data-testid="review-close">
          Fechar
        </Pill>
      }
    >
      <FormStack data-testid="review-dialog">
        <MutedText as="p">
          Uma ferramenta cuja definição mudou, ou que é nova, fica desligada para todos os bots até
          você aprovar. Aprovar vale só para a definição que está na tela.
        </MutedText>
        {error !== undefined && <FieldError>{error}</FieldError>}
        {items === undefined ? (
          <MutedText as="p">Carregando…</MutedText>
        ) : items.length === 0 ? (
          <p data-testid="review-empty" role="status">
            Nada mais para revisar neste conector.
          </p>
        ) : (
          items.map((review) => (
            <ReviewItem
              key={review.tool}
              connector={connector}
              review={review}
              note={notes[review.tool]}
              onApproved={(tool) => {
                setNotes(({ [tool]: _gone, ...rest }) => rest);
                void load();
                void sync.loadConnectors();
              }}
              onChangedAgain={(tool) => {
                setNotes((n) => ({ ...n, [tool]: CHANGED_AGAIN }));
                void load();
                void sync.loadConnectors();
              }}
            />
          ))
        )}
      </FormStack>
    </Dialog>
  );
}

// -------------------------------------------------------------------- history

const EVENTS_SHOWN = 12;

/** The latest events of the connector's tool definitions: pinned, changed, new, restored, approved. */
export function ToolHistory({ connector }: { connector: Connector }) {
  const { api } = useServices();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ConnectorToolEvent[] | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  // Reads again when the connector's definitions move (a review, a new listing).
  const stamp = `${connector.updatedAt}:${connector.pendingReviews}`;
  useEffect(() => {
    if (!open) return;
    let current = true;
    api.connectors.events(connector.name).then(
      (items) => {
        if (current) {
          setEvents(items);
          setError(undefined);
        }
      },
      (e: unknown) => {
        if (current) setError(e instanceof Error ? e.message : "Não foi possível ler o histórico.");
      },
    );
    return () => {
      current = false;
    };
  }, [open, api, connector.name, stamp]);

  const recent = [...(events ?? [])]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, EVENTS_SHOWN);
  return (
    <div className="contents" data-testid="tool-history">
      <SettingsGroup label="Histórico" icon={History}>
        <SettingsRow
          testId="tool-history-card"
          title="Histórico das ferramentas"
          description="Mudanças de definição e aprovações"
          control={
            <RowAction aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? "Fechar" : "Ver"}
            </RowAction>
          }
        />
        {open && (
          <SettingsFold>
            {error !== undefined && <FieldError>{error}</FieldError>}
            {events === undefined && error === undefined ? (
              <SettingsHint>Carregando…</SettingsHint>
            ) : recent.length === 0 ? (
              <SettingsHint>Nada registrado ainda.</SettingsHint>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="tool-history-list">
                {recent.map((e) => (
                  <li
                    key={e.id}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-2"
                    data-kind={e.kind}
                  >
                    <MutedText>{formatWhen(e.createdAt)}</MutedText>
                    <span>
                      {EVENT_LABEL[e.kind]}
                      {e.tool !== null && (
                        <>
                          {": "}
                          <code>{e.tool}</code>
                        </>
                      )}
                    </span>
                    {e.detail !== null && e.detail !== "" && (
                      <MutedText className="wrap-anywhere whitespace-pre-wrap">
                        {e.detail}
                      </MutedText>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </SettingsFold>
        )}
      </SettingsGroup>
    </div>
  );
}
