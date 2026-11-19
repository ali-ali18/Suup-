import type { Bot, Connector } from "@suup/api";
import { Bot as BotIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { LEVEL_LABEL } from "../../data/approval-text.js";
import { RISK_BASIS_TEXT } from "../../lib/connector-form.js";
import {
  BLOCKED_TEXT,
  blockedCount,
  countLabel,
  draftOf,
  type GrantableTool,
  type GrantDraft,
  grantableTools,
  grantBody,
  isDirty,
  isTicked,
  selectAll,
  selectNone,
  selectReadOnly,
  toggleTool,
} from "../../lib/tool-grants.js";
import { ActionCard } from "../../ui/action-card.js";
import { Pill } from "../../ui/primitives.js";
import { useTask } from "./use-task.js";

/** One bot of the connector: a collapsed row ("Nova · 3 de 14") that opens the ticks of its tools. */
function BotGrant({
  bot,
  connector,
  list,
  onReview,
}: {
  bot: Bot;
  connector: Connector;
  list: readonly GrantableTool[];
  onReview(): void;
}) {
  const { sync, api } = useServices();
  const task = useTask();
  const saved = useMemo(
    () => draftOf(connector.grants.find((g) => g.botId === bot.id)),
    [connector.grants, bot.id],
  );
  const [draft, setDraft] = useState<GrantDraft>(saved);
  const [open, setOpen] = useState(false);
  const dirty = isDirty(draft, saved);
  // What the server holds changed (a save, another window): follow it, unless the person is editing.
  // Adjusted while rendering, not in an effect: an effect also ran after the first render and could
  // undo an edit made right after the card appeared.
  const savedKey = JSON.stringify(saved);
  const [shownKey, setShownKey] = useState(savedKey);
  if (shownKey !== savedKey) {
    setShownKey(savedKey);
    setDraft(saved);
  }

  const save = () =>
    task.run(async () => {
      const result = await sync.connectorCall(() =>
        api.connectors.grant(connector.name, bot.id, grantBody(draft, list)),
      );
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    });
  const id = `grant-${connector.name}-${bot.id}`;
  const blocked = blockedCount(list);

  return (
    <div data-testid="grant-row" data-bot={bot.name} data-count={countLabel(draft, list)}>
      <ActionCard
        testId="grant-card"
        icon={<BotIcon size={14} />}
        kind={bot.name}
        state="done"
        stateLabel=""
        summary={countLabel(saved, list)}
        expanded={open}
        onToggle={() => setOpen(!open)}
      >
        <div className="grant-shortcuts" role="group" aria-label={`Atalhos para ${bot.name}`}>
          <Pill
            tone="ghost"
            disabled={task.busy}
            data-testid="grant-all"
            onClick={() => setDraft(selectAll())}
          >
            Selecionar todas
          </Pill>
          <Pill
            tone="ghost"
            disabled={task.busy}
            data-testid="grant-read"
            onClick={() => setDraft(selectReadOnly(list))}
          >
            Só as de leitura
          </Pill>
          <Pill
            tone="ghost"
            disabled={task.busy}
            data-testid="grant-none"
            onClick={() => setDraft(selectNone())}
          >
            Nenhuma
          </Pill>
        </div>
        {list.length === 0 ? (
          <p className="ui-action__label">Este conector não oferece ferramentas aos bots.</p>
        ) : (
          <ul
            className="grant-tools"
            aria-label={`Ferramentas de ${connector.name} para ${bot.name}`}
          >
            {list.map((item) => {
              const checkId = `${id}-${item.tool.tool}`;
              return (
                <li
                  key={item.tool.name}
                  className="grant-tool"
                  data-testid="grant-tool"
                  data-tool={item.tool.tool}
                  data-blocked={item.blocked ?? undefined}
                >
                  <input
                    id={checkId}
                    type="checkbox"
                    checked={isTicked(draft, item)}
                    disabled={item.blocked !== null || task.busy}
                    aria-describedby={`${checkId}-why`}
                    onChange={() => setDraft(toggleTool(draft, list, item.tool.tool))}
                  />
                  <div className="grant-tool__text">
                    <div className="grant-tool__head">
                      <label htmlFor={checkId}>
                        <strong>{item.tool.tool}</strong>
                      </label>
                      <span className="grant-tool__risk" data-testid="grant-risk">
                        <span className="sr-only">Risco: </span>
                        {LEVEL_LABEL[item.tool.risk]}
                      </span>
                    </div>
                    <p id={`${checkId}-why`} className="ui-action__label" data-testid="grant-basis">
                      {item.blocked === null ? (
                        RISK_BASIS_TEXT[item.tool.riskBasis]
                      ) : (
                        <>
                          {BLOCKED_TEXT[item.blocked]}{" "}
                          <button
                            type="button"
                            className="link-button"
                            data-testid="grant-review"
                            onClick={onReview}
                          >
                            Revisar
                          </button>
                        </>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {blocked > 0 && (
          <p className="ui-action__label">
            Uma ferramenta com a definição mudada ou nova só pode ser marcada depois da sua revisão.
          </p>
        )}
        <p className="ui-action__label">A mudança vale a partir da próxima execução do bot.</p>
        {task.error !== undefined && (
          <p className="ui-field__error" role="alert" data-testid="grant-error">
            {task.error}
          </p>
        )}
        <div className="grant-footer">
          {dirty && (
            <Pill
              tone="ghost"
              disabled={task.busy}
              data-testid="grant-discard"
              onClick={() => setDraft(saved)}
            >
              Descartar
            </Pill>
          )}
          <Pill
            tone="primary"
            disabled={!dirty || task.busy}
            data-testid="grant-save"
            onClick={() => void save()}
          >
            {task.busy ? "Salvando…" : "Salvar"}
          </Pill>
        </div>
      </ActionCard>
    </div>
  );
}

/**
 * "Quem pode usar": one collapsed row per bot with how many of the connector's tools it may use.
 * Giving a connector to a bot is a choice of tools, never an on/off switch: none is ticked at first.
 */
export function ConnectorGrants({
  connector,
  onReview,
}: {
  connector: Connector;
  onReview(): void;
}) {
  const bots = useData((s) => s.bots);
  const botList = useMemo(() => sortedBots(bots), [bots]);
  const list = useMemo(() => grantableTools(connector.tools), [connector.tools]);
  return (
    <div className="grants" data-testid="connector-grants" role="group" aria-label="Quem pode usar">
      <h3 className="section-label">Quem pode usar</h3>
      {connector.tools === null ? (
        <p className="muted small" data-testid="grants-unlisted">
          Use “Testar” para o servidor listar as ferramentas: depois você escolhe, bot a bot, quais
          ele pode usar.
        </p>
      ) : botList.length === 0 ? (
        <p className="muted small">Ainda não há bots.</p>
      ) : (
        <div className="grant-list">
          {botList.map((b) => (
            <BotGrant key={b.id} bot={b} connector={connector} list={list} onReview={onReview} />
          ))}
        </div>
      )}
      <p className="muted small">
        Dar uma ferramenta a um bot dá a ele o que o servidor faz com as credenciais do conector.
        Nenhuma vem marcada: você escolhe.
      </p>
    </div>
  );
}
