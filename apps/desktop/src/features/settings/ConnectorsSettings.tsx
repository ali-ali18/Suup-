import type { Connector, ConnectorTest, ConnectorTool, RiskLevel } from "@suup/api";
import { Plug, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { LEVEL_LABEL, LEVELS } from "../../data/approval-text.js";
import { formatDuration } from "../../data/derive.js";
import { orderedConnectors, orderedSecrets } from "../../data/reducers.js";
import {
  bearerRow,
  buildCreateBody,
  type ConnectorForm,
  emptyForm,
  emptyRow,
  type FormErrors,
  HTTP_WARNING,
  parseRecipientFields,
  READ_WARNING,
  type RefRow,
  RISK_BASIS_TEXT,
  STDIO_WARNING,
  TIGHTENED_HELP,
} from "../../lib/connector-form.js";
import { RUNS_IN_LABEL } from "../../lib/network.js";
import { reviewNotice } from "../../lib/tool-review.js";
import { Card, Dialog, EmptyState, Pill, Tag, TextField, Toggle } from "../../ui/primitives.js";
import { ConnectorGrants } from "./ConnectorGrants.js";
import { ConnectorNetwork } from "./ConnectorNetwork.js";
import { formatWhen } from "./formatting.js";
import { ReviewDialog, ToolHistory } from "./ToolReview.js";
import { useTask } from "./use-task.js";
import { SecretDialog } from "./VaultSettings.js";

const KIND_LABEL = { stdio: "Programa neste computador", http: "Servidor HTTP" } as const;

// ------------------------------------------------------------- the form

function RefRows({
  rows,
  onChange,
  secrets,
  noun,
  onNewSecret,
  extra,
}: {
  rows: RefRow[];
  onChange(rows: RefRow[]): void;
  secrets: readonly string[];
  noun: "variável" | "cabeçalho";
  onNewSecret(): void;
  extra?: React.ReactNode;
}) {
  const set = (id: string, patch: Partial<RefRow>) =>
    onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  return (
    <div className="form__row">
      {rows.map((row) => (
        <div key={row.id} className="cond-row cond-row--ref" data-testid="ref-row">
          <input
            className="ui-field__control"
            aria-label={`Nome d${noun === "variável" ? "a" : "o"} ${noun}`}
            placeholder={noun === "variável" ? "NOME_DA_VARIAVEL" : "Nome-do-cabecalho"}
            value={row.key}
            onChange={(e) => set(row.id, { key: e.target.value })}
          />
          <select
            className="ui-field__control"
            aria-label={`De onde vem o valor d${noun === "variável" ? "a" : "o"} ${noun}`}
            value={row.mode}
            onChange={(e) => set(row.id, { mode: e.target.value as RefRow["mode"] })}
          >
            <option value="text">Texto</option>
            <option value="secret">Segredo do cofre</option>
          </select>
          {row.mode === "text" ? (
            <input
              className="ui-field__control"
              aria-label="Valor (texto)"
              placeholder="valor"
              value={row.text}
              onChange={(e) => set(row.id, { text: e.target.value })}
            />
          ) : (
            <select
              className="ui-field__control"
              aria-label="Segredo"
              value={row.secret}
              onChange={(e) => set(row.id, { secret: e.target.value })}
            >
              <option value="">Escolha um segredo…</option>
              {secrets.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="ui-icon-button"
            aria-label={`Remover ${noun}`}
            onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        </div>
      ))}
      <div className="settings__row">
        <Pill
          tone="ghost"
          icon={<Plus size={16} aria-hidden="true" />}
          onClick={() => onChange([...rows, emptyRow()])}
        >
          Adicionar {noun}
        </Pill>
        <Pill tone="ghost" onClick={onNewSecret} data-testid="connector-new-secret">
          Cadastrar um segredo novo
        </Pill>
        {extra}
      </div>
      <p className="ui-field__hint">
        {noun === "variável"
          ? "Só estas variáveis chegam ao programa"
          : "Estes cabeçalhos vão em toda requisição"}
        . Um valor em <strong>texto</strong> fica visível para quem usa a API do servidor: para
        credenciais, escolha <strong>segredo do cofre</strong>.
      </p>
    </div>
  );
}

function AddConnectorDialog({ onClose, onNewSecret }: { onClose(): void; onNewSecret(): void }) {
  const { sync, api } = useServices();
  const secretsByName = useData((s) => s.secrets);
  const secretNames = useMemo(
    () => orderedSecrets({ secrets: secretsByName }).map((s) => s.name),
    [secretsByName],
  );
  const [form, setForm] = useState<ConnectorForm>(() => emptyForm("stdio"));
  const [errors, setErrors] = useState<FormErrors>({});
  const task = useTask();
  const set = (patch: Partial<ConnectorForm>) => setForm((f) => ({ ...f, ...patch }));

  const create = async () => {
    const built = buildCreateBody(form, secretNames);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setErrors({});
    const ok = await task.run(async () => {
      const result = await sync.connectorCall(() => api.connectors.create(built.body));
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    });
    if (ok) onClose();
  };

  return (
    <Dialog
      title="Adicionar conector"
      onClose={onClose}
      wide
      footer={
        <>
          <Pill tone="secondary" onClick={onClose} disabled={task.busy}>
            Cancelar
          </Pill>
          <Pill
            tone="primary"
            onClick={() => void create()}
            disabled={task.busy}
            data-testid="connector-create"
          >
            {task.busy ? "Adicionando…" : "Adicionar conector"}
          </Pill>
        </>
      }
    >
      <div className="form" data-testid="connector-form">
        <div className="ui-notice" role="note" data-testid="connector-warning">
          <strong>
            {form.kind === "stdio"
              ? "Atenção: isto roda um programa"
              : "Atenção: isto fala com um servidor"}
          </strong>
          <p>{form.kind === "stdio" ? STDIO_WARNING : HTTP_WARNING}</p>
        </div>
        <div className="form__row">
          <span className="ui-field__label" id="connector-kind">
            Tipo
          </span>
          <div className="settings__row" role="radiogroup" aria-labelledby="connector-kind">
            {(["stdio", "http"] as const).map((kind) => (
              <Pill
                key={kind}
                tone={form.kind === kind ? "primary" : "secondary"}
                role="radio"
                aria-checked={form.kind === kind}
                data-testid={`connector-kind-${kind}`}
                onClick={() => set({ kind })}
              >
                {KIND_LABEL[kind]}
              </Pill>
            ))}
          </div>
        </div>
        <TextField
          label="Nome"
          value={form.name}
          onChange={(name) => set({ name })}
          placeholder="github"
          error={errors.name}
          hint="Letras minúsculas e números, separados por hífen. É como o conector aparece nos cartões e nas regras."
          name="connector-name"
        />
        <TextField
          label="Descrição (opcional)"
          value={form.description}
          onChange={(description) => set({ description })}
        />
        {form.kind === "stdio" ? (
          <>
            <TextField
              label="Programa"
              value={form.command}
              onChange={(command) => set({ command })}
              placeholder="npx"
              error={errors.command}
              hint="Só o executável, sem espaços. Ele precisa existir no computador onde o servidor trabalha."
              name="connector-command"
            />
            <TextField
              label="Argumentos (um por linha)"
              value={form.argsText}
              onChange={(argsText) => set({ argsText })}
              multiline
              rows={4}
              error={errors.args}
              hint="Cada linha é um argumento, entregue ao programa sem passar por um shell."
              name="connector-args"
            />
            <div className="form__row">
              <span className="ui-field__label">Variáveis de ambiente</span>
              <RefRows
                rows={form.env}
                onChange={(env) => set({ env })}
                secrets={secretNames}
                noun="variável"
                onNewSecret={onNewSecret}
              />
              {errors.env !== undefined && (
                <p className="ui-field__error" role="alert">
                  {errors.env}
                </p>
              )}
            </div>
          </>
        ) : (
          <>
            <TextField
              label="Endereço (URL)"
              value={form.url}
              onChange={(url) => set({ url })}
              placeholder="https://servidor.exemplo.com/mcp"
              type="url"
              error={errors.url}
              name="connector-url"
            />
            <div className="form__row">
              <span className="ui-field__label">Cabeçalhos</span>
              <RefRows
                rows={form.headers}
                onChange={(headers) => set({ headers })}
                secrets={secretNames}
                noun="cabeçalho"
                onNewSecret={onNewSecret}
                extra={
                  <Pill
                    tone="ghost"
                    disabled={secretNames.length === 0}
                    onClick={() =>
                      set({ headers: [...form.headers, bearerRow(secretNames[0] ?? "")] })
                    }
                  >
                    Authorization: Bearer (segredo)
                  </Pill>
                }
              />
              {errors.headers !== undefined && (
                <p className="ui-field__error" role="alert">
                  {errors.headers}
                </p>
              )}
            </div>
          </>
        )}
        <div className="form__row">
          <label className="ui-field__label" htmlFor="connector-scope">
            Escopo
          </label>
          <select
            id="connector-scope"
            className="ui-field__control"
            value={form.scope}
            onChange={(e) => set({ scope: e.target.value as ConnectorForm["scope"] })}
          >
            <option value="read_only">
              Somente leitura (só as ferramentas de leitura são oferecidas)
            </option>
            <option value="read_write">Leitura e escrita (as que escrevem pedem cartão)</option>
          </select>
        </div>
        <TextField
          label="Tempo limite de cada chamada, em segundos (opcional)"
          value={form.timeoutSec}
          onChange={(timeoutSec) => set({ timeoutSec })}
          error={errors.timeout}
          hint="Em branco: o padrão do servidor (60 s)."
        />
        <p className="ui-field__hint" data-testid="connector-grant-hint">
          Nenhum bot recebe o conector ao criá-lo. Depois de “Testar”, você escolhe, bot a bot,
          quais ferramentas cada um pode usar.
        </p>
        {task.error !== undefined && (
          <p className="ui-field__error" role="alert" data-testid="connector-error">
            {task.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------- the tools

/**
 * "Envia mensagem para outra pessoa": only the USER can mark a tool this way (a server's hints
 * never do), and says which argument holds the recipient. It is what makes the approval card the
 * message card (Enviar, Permitir destinatário).
 */
function OutboundMark({ connector, tool }: { connector: Connector; tool: ConnectorTool }) {
  const { sync, api } = useServices();
  const task = useTask();
  const saved = tool.outbound?.recipientFields.join(", ") ?? "";
  const [marked, setMarked] = useState(tool.outbound !== null);
  const [fields, setFields] = useState(saved);
  useEffect(() => {
    setMarked(tool.outbound !== null);
    setFields(saved);
  }, [tool.outbound, saved]);
  const id = `outbound-${connector.name}-${tool.tool}`;
  const parsed = parseRecipientFields(fields);
  const dirty = marked !== (tool.outbound !== null) || (marked && fields !== saved);
  const save = () =>
    task.run(async () => {
      const result = await sync.connectorCall(() =>
        api.connectors.setToolOutbound(connector.name, tool.tool, {
          outbound: marked ? { kind: "message", recipientFields: parsed } : null,
        }),
      );
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    });
  return (
    <div className="tool-row__outbound" data-testid="tool-outbound">
      <label className="settings__row">
        <input
          type="checkbox"
          checked={marked}
          disabled={task.busy}
          data-testid="tool-outbound-check"
          onChange={(e) => setMarked(e.target.checked)}
        />
        <span>Envia mensagem para outra pessoa</span>
      </label>
      {marked && (
        <div className="settings__row">
          <label className="ui-field__label" htmlFor={id}>
            Campo do destinatário
          </label>
          <input
            id={id}
            className="ui-field__control"
            placeholder="ex.: to (separe vários por vírgula)"
            value={fields}
            disabled={task.busy}
            data-testid="tool-outbound-fields"
            onChange={(e) => setFields(e.target.value)}
          />
        </div>
      )}
      <p className="ui-field__hint">
        Só você marca isto; o servidor não pode. O cartão desta ferramenta passa a ter “Enviar” e o
        menu do destinatário.
      </p>
      {dirty && (
        <Pill
          tone="secondary"
          disabled={task.busy || (marked && parsed.length === 0)}
          data-testid="tool-outbound-save"
          onClick={() => void save()}
        >
          {task.busy ? "Salvando…" : "Salvar"}
        </Pill>
      )}
    </div>
  );
}

function ToolRow({ connector, tool }: { connector: Connector; tool: ConnectorTool }) {
  const { sync, api } = useServices();
  const task = useTask();
  const chosen = connector.toolOverrides[tool.tool]?.risk ?? "";
  return (
    <li
      className="tool-row"
      data-testid="connector-tool"
      data-tool={tool.tool}
      data-available={tool.available}
    >
      <div className="row-between">
        <p>
          <strong>{tool.tool}</strong> <code className="muted">{tool.name}</code>
          {(tool.pin === "changed" || tool.pin === "new") && (
            <>
              {" "}
              <Tag tone="outline">
                <span data-testid="tool-pin" data-pin={tool.pin}>
                  {tool.pin === "changed"
                    ? "definição mudou, esperando sua revisão"
                    : "nova, esperando sua revisão"}
                </span>
              </Tag>
            </>
          )}
        </p>
        <Tag
          tone={
            tool.risk === "external_irreversible"
              ? "danger"
              : tool.risk === "read"
                ? "neutral"
                : "outline"
          }
        >
          {LEVEL_LABEL[tool.risk]}
        </Tag>
      </div>
      {tool.description !== "" && (
        <blockquote className="quote" data-testid="tool-description">
          <Tag tone="outline">escrito pelo servidor</Tag>
          <p className="wrap">{tool.description}</p>
        </blockquote>
      )}
      {tool.available ? (
        <>
          <p className="muted small" data-testid="tool-basis">
            {RISK_BASIS_TEXT[tool.riskBasis]}
            {tool.hints !== null && (
              <>
                {" "}
                Dica do servidor:{" "}
                {[
                  tool.hints.readOnlyHint === undefined
                    ? undefined
                    : tool.hints.readOnlyHint
                      ? "só lê"
                      : "escreve",
                  tool.hints.destructiveHint === true ? "destrutiva" : undefined,
                ]
                  .filter(Boolean)
                  .join(", ") || "nenhuma"}
                .
              </>
            )}
          </p>
          {tool.riskBasis === "tightened_by_hint" && (
            <p className="ui-notice" role="note">
              {TIGHTENED_HELP}
            </p>
          )}
          <div className="settings__row tool-row__risk">
            <label className="ui-field__label" htmlFor={`risk-${connector.name}-${tool.tool}`}>
              O que você afirma
            </label>
            <select
              id={`risk-${connector.name}-${tool.tool}`}
              className="ui-field__control tool-row__select"
              value={chosen}
              disabled={task.busy}
              data-testid="tool-risk"
              onChange={(e) => {
                const value = e.target.value === "" ? null : (e.target.value as RiskLevel);
                void task.run(async () => {
                  const result = await sync.connectorCall(() =>
                    api.connectors.setToolRisk(connector.name, tool.tool, { risk: value }),
                  );
                  return result.ok ? { ok: true } : { ok: false, message: result.message };
                });
              }}
            >
              <option value="">Padrão (pergunta antes)</option>
              {LEVELS.map((level) => (
                <option key={level} value={level}>
                  {LEVEL_LABEL[level]}
                </option>
              ))}
            </select>
          </div>
          <OutboundMark connector={connector} tool={tool} />
          {task.error !== undefined && (
            <p className="ui-field__error" role="alert">
              {task.error}
            </p>
          )}
        </>
      ) : (
        <p className="muted small" data-testid="tool-unavailable-reason">
          Não é oferecida aos bots: {tool.reason ?? "motivo não informado"}.
        </p>
      )}
    </li>
  );
}

// ------------------------------------------------------------ one connector

function ConnectorCard({
  connector,
  onAskEnable,
}: {
  connector: Connector;
  onAskEnable(c: Connector): void;
}) {
  const { sync, api } = useServices();
  const [open, setOpen] = useState(false);
  const [test, setTest] = useState<ConnectorTest | undefined>(undefined);
  const [removing, setRemoving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const toggling = useTask();
  const scope = useTask();
  const trust = useTask();
  const testing = useTask();
  const removal = useTask();
  const available = (connector.tools ?? []).filter((t) => t.available);
  const unavailable = (connector.tools ?? []).filter((t) => !t.available);
  const lastError = connector.discovery.lastError;
  const notice = reviewNotice(connector);
  const withAccess = connector.grants.filter((g) => g.all || g.tools.length > 0).length;

  return (
    <li
      className="connector"
      data-testid="connector-row"
      data-name={connector.name}
      data-enabled={connector.enabled}
    >
      <div className="row-between">
        <div className="connector__title">
          <Plug size={16} aria-hidden="true" />
          <strong>{connector.name}</strong>
        </div>
        <Toggle
          checked={connector.enabled}
          disabled={toggling.busy}
          label={`${connector.name}: ligado`}
          onChange={(next) => {
            if (next && connector.transport.kind === "stdio") return onAskEnable(connector);
            void toggling.run(async () => {
              const result = await sync.connectorCall(() =>
                api.connectors.update(connector.name, { enabled: next }),
              );
              return result.ok ? { ok: true } : { ok: false, message: result.message };
            });
          }}
        />
      </div>
      {connector.description !== "" && <p className="muted small wrap">{connector.description}</p>}
      <div className="inline-tags">
        <Tag tone="outline">{KIND_LABEL[connector.transport.kind]}</Tag>
        {connector.scope === "read_only" && <Tag tone="outline">Só leitura</Tag>}
        {!connector.enabled && <Tag tone="outline">Desligado</Tag>}
        {connector.runsIn !== null && (
          <Tag tone="outline">
            <span data-testid="connector-runs-tag">{RUNS_IN_LABEL[connector.runsIn]}</span>
          </Tag>
        )}
        <Tag tone="outline">
          {withAccess === 0 ? "Nenhum bot" : `${withAccess} ${withAccess === 1 ? "bot" : "bots"}`}
        </Tag>
        {connector.origin === "proposal" && <Tag tone="outline">Proposto por um bot</Tag>}
      </div>
      <p className="small" data-testid="connector-health">
        {lastError !== null ? (
          <span className="connector__error wrap">Último erro: {lastError}</span>
        ) : connector.tools === null ? (
          <span className="muted">Ainda não listado: use “Testar” para ver as ferramentas.</span>
        ) : (
          <span className="muted">
            {available.length}{" "}
            {available.length === 1 ? "ferramenta oferecida" : "ferramentas oferecidas"}
            {connector.discovery.discoveredAt !== null &&
              ` · listado em ${formatWhen(connector.discovery.discoveredAt)}`}
          </span>
        )}
      </p>
      {notice !== null && (
        <div className="ui-notice review-notice" role="status" data-testid="review-notice">
          <span>{notice}.</span>
          <Pill tone="secondary" data-testid="connector-review" onClick={() => setReviewing(true)}>
            Revisar
          </Pill>
        </div>
      )}
      {toggling.error !== undefined && (
        <p className="ui-field__error" role="alert">
          {toggling.error}
        </p>
      )}
      <div className="settings__row connector__actions">
        <Pill
          tone="secondary"
          disabled={testing.busy}
          data-testid="connector-test"
          onClick={() =>
            void testing.run(async () => {
              try {
                setTest(await api.connectors.test(connector.name));
                void sync.loadConnectors();
                return { ok: true };
              } catch (error) {
                return {
                  ok: false,
                  message: error instanceof Error ? error.message : "Não foi possível testar.",
                };
              }
            })
          }
        >
          {testing.busy ? "Testando…" : "Testar"}
        </Pill>
        <Pill
          tone="ghost"
          aria-expanded={open}
          data-testid="connector-details"
          onClick={() => setOpen(!open)}
        >
          Ferramentas e acesso
        </Pill>
        <Pill tone="danger" onClick={() => setRemoving(true)} data-testid="connector-delete">
          Remover
        </Pill>
      </div>
      {testing.error !== undefined && (
        <p className="ui-field__error" role="alert">
          {testing.error}
        </p>
      )}
      {test !== undefined && (
        <p
          className={test.ok ? "small" : "ui-field__error small"}
          role="status"
          data-testid="connector-test-result"
          data-ok={test.ok}
        >
          {test.ok
            ? `Funcionou: ${test.serverName ?? "servidor"}${test.serverVersion === null ? "" : ` ${test.serverVersion}`}, ${test.tools.length} ${test.tools.length === 1 ? "ferramenta" : "ferramentas"}, em ${formatDuration(test.durationMs)}.`
            : `Falhou: ${test.error ?? "sem detalhes"}`}
        </p>
      )}
      {open && (
        <div className="connector__details" data-testid="connector-panel">
          <ConnectorGrants connector={connector} onReview={() => setReviewing(true)} />
          <div className="settings__setting">
            <div className="settings__setting-text">
              <span>Somente leitura</span>
              <span className="muted small">
                Só as ferramentas de leitura são oferecidas aos bots; as outras nem aparecem para o
                modelo.
              </span>
            </div>
            <Toggle
              checked={connector.scope === "read_only"}
              disabled={scope.busy}
              label={`${connector.name}: somente leitura`}
              onChange={(next) =>
                void scope.run(async () => {
                  const result = await sync.connectorCall(() =>
                    api.connectors.update(connector.name, {
                      scope: next ? "read_only" : "read_write",
                    }),
                  );
                  return result.ok ? { ok: true } : { ok: false, message: result.message };
                })
              }
            />
          </div>
          <div className="settings__setting">
            <div className="settings__setting-text">
              <span>Confiar nas dicas do servidor</span>
              <span className="muted small">
                Ligado, uma ferramenta que o servidor diz que só lê passa a rodar sem cartão. O
                servidor é um programa que você não escreveu: só ligue se confia nele. Uma dica de
                “destrutiva” nunca é ignorada.
              </span>
            </div>
            <Toggle
              checked={connector.trustAnnotations}
              disabled={trust.busy}
              label={`${connector.name}: confiar nas dicas do servidor`}
              onChange={(next) =>
                void trust.run(async () => {
                  const result = await sync.connectorCall(() =>
                    api.connectors.update(connector.name, { trustAnnotations: next }),
                  );
                  return result.ok ? { ok: true } : { ok: false, message: result.message };
                })
              }
            />
          </div>
          {(scope.error ?? trust.error) !== undefined && (
            <p className="ui-field__error" role="alert">
              {scope.error ?? trust.error}
            </p>
          )}
          {connector.secretNames.length > 0 && (
            <p className="muted small">
              Usa os segredos do cofre:{" "}
              <span className="mono">{connector.secretNames.join(", ")}</span>
            </p>
          )}
          <ConnectorNetwork connector={connector} />
          <ToolHistory connector={connector} />
          <h3 className="section-label">Ferramentas</h3>
          <p className="muted small">{READ_WARNING}</p>
          {connector.tools === null ? (
            <p className="muted">
              Ainda não listado. Use “Testar” para o servidor listar as ferramentas.
            </p>
          ) : available.length === 0 ? (
            <p className="muted">Nenhuma ferramenta é oferecida aos bots.</p>
          ) : (
            <ul className="tool-list" data-testid="connector-tools">
              {available.map((tool) => (
                <ToolRow key={tool.name} connector={connector} tool={tool} />
              ))}
            </ul>
          )}
          {unavailable.length > 0 && (
            <>
              <h3 className="section-label">Não oferecidas aos bots</h3>
              <ul className="tool-list" data-testid="connector-tools-unavailable">
                {unavailable.map((tool) => (
                  <ToolRow key={tool.name} connector={connector} tool={tool} />
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {reviewing && <ReviewDialog connector={connector} onClose={() => setReviewing(false)} />}
      {removing && (
        <Dialog
          title={`Remover o conector ${connector.name}?`}
          onClose={() => setRemoving(false)}
          footer={
            <>
              <Pill tone="secondary" onClick={() => setRemoving(false)} disabled={removal.busy}>
                Cancelar
              </Pill>
              <Pill
                tone="danger"
                disabled={removal.busy}
                data-testid="connector-delete-confirm"
                onClick={() => void removal.run(() => sync.deleteConnector(connector.name))}
              >
                {removal.busy ? "Removendo…" : "Remover"}
              </Pill>
            </>
          }
        >
          <p>
            Os bots deixam de ter as ferramentas deste conector na próxima execução. Os segredos do
            cofre que ele cita continuam guardados.
          </p>
          {removal.error !== undefined && (
            <p className="ui-field__error" role="alert">
              {removal.error}
            </p>
          )}
        </Dialog>
      )}
    </li>
  );
}

// ----------------------------------------------------------------- the screen

/** MCP connectors: external servers whose tools a bot can use, once you give it the connector. */
export function ConnectorsSettings() {
  const { sync, api } = useServices();
  const byName = useData((s) => s.connectors);
  const loaded = useData((s) => s.connectorsLoaded);
  const connectors = useMemo(() => orderedConnectors({ connectors: byName }), [byName]);
  const [adding, setAdding] = useState(false);
  const [newSecret, setNewSecret] = useState(false);
  const [enabling, setEnabling] = useState<Connector | null>(null);
  const enable = useTask();

  useEffect(() => {
    void sync.loadConnectors();
    void sync.loadVault();
  }, [sync]);

  return (
    <>
      <Card aria-label="Conectores" data-testid="connectors-card">
        <div className="row-between">
          <h2 className="section-label">Conectores (MCP)</h2>
          <Pill
            tone="secondary"
            icon={<Plus size={16} aria-hidden="true" />}
            data-testid="connector-new"
            onClick={() => setAdding(true)}
          >
            Adicionar conector
          </Pill>
        </div>
        <p className="muted small">
          Um conector liga um servidor externo (Model Context Protocol) aos seus bots. As
          ferramentas dele só aparecem para os bots a quem você der o conector, e por padrão cada
          uma pede um cartão de aprovação antes de rodar.
        </p>
        {!loaded ? (
          <p className="muted">Carregando…</p>
        ) : connectors.length === 0 ? (
          <EmptyState
            icon={<Plug size={16} />}
            title="Nenhum conector"
            text="Adicione um servidor MCP, dê a um bot e veja as ferramentas dele aqui."
          />
        ) : (
          <ul className="connector-list" data-testid="connector-list">
            {connectors.map((c) => (
              <ConnectorCard key={c.name} connector={c} onAskEnable={setEnabling} />
            ))}
          </ul>
        )}
      </Card>
      {adding && (
        <AddConnectorDialog
          onClose={() => setAdding(false)}
          onNewSecret={() => setNewSecret(true)}
        />
      )}
      {newSecret && <SecretDialog existing={undefined} onClose={() => setNewSecret(false)} />}
      {enabling !== null && (
        <Dialog
          title={`Ligar o conector ${enabling.name}?`}
          onClose={() => setEnabling(null)}
          footer={
            <>
              <Pill tone="secondary" onClick={() => setEnabling(null)} disabled={enable.busy}>
                Cancelar
              </Pill>
              <Pill
                tone="primary"
                disabled={enable.busy}
                data-testid="connector-enable-confirm"
                onClick={() =>
                  void enable
                    .run(async () => {
                      const result = await sync.connectorCall(() =>
                        api.connectors.update(enabling.name, { enabled: true }),
                      );
                      return result.ok ? { ok: true } : { ok: false, message: result.message };
                    })
                    .then((ok) => ok && setEnabling(null))
                }
              >
                {enable.busy ? "Ligando…" : "Ligar mesmo assim"}
              </Pill>
            </>
          }
        >
          <div className="ui-notice" role="note" data-testid="connector-enable-warning">
            <strong>Isto roda um programa</strong>
            <p>{STDIO_WARNING}</p>
          </div>
          <p className="mono wrap small">
            {enabling.transport.kind === "stdio" &&
              [enabling.transport.command, ...(enabling.transport.args ?? [])].join(" ")}
          </p>
          {enable.error !== undefined && (
            <p className="ui-field__error" role="alert">
              {enable.error}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
