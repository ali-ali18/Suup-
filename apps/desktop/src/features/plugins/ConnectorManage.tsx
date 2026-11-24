import type { Connector, ConnectorTest, ConnectorTool, RiskLevel } from "@suup/api";
import { Ban, Power, SlidersHorizontal, Trash2, Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import { useServices } from "../../app/context.js";
import { LEVEL_LABEL, LEVELS } from "../../data/approval-text.js";
import {
  parseRecipientFields,
  READ_WARNING,
  RISK_BASIS_TEXT,
  STDIO_WARNING,
  TIGHTENED_HELP,
} from "../../lib/connector-form.js";
import { cx } from "../../lib/cx.js";
import { friendlyError } from "../../lib/friendly-error.js";
import { RUNS_IN_LABEL } from "../../lib/network.js";
import { reviewNotice } from "../../lib/tool-review.js";
import { Dropdown, type DropdownOption } from "../../ui/dropdown.js";
import {
  Dialog,
  FieldError,
  fieldControlClass,
  Notice,
  Pill,
  PlainText,
  Tag,
  Toggle,
} from "../../ui/primitives.js";
import { ConnectorGrants } from "../settings/ConnectorGrants.js";
import { ConnectorNetwork } from "../settings/ConnectorNetwork.js";
import {
  RowAction,
  RowValue,
  SettingsCard,
  SettingsFold,
  SettingsGroup,
  SettingsHint,
  SettingsList,
  SettingsRow,
  SettingsStack,
} from "../settings/parts.js";
import { ReviewDialog, ToolHistory } from "../settings/ToolReview.js";
import { useTask } from "../settings/use-task.js";

const RISK_OPTIONS: readonly DropdownOption<RiskLevel | "">[] = [
  { value: "", label: "Padrão (pergunta antes)" },
  ...LEVELS.map((level) => ({ value: level, label: LEVEL_LABEL[level] })),
];

export const KIND_LABEL = { stdio: "Programa neste computador", http: "Servidor HTTP" } as const;

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
        description="Só você marca isto: o cartão desta ferramenta passa a ter “Enviar” e o menu do destinatário."
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
              className={fieldControlClass({ size: "sm" })}
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
    <li data-testid="connector-tool" data-tool={tool.tool} data-available={tool.available}>
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
            <RowValue>
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
            </RowValue>
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
        <SettingsFold>
          {/* The registered name (`conn_<connector>__<tool>`) is internal: the Inspector has it. */}
          {tool.description !== "" && (
            <blockquote
              className="m-0 flex flex-col items-start gap-1 border-l-2 border-border-strong pl-3 text-small text-text-muted"
              data-testid="tool-description"
            >
              <Tag tone="outline">escrito pelo servidor</Tag>
              <PlainText>{tool.description}</PlainText>
            </blockquote>
          )}
          {tool.available ? (
            <>
              <SettingsHint data-testid="tool-basis">
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
              </SettingsHint>
              {tool.riskBasis === "tightened_by_hint" && (
                <Notice role="note">{TIGHTENED_HELP}</Notice>
              )}
              <SettingsCard>
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
              </SettingsCard>
              {task.error !== undefined && <FieldError>{task.error}</FieldError>}
            </>
          ) : (
            <SettingsHint data-testid="tool-unavailable-reason">
              Não é oferecida aos bots: {tool.reason ?? "motivo não informado"}.
            </SettingsHint>
          )}
        </SettingsFold>
      )}
    </li>
  );
}

/** Why the tools are not listed, in one plain sentence (never the server's own log line). */
function unlistedReason(connector: Connector, why: string | undefined): string {
  if (why !== undefined) return why;
  if (!connector.enabled) return "O plugin está desligado: ligue para eu ver as ferramentas.";
  if (connector.discovery.lastError !== null)
    return "O servidor do plugin não respondeu agora. Confira o login ou o token e tente de novo.";
  return "Ainda não tentei listar as ferramentas.";
}

