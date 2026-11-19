import type { Connector, ConnectorTest, ConnectorTool, RiskLevel } from "@suup/api";
import { ChevronLeft, Plus, Trash2 } from "lucide-react";
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
import { Dropdown, type DropdownOption } from "../../ui/dropdown.js";
import { Dialog, Pill, Tag, TextField, Toggle } from "../../ui/primitives.js";
import { ConnectorGrants } from "./ConnectorGrants.js";
import { ConnectorNetwork } from "./ConnectorNetwork.js";
import { formatWhen } from "./formatting.js";
import { PaneHead, RowAction, type SectionProps, SettingsGroup, SettingsRow } from "./parts.js";
import { ReviewDialog, ToolHistory } from "./ToolReview.js";
import { useTask } from "./use-task.js";
import { SecretDialog } from "./VaultSettings.js";

const SOURCE_OPTIONS: readonly DropdownOption<RefRow["mode"]>[] = [
  { value: "text", label: "Texto" },
  { value: "secret", label: "Segredo do cofre" },
];
const secretOption = (name: string): DropdownOption => ({ value: name, label: name });
const SCOPE_OPTIONS: readonly DropdownOption<ConnectorForm["scope"]>[] = [
  { value: "read_only", label: "Somente leitura (só as ferramentas de leitura são oferecidas)" },
  { value: "read_write", label: "Leitura e escrita (as que escrevem pedem cartão)" },
];
const RISK_OPTIONS: readonly DropdownOption<RiskLevel | "">[] = [
  { value: "", label: "Padrão (pergunta antes)" },
  ...LEVELS.map((level) => ({ value: level, label: LEVEL_LABEL[level] })),
];

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
          <Dropdown
            variant="field"
            label={`De onde vem o valor d${noun === "variável" ? "a" : "o"} ${noun}`}
            value={row.mode}
            options={SOURCE_OPTIONS}
            onChange={(mode) => set(row.id, { mode })}
          />
          {row.mode === "text" ? (
            <input
              className="ui-field__control"
              aria-label="Valor (texto)"
              placeholder="valor"
              value={row.text}
              onChange={(e) => set(row.id, { text: e.target.value })}
            />
          ) : (
            <Dropdown
              variant="field"
              label="Segredo"
              value={row.secret}
              options={[{ value: "", label: "Escolha um segredo…" }, ...secrets.map(secretOption)]}
              onChange={(secret) => set(row.id, { secret })}
            />
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
          tone="secondary"
          icon={<Plus size={16} aria-hidden="true" />}
          onClick={() => onChange([...rows, emptyRow()])}
        >
          Adicionar {noun}
        </Pill>
        <Pill tone="secondary" onClick={onNewSecret} data-testid="connector-new-secret">
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
                    tone="secondary"
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
          <Dropdown
            id="connector-scope"
            variant="field"
            label="Escopo"
            value={form.scope}
            options={SCOPE_OPTIONS}
            onChange={(scope) => set({ scope })}
          />
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
  // What the server holds changed: show it again (while rendering, not in an effect, which also ran
  // after the first render and could undo what was typed right after the field appeared).
  const savedKey = JSON.stringify([tool.outbound !== null, saved]);
  const [shownKey, setShownKey] = useState(savedKey);
  if (shownKey !== savedKey) {
    setShownKey(savedKey);
    setMarked(tool.outbound !== null);
    setFields(saved);
  }
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
    <>
      <SettingsRow
        title="Envia mensagem para outra pessoa"
        description="Só você marca isto; o servidor não pode. O cartão desta ferramenta passa a ter “Enviar” e o menu do destinatário."
        control={
          <Toggle
            checked={marked}
            disabled={task.busy}
            testId="tool-outbound-check"
            label={`${tool.tool}: envia mensagem para outra pessoa`}
            onChange={setMarked}
          />
        }
      />
      {marked && (
        <SettingsRow
          title="Campo do destinatário"
          titleId={`${id}-label`}
          control={
            <input
              id={id}
              className="ui-field__control sinput"
              aria-labelledby={`${id}-label`}
              placeholder="ex.: to (separe vários por vírgula)"
              value={fields}
              disabled={task.busy}
              data-testid="tool-outbound-fields"
              onChange={(e) => setFields(e.target.value)}
            />
          }
        />
      )}
      {dirty && (
        <SettingsRow
          title="Alteração não salva"
          control={
            <RowAction
              disabled={task.busy || (marked && parsed.length === 0)}
              data-testid="tool-outbound-save"
              onClick={() => void save()}
            >
              {task.busy ? "Salvando…" : "Salvar"}
            </RowAction>
          }
        />
      )}
    </>
  );
}

