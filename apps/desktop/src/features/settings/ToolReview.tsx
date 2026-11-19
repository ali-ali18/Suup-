import {
  ApiError,
  type Connector,
  type ConnectorToolEvent,
  type ConnectorToolReview,
} from "@suup/api";
import { History } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import {
  type Cell,
  CHANGED_AGAIN,
  changeSummary,
  compareDefinitions,
  EVENT_LABEL,
  type Section,
} from "../../lib/tool-review.js";
import { Dialog, Pill, Tag } from "../../ui/primitives.js";
import { formatWhen } from "./formatting.js";
import { RowAction, SettingsGroup, SettingsRow } from "./parts.js";
import { useTask } from "./use-task.js";

// The review of a definition: what the server showed when you approved it next to what it shows now.
// Differences are marked by a sign in front of the line and by bold underlined words, never by colour
// alone, and the whole comparison says it is text written by the connector's server.

function CellView({ cell, side }: { cell: Cell | null; side: "left" | "right" }) {
  if (cell === null) return <div className="diff-cell diff-cell--empty" aria-hidden="true" />;
  const sign = cell.mark === "removed" ? "−" : cell.mark === "added" ? "+" : " ";
  const spoken =
    cell.mark === "removed" ? "Linha removida: " : cell.mark === "added" ? "Linha nova: " : "";
  return (
    <div className={`diff-cell diff-cell--${cell.mark}`} data-side={side} data-mark={cell.mark}>
      <span className="diff-cell__sign" aria-hidden="true">
        {sign}
      </span>
      <span className="diff-cell__text">
        {spoken !== "" && <span className="sr-only">{spoken}</span>}
        {cell.parts === undefined
          ? cell.text
          : cell.parts.map((part, i) =>
              part.changed ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: the words never reorder
                <strong key={i} className="diff-word">
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
    <div className="diff-section" data-testid="review-section" data-section={section.id}>
      <div className="diff-section__head">
        <h4 className="diff-section__title">{section.title}</h4>
        <span className="muted small" data-testid="review-changes">
          {isNew ? "tudo é novo" : changeSummary(section)}
        </span>
      </div>
      <div className="diff-grid" role="group" aria-label={`${section.title}: antes e agora`}>
        {section.rows.map((row, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          <div key={i} className="diff-row">
            <CellView cell={row.left} side="left" />
            <CellView cell={row.right} side="right" />
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
          <p className="ui-notice" role="note" data-testid="review-server-text">
            <strong>Texto escrito pelo servidor</strong>
            Descrição e esquema abaixo vêm do servidor do conector, não do Suup. Leia o que mudou
            antes de aprovar.
          </p>
          <div className="diff-heads" aria-hidden="true">
            <span>
              Antes <span className="muted">(o que você aprovou)</span>
            </span>
            <span>
              Agora <span className="muted">(o que o servidor mostra)</span>
            </span>
          </div>
          {isNew && (
            <p className="muted small" data-testid="review-new">
              Ferramenta nova: nada foi aprovado antes, então o lado esquerdo está vazio.
            </p>
          )}
          {sections.map((section) => (
            <SectionView key={section.id} section={section} isNew={isNew} />
          ))}
          {note !== undefined && (
            <p className="ui-field__error" role="alert" data-testid="review-again">
              {note}
            </p>
          )}
          {task.error !== undefined && (
            <p className="ui-field__error" role="alert">
              {task.error}
            </p>
          )}
          <div className="grant-footer">
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
      className="review-item"
      data-testid="review-item"
      data-tool={testTool}
      aria-label={`Revisão de ${title}`}
    >
      <div className="row-between">
        <h3 className="review-item__title">
          {title} <Tag tone="outline">{status}</Tag>
        </h3>
        {kept && (
          <span className="muted small" data-testid="review-kept">
            Mantida desligada. Nada foi enviado ao servidor.{" "}
            <button type="button" className="link-button" onClick={onReopen}>
              Rever
            </button>
          </span>
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
      <div className="review" data-testid="review-dialog">
        <p className="muted small">
          Uma ferramenta cuja definição mudou, ou que é nova, fica desligada para todos os bots até
          você aprovar. Aprovar vale só para a definição que está na tela.
        </p>
        {error !== undefined && (
          <p className="ui-field__error" role="alert">
            {error}
          </p>
        )}
        {items === undefined ? (
          <p className="muted">Carregando…</p>
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
      </div>
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
    <div className="sroot" data-testid="tool-history">
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
          <div className="sfold">
            {error !== undefined && (
              <p className="ui-field__error" role="alert">
                {error}
              </p>
            )}
            {events === undefined && error === undefined ? (
              <p className="sgroup__hint">Carregando…</p>
            ) : recent.length === 0 ? (
              <p className="sgroup__hint">Nada registrado ainda.</p>
            ) : (
              <ul className="history-list" data-testid="tool-history-list">
                {recent.map((e) => (
                  <li key={e.id} className="history-row" data-kind={e.kind}>
                    <span className="muted small">{formatWhen(e.createdAt)}</span>
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
                      <span className="muted small wrap">{e.detail}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