/**
 * Everything one connector offers, on ITS page (owner, 24/11/2026: nothing is managed inline in the
 * settings any more): turning it on or off, testing it, the bots that use it and which tools each
 * one may use, its settings, network, history, tools and their risks, and removing it. Two states
 * are said plainly and can be acted on: no bot uses it yet, and its tools are not listed.
 * `reason`: a plain sentence about why it is not working yet (the page knows its login state).
 */
export function ConnectorManage({
  connector,
  reason,
  onRemoved,
}: {
  connector: Connector;
  reason?: string | undefined;
  onRemoved(): void;
}) {
  const { sync, api } = useServices();
  const [test, setTest] = useState<ConnectorTest | undefined>(undefined);
  const [removing, setRemoving] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const toggling = useTask();
  const scope = useTask();
  const trust = useTask();
  const testing = useTask();
  const removal = useTask();
  const enable = useTask();
  // The page may open from a link: make sure the connectors are in the store.
  useEffect(() => {
    void sync.loadConnectors();
  }, [sync]);
  const available = (connector.tools ?? []).filter((t) => t.available);
  const unavailable = (connector.tools ?? []).filter((t) => !t.available);
  const lastError = connector.discovery.lastError;
  const notice = reviewNotice(connector);
  const withAccess = connector.grants.filter((g) => g.all || g.tools.length > 0).length;
  const testLine =
    test === undefined
      ? undefined
      : test.ok
        ? `Funcionou: ${test.tools.length} ${test.tools.length === 1 ? "ferramenta" : "ferramentas"}.`
        : // The server's error is a log line (docs/DESIGN.md, "Amigável"): the Inspector and the
          // logs keep it.
          "Não deu para falar com o conector agora. Tenta de novo?";
  const runTest = () =>
    void testing.run(async () => {
      try {
        setTest(await api.connectors.test(connector.name));
        void sync.loadConnectors();
        return { ok: true };
      } catch (error) {
        return { ok: false, message: friendlyError(error) };
      }
    });
  const turn = (next: boolean) => {
    if (next && connector.transport.kind === "stdio") return setEnabling(true);
    void toggling.run(async () => {
      const result = await sync.connectorCall(() =>
        api.connectors.update(connector.name, { enabled: next }),
      );
      return result.ok ? { ok: true } : { ok: false, message: result.message };
    });
  };
  const chooseBots = () =>
    document
      .getElementById("plugin-grants")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div
      className="flex flex-col gap-5"
      data-testid="connector-row"
      data-name={connector.name}
      data-enabled={connector.enabled}
    >
      <SettingsGroup label={`Ajustes de ${connector.name}`} icon={Power}>
        <SettingsRow
          icon={Power}
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
              onChange={turn}
            />
          }
        />
        <SettingsRow
          title="Testar a conexão"
          descriptionTestId="connector-health"
          description={
            lastError !== null
              ? "Não está respondendo agora."
              : connector.tools === null
                ? "Teste para ver as ferramentas."
                : `${available.length} ${available.length === 1 ? "ferramenta oferecida" : "ferramentas oferecidas"}`
          }
          control={
            <RowAction disabled={testing.busy} data-testid="connector-test" onClick={runTest}>
              {testing.busy ? "Testando…" : "Testar"}
            </RowAction>
          }
        />
        {withAccess === 0 && (
          <SettingsRow
            title="Nenhum bot usa este plugin ainda"
            description="Escolha quais bots podem usar as ferramentas dele."
            testId="plugin-no-bots"
            role="status"
            control={
              <RowAction data-testid="plugin-choose-bots" onClick={chooseBots}>
                Escolher os bots
              </RowAction>
            }
          />
        )}
        {connector.tools === null && (
          <SettingsRow
            title="Ainda não consegui ver as ferramentas"
            description={unlistedReason(connector, reason)}
            testId="plugin-unlisted"
            role="status"
            control={
              <RowAction disabled={testing.busy} data-testid="plugin-retry" onClick={runTest}>
                {testing.busy ? "Tentando…" : "Tentar de novo"}
              </RowAction>
            }
          />
        )}
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
        <FieldError>{toggling.error ?? testing.error}</FieldError>
      )}
      {testLine !== undefined && test !== undefined && (
        <p
          className={cx("text-small", !test.ok && "text-danger-text")}
          role="status"
          data-testid="connector-test-result"
          data-ok={test.ok}
        >
          {testLine}
        </p>
      )}
      <SettingsStack data-testid="connector-panel">
        <div id="plugin-grants" className="scroll-mt-4">
          <ConnectorGrants connector={connector} onReview={() => setReviewing(true)} />
        </div>
        <SettingsGroup label="Ajustes" icon={SlidersHorizontal}>
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
            description="Ligado, o que o servidor diz que só lê roda sem cartão; só ligue se confia nele."
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
          <FieldError>{scope.error ?? trust.error}</FieldError>
        )}
        {connector.secretNames.length > 0 && (
          <SettingsHint>
            Usa os segredos do cofre:{" "}
            <span className="font-mono text-code">{connector.secretNames.join(", ")}</span>
          </SettingsHint>
        )}
        <ConnectorNetwork connector={connector} />
        <ToolHistory connector={connector} />
        <SettingsGroup label="Ferramentas" icon={Wrench} hint={READ_WARNING}>
          {connector.tools === null ? (
            <SettingsRow
              title="Ainda não listado"
              description="Use “Tentar de novo” para o servidor listar as ferramentas."
            />
          ) : available.length === 0 ? (
            <SettingsRow title="Nenhuma ferramenta é oferecida aos bots" />
          ) : (
            <SettingsList as="ul" data-testid="connector-tools">
              {available.map((tool) => (
                <ToolRow key={tool.name} connector={connector} tool={tool} />
              ))}
            </SettingsList>
          )}
        </SettingsGroup>
        {unavailable.length > 0 && (
          <SettingsGroup label="Não oferecidas aos bots" icon={Ban}>
            <SettingsList as="ul" data-testid="connector-tools-unavailable">
              {unavailable.map((tool) => (
                <ToolRow key={tool.name} connector={connector} tool={tool} />
              ))}
            </SettingsList>
          </SettingsGroup>
        )}
        <SettingsGroup>
          <SettingsRow
            icon={Trash2}
            title="Remover o plugin"
            description="Os bots deixam de ter as ferramentas dele. Os segredos do cofre continuam guardados."
            control={
              <RowAction danger data-testid="connector-delete" onClick={() => setRemoving(true)}>
                Remover
              </RowAction>
            }
          />
        </SettingsGroup>
      </SettingsStack>
      {reviewing && <ReviewDialog connector={connector} onClose={() => setReviewing(false)} />}
      {enabling && (
        <Dialog
          title={`Ligar o conector ${connector.name}?`}
          onClose={() => setEnabling(false)}
          footer={
            <>
              <Pill tone="secondary" onClick={() => setEnabling(false)} disabled={enable.busy}>
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
                        api.connectors.update(connector.name, { enabled: true }),
                      );
                      return result.ok ? { ok: true } : { ok: false, message: result.message };
                    })
                    .then((ok) => ok && setEnabling(false))
                }
              >
                {enable.busy ? "Ligando…" : "Ligar mesmo assim"}
              </Pill>
            </>
          }
        >
          <Notice role="note" data-testid="connector-enable-warning">
            <strong>Isto roda um programa</strong>
            <p>{STDIO_WARNING}</p>
          </Notice>
          <p className="font-mono text-code leading-small wrap-anywhere whitespace-pre-wrap">
            {connector.transport.kind === "stdio" &&
              [connector.transport.command, ...(connector.transport.args ?? [])].join(" ")}
          </p>
          {enable.error !== undefined && <FieldError>{enable.error}</FieldError>}
        </Dialog>
      )}
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
                    .then((ok) => ok && onRemoved())
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
          {removal.error !== undefined && <FieldError>{removal.error}</FieldError>}
        </Dialog>
      )}
    </div>
  );
}