function ToolRow({ connector, tool }: { connector: Connector; tool: ConnectorTool }) {
  const { sync, api } = useServices();
  const task = useTask();
  const [open, setOpen] = useState(false);
  const chosen = connector.toolOverrides[tool.tool]?.risk ?? "";
  return (
    <li
      className="tool-row"
      data-testid="connector-tool"
      data-tool={tool.tool}
      data-available={tool.available}
    >
      <SettingsRow
        title={tool.tool}
        description={
          tool.pin === "changed" || tool.pin === "new" ? (
            <span data-testid="tool-pin" data-pin={tool.pin}>
              {tool.pin === "changed"
                ? "Definição mudou, esperando sua revisão"
                : "Nova, esperando sua revisão"}
            </span>
          ) : undefined
        }
        control={
          <>
            <span className="srow__value">
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
            </span>
            <RowAction
              aria-expanded={open}
              data-testid="connector-tool-toggle"
              onClick={() => setOpen(!open)}
            >
              {open ? "Fechar" : "Detalhes"}
            </RowAction>
          </>
        }
      />
      {open && (
        <div className="sfold">
          <p className="sgroup__hint">
            Nome registrado: <code>{tool.name}</code>
          </p>
          {tool.description !== "" && (
            <blockquote className="quote" data-testid="tool-description">
              <Tag tone="outline">escrito pelo servidor</Tag>
              <p className="wrap">{tool.description}</p>
            </blockquote>
          )}
          {tool.available ? (
            <>
              <p className="sgroup__hint" data-testid="tool-basis">
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
              <div className="scard">
                <SettingsRow
                  title="O que você afirma"
                  control={
                    <Dropdown
                      label={`O que você afirma sobre ${tool.tool}`}
                      value={chosen}
                      options={RISK_OPTIONS}
                      disabled={task.busy}
                      testId="tool-risk"
                      onChange={(value) => {
                        void task.run(async () => {
                          const result = await sync.connectorCall(() =>
                            api.connectors.setToolRisk(connector.name, tool.tool, {
                              risk: value === "" ? null : value,
                            }),
                          );
                          return result.ok ? { ok: true } : { ok: false, message: result.message };
                        });
                      }}
                    />
                  }
                />
                <OutboundMark connector={connector} tool={tool} />
              </div>
              {task.error !== undefined && (
                <p className="ui-field__error" role="alert">
                  {task.error}
                </p>
              )}
            </>
          ) : (
            <p className="sgroup__hint" data-testid="tool-unavailable-reason">
              Não é oferecida aos bots: {tool.reason ?? "motivo não informado"}.
            </p>
          )}
        </div>
      )}
    </li>
  );
}

// ------------------------------------------------------------ one connector

/** The row of a connector in the list: name, one line of state, the switch and "Abrir". */
function ConnectorRow({
  connector,
  onOpen,
  onAskEnable,
}: {
  connector: Connector;
  onOpen(): void;
  onAskEnable(c: Connector): void;
}) {
  const { sync, api } = useServices();
  const toggling = useTask();
  const withAccess = connector.grants.filter((g) => g.all || g.tools.length > 0).length;
  const notice = reviewNotice(connector);
  const offered = (connector.tools ?? []).filter((t) => t.available).length;
  const lastError = connector.discovery.lastError;
  const summary = [
    KIND_LABEL[connector.transport.kind],
    connector.tools === null
      ? "ainda não listado"
      : `${offered} ${offered === 1 ? "ferramenta" : "ferramentas"}`,
    withAccess === 0 ? "nenhum bot" : `${withAccess} ${withAccess === 1 ? "bot" : "bots"}`,
    lastError !== null ? "com erro" : undefined,
    notice !== null ? "espera revisão" : undefined,
    connector.enabled ? undefined : "desligado",
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  return (
    <div data-testid="connector-item" data-name={connector.name}>
      <SettingsRow
        title={connector.name}
        description={summary}
        control={
          <>
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
            <RowAction data-testid="connector-details" onClick={onOpen}>
              Abrir
            </RowAction>
          </>
        }
      />
      {toggling.error !== undefined && (
        <p className="ui-field__error" role="alert">
          {toggling.error}
        </p>
      )}
    </div>
  );
}

/** What opens when a connector is selected: its state, its access, its network and its tools. */
function ConnectorDetail({
  connector,
  title: _title,
  titleId,
  onBack,
  onClose,
  onAskEnable,
}: {
  connector: Connector;
  title?: string;
  titleId: string;
  onBack(): void;
  onClose(): void;
  onAskEnable(c: Connector): void;
}) {
  const { sync, api } = useServices();
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
  const testLine =
    test === undefined
      ? undefined
      : test.ok
        ? `Funcionou: ${test.serverName ?? "servidor"}${test.serverVersion === null ? "" : ` ${test.serverVersion}`}, ${test.tools.length} ${test.tools.length === 1 ? "ferramenta" : "ferramentas"}, em ${formatDuration(test.durationMs)}.`
        : `Falhou: ${test.error ?? "sem detalhes"}`;

  return (
    <div
      className="sroot"
      data-testid="connector-row"
      data-name={connector.name}
      data-enabled={connector.enabled}
    >
      <PaneHead title={connector.name} titleId={titleId} onClose={onClose}>
        <RowAction danger data-testid="connector-delete" onClick={() => setRemoving(true)}>
          Remover
        </RowAction>
      </PaneHead>
      <div className="spane__body">
        <div className="sback">
          <RowAction
            icon={<ChevronLeft size={16} aria-hidden="true" />}
            data-testid="connectors-back"
            onClick={onBack}
          >
            Conectores
          </RowAction>
        </div>
        <SettingsGroup>
          <SettingsRow
            title="Ligado"
            description={
              <>
                {connector.description !== "" && `${connector.description} · `}
                {KIND_LABEL[connector.transport.kind]}
                {connector.runsIn !== null && (
                  <>
                    {" · "}
                    <span data-testid="connector-runs-tag">{RUNS_IN_LABEL[connector.runsIn]}</span>
                  </>
                )}
                {connector.origin === "proposal" && " · proposto por um bot"}
              </>
            }
            control={
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
            }
          />
          <SettingsRow
            title="Testar a conexão"
            descriptionTestId="connector-health"
            description={
              lastError !== null
                ? `Último erro: ${lastError}`
                : connector.tools === null
                  ? "Ainda não listado: teste para ver as ferramentas."
                  : `${available.length} ${available.length === 1 ? "ferramenta oferecida" : "ferramentas oferecidas"}${connector.discovery.discoveredAt !== null ? ` · listado em ${formatWhen(connector.discovery.discoveredAt)}` : ""}`
            }
            control={
              <RowAction
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
                        message:
                          error instanceof Error ? error.message : "Não foi possível testar.",
                      };
                    }
                  })
                }
              >
                {testing.busy ? "Testando…" : "Testar"}
              </RowAction>
            }
          />
          {notice !== null && (
            <SettingsRow
              title="Definições para revisar"
              description={`${notice}.`}
              testId="review-notice"
              role="status"
              control={
                <RowAction data-testid="connector-review" onClick={() => setReviewing(true)}>
                  Revisar
                </RowAction>
              }
            />
          )}
        </SettingsGroup>
        {(toggling.error ?? testing.error) !== undefined && (
          <p className="ui-field__error" role="alert">
            {toggling.error ?? testing.error}
          </p>
        )}
        {testLine !== undefined && test !== undefined && (
          <p
            className={test.ok ? "small" : "ui-field__error small"}
            role="status"
            data-testid="connector-test-result"
            data-ok={test.ok}
          >
            {testLine}
          </p>
        )}
        <div className="sdetail" data-testid="connector-panel">
          <ConnectorGrants connector={connector} onReview={() => setReviewing(true)} />
          <SettingsGroup label="Ajustes">
            <SettingsRow
              title="Somente leitura"
              description="Só as ferramentas de leitura são oferecidas aos bots; as outras nem aparecem para o modelo."
              control={
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
              }
            />
            <SettingsRow
              title="Confiar nas dicas do servidor"
              description="Ligado, uma ferramenta que o servidor diz que só lê passa a rodar sem cartão. O servidor é um programa que você não escreveu: só ligue se confia nele. Uma dica de “destrutiva” nunca é ignorada."
              control={
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
              }
            />
          </SettingsGroup>
          {(scope.error ?? trust.error) !== undefined && (
            <p className="ui-field__error" role="alert">
              {scope.error ?? trust.error}
            </p>
          )}
          {connector.secretNames.length > 0 && (
            <p className="sgroup__hint">
              Usa os segredos do cofre:{" "}
              <span className="mono">{connector.secretNames.join(", ")}</span>
            </p>
          )}
          <ConnectorNetwork connector={connector} />
          <ToolHistory connector={connector} />
          <SettingsGroup label="Ferramentas" hint={READ_WARNING}>
            {connector.tools === null ? (
              <SettingsRow
                title="Ainda não listado"
                description="Use “Testar” para o servidor listar as ferramentas."
              />
            ) : available.length === 0 ? (
              <SettingsRow title="Nenhuma ferramenta é oferecida aos bots" />
            ) : (
              <ul className="sroot-list" data-testid="connector-tools">
                {available.map((tool) => (
                  <ToolRow key={tool.name} connector={connector} tool={tool} />
                ))}
              </ul>
            )}
          </SettingsGroup>
          {unavailable.length > 0 && (
            <SettingsGroup label="Não oferecidas aos bots">
              <ul className="sroot-list" data-testid="connector-tools-unavailable">
                {unavailable.map((tool) => (
                  <ToolRow key={tool.name} connector={connector} tool={tool} />
                ))}
              </ul>
            </SettingsGroup>
          )}
        </div>
      </div>
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
                onClick={() =>
                  void removal
                    .run(() => sync.deleteConnector(connector.name))
                    .then((ok) => ok && onBack())
                }
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
    </div>
  );
}

// ----------------------------------------------------------------- the section

/** MCP connectors: external servers whose tools a bot can use, once you give it the connector. */
export function ConnectorsSettings({ title, titleId, onClose }: SectionProps) {
  const { sync, api } = useServices();
  const byName = useData((s) => s.connectors);
  const loaded = useData((s) => s.connectorsLoaded);
  const connectors = useMemo(() => orderedConnectors({ connectors: byName }), [byName]);
  const [adding, setAdding] = useState(false);
  const [newSecret, setNewSecret] = useState(false);
  const [enabling, setEnabling] = useState<Connector | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const enable = useTask();

  useEffect(() => {
    void sync.loadConnectors();
    void sync.loadVault();
  }, [sync]);

  const current = selected === null ? undefined : byName[selected];
  return (
    <>
      {current !== undefined ? (
        <ConnectorDetail
          connector={current}
          titleId={titleId}
          onBack={() => setSelected(null)}
          onClose={onClose}
          onAskEnable={setEnabling}
        />
      ) : (
        <>
          <PaneHead title={title} titleId={titleId} onClose={onClose}>
            <Pill
              tone="primary"
              className="spill"
              data-testid="connector-new"
              onClick={() => setAdding(true)}
            >
              Adicionar conector
            </Pill>
          </PaneHead>
          <div className="spane__body" data-testid="connectors-card">
            {!loaded ? (
              <p className="sempty">Carregando…</p>
            ) : connectors.length === 0 ? (
              <p className="sempty">
                Nenhum conector. Adicione um servidor MCP, dê a um bot e veja as ferramentas dele
                aqui.
              </p>
            ) : (
              <SettingsGroup hint="Um conector liga um servidor externo (MCP) aos seus bots. Cada ferramenta pede um cartão de aprovação antes de rodar, a não ser que você diga o contrário.">
                <div className="sroot-list" data-testid="connector-list">
                  {connectors.map((c) => (
                    <ConnectorRow
                      key={c.name}
                      connector={c}
                      onOpen={() => setSelected(c.name)}
                      onAskEnable={setEnabling}
                    />
                  ))}
                </div>
              </SettingsGroup>
            )}
          </div>
        </>
      )}
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
