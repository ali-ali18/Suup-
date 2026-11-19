import type { ApprovalRule, ArgMatcher, ToolInfo } from "@suup/api";
import { Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { useSettings } from "../../app/settings-store.js";
import {
  EFFECT_LABEL,
  RULE_PRECEDENCE,
  ruleSentence,
  toolTitle,
} from "../../data/approval-text.js";
import { orderedRules, pendingApprovals } from "../../data/reducers.js";
import type { Settings } from "../../lib/settings.js";
import { Card, Dialog, EmptyState, Pill, Tag, TextField } from "../../ui/primitives.js";
import { ApprovalRow } from "../chat/ApprovalRows.js";
import { useTask } from "./use-task.js";

interface Draft {
  effect: "allow" | "deny";
  botId: string;
  tool: string;
  matchers: (ArgMatcher & { id: number })[];
  note: string;
}

let draftRow = 0;
const withId = (m: ArgMatcher) => ({ ...m, id: ++draftRow });

function draftOf(rule: ApprovalRule | undefined): Draft {
  return rule === undefined
    ? { effect: "allow", botId: "", tool: "*", matchers: [], note: "" }
    : {
        effect: rule.effect,
        botId: rule.botId ?? "",
        tool: rule.tool,
        matchers: rule.matchers.map(withId),
        note: rule.note ?? "",
      };
}

/** The tools a rule can name: the built-in ones, and the tools of the connectors (by registered name). */
function useToolChoices(): { value: string; label: string }[] {
  const { api } = useServices();
  const connectorsByName = useData((s) => s.connectors);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  useEffect(() => {
    api.tools.list().then(
      (list) => setTools(list.items),
      () => setTools([]),
    );
  }, [api]);
  return useMemo(() => {
    const connectors = Object.values(connectorsByName);
    return [
      { value: "*", label: "Qualquer ferramenta" },
      ...tools.map((t) => ({ value: t.name, label: `${toolTitle(t.name)} (${t.name})` })),
      ...connectors.flatMap((c) =>
        (c.tools ?? []).map((t) => ({
          value: t.name,
          label: `Conector ${c.name} → ${t.tool}`,
        })),
      ),
    ];
  }, [tools, connectorsByName]);
}

function RuleDialog({ rule, onClose }: { rule: ApprovalRule | undefined; onClose(): void }) {
  const { sync, api } = useServices();
  const bots = useData((s) => s.bots);
  const connectorsByName = useData((s) => s.connectors);
  const connectors = useMemo(() => Object.values(connectorsByName), [connectorsByName]);
  const choices = useToolChoices();
  const [draft, setDraft] = useState<Draft>(() => draftOf(rule));
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const task = useTask();
  const editing = rule !== undefined;
  const disabled = rule !== undefined && !rule.enabled;
  const botName = draft.botId === "" ? undefined : bots[draft.botId]?.name;
  const matchers: ArgMatcher[] = draft.matchers.map(({ field, value }) => ({ field, value }));
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setMatcher = (id: number, patch: Partial<ArgMatcher>) =>
    set({ matchers: draft.matchers.map((m) => (m.id === id ? { ...m, ...patch } : m)) });

  const save = async () => {
    if (matchers.some((m) => m.field.trim() === "")) {
      setProblem("Cada condição precisa dizer qual campo olhar (por exemplo, command).");
      return;
    }
    if (disabled && matchers.length === 0) {
      setProblem(
        "Esta regra foi desativada. Para ativá-la, diga ao menos uma condição exata (sem condições ela valeria para qualquer uso da ferramenta).",
      );
      return;
    }
    setProblem(undefined);
    const clean = matchers.map((m) => ({ ...m, field: m.field.trim() }));
    const note = draft.note.trim();
    const ok = await task.run(() =>
      editing
        ? sync.ruleCall(() =>
            api.rules.update(rule.id, {
              effect: draft.effect,
              matchers: clean,
              note: note === "" ? null : note,
              ...(disabled ? { enabled: true } : {}),
            }),
          )
        : sync.ruleCall(() =>
            api.rules.create({
              tool: draft.tool,
              effect: draft.effect,
              botId: draft.botId === "" ? null : draft.botId,
              matchers: clean,
              ...(note === "" ? {} : { note }),
            }),
          ),
    );
    if (ok) onClose();
  };

  return (
    <Dialog
      title={editing ? "Editar regra" : "Nova regra"}
      onClose={onClose}
      wide
      footer={
        <>
          <Pill tone="secondary" onClick={onClose} disabled={task.busy}>
            Cancelar
          </Pill>
          <Pill
            tone="primary"
            onClick={() => void save()}
            disabled={task.busy}
            data-testid="rule-save"
          >
            {task.busy ? "Salvando…" : disabled ? "Salvar e ativar" : "Salvar regra"}
          </Pill>
        </>
      }
    >
      <div className="form" data-testid="rule-form">
        {disabled && (
          <div className="ui-notice" data-testid="rule-disabled-notice">
            <strong>Regra desativada</strong>
            <p className="wrap">{rule.disabledReason}</p>
          </div>
        )}
        <div className="form__row">
          <span className="ui-field__label" id="rule-effect">
            O que a regra faz
          </span>
          <div className="settings__row" role="radiogroup" aria-labelledby="rule-effect">
            {(["allow", "deny"] as const).map((effect) => (
              <Pill
                key={effect}
                tone={draft.effect === effect ? "primary" : "secondary"}
                role="radio"
                aria-checked={draft.effect === effect}
                data-testid={`rule-effect-${effect}`}
                onClick={() => set({ effect })}
              >
                {effect === "allow" ? "Liberar (roda sem perguntar)" : "Proibir (nunca roda)"}
              </Pill>
            ))}
          </div>
          <p className="ui-field__hint">{RULE_PRECEDENCE}</p>
        </div>
        <div className="form__row">
          <label className="ui-field__label" htmlFor="rule-bot">
            De quem
          </label>
          {editing ? (
            <p>
              {rule.botId === null ? "Todos os bots" : (bots[rule.botId]?.name ?? "Bot removido")}
            </p>
          ) : (
            <select
              id="rule-bot"
              className="ui-field__control"
              value={draft.botId}
              data-testid="rule-bot"
              onChange={(e) => set({ botId: e.target.value })}
            >
              <option value="">Todos os bots</option>
              {sortedBots(bots).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="form__row">
          <label className="ui-field__label" htmlFor="rule-tool">
            Ferramenta
          </label>
          {editing ? (
            <p>{toolTitle(rule.tool, connectors)}</p>
          ) : (
            <select
              id="rule-tool"
              className="ui-field__control"
              value={draft.tool}
              data-testid="rule-tool"
              onChange={(e) => set({ tool: e.target.value })}
            >
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="form__row">
          <span className="ui-field__label">Condições (todas precisam valer)</span>
          {draft.matchers.length === 0 && (
            <p className="ui-field__hint" data-testid="rule-any-use">
              Sem condições, a regra vale para <strong>qualquer uso</strong> desta ferramenta, com
              quaisquer argumentos. É uma escolha sua; para limitar, adicione uma condição.
            </p>
          )}
          {draft.matchers.map((m) => (
            <div key={m.id} className="cond-row" data-testid="rule-condition">
              <input
                className="ui-field__control"
                aria-label="Campo dos argumentos (ex.: command)"
                placeholder="campo, ex.: command"
                value={m.field}
                onChange={(e) => setMatcher(m.id, { field: e.target.value })}
              />
              <span className="cond-row__is" aria-hidden="true">
                é exatamente
              </span>
              <input
                className="ui-field__control"
                aria-label="Valor exato"
                placeholder="valor"
                value={m.value}
                onChange={(e) => setMatcher(m.id, { value: e.target.value })}
              />
              <button
                type="button"
                className="ui-icon-button"
                aria-label="Remover a condição"
                onClick={() => set({ matchers: draft.matchers.filter((x) => x.id !== m.id) })}
              >
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          ))}
          <div>
            <Pill
              tone="ghost"
              icon={<Plus size={16} aria-hidden="true" />}
              onClick={() =>
                set({
                  matchers: [...draft.matchers, withId({ field: "", value: "" })],
                })
              }
            >
              Adicionar condição
            </Pill>
          </div>
          <p className="ui-field__hint">
            O campo é o nome de um argumento da chamada (<code>command</code>, <code>path</code>,{" "}
            <code>url</code>...); use pontos para entrar num objeto (<code>options.branch</code>). A
            comparação é sempre <strong>exatamente igual</strong>: não existe “começa com”, “contém”
            nem padrão.
          </p>
        </div>
        <TextField
          label="Anotação (opcional)"
          value={draft.note}
          onChange={(note) => set({ note })}
          hint="Para você lembrar por que a regra existe."
        />
        <div className="ui-notice" data-testid="rule-preview" aria-live="polite">
          <strong>O que a regra vai fazer</strong>
          <p>
            {ruleSentence(
              {
                effect: draft.effect,
                tool: draft.tool,
                botId: draft.botId === "" ? null : draft.botId,
                matchers,
              },
              { botName, connectors },
            )}
          </p>
        </div>
        {(problem ?? task.error) !== undefined && (
          <p className="ui-field__error" role="alert" data-testid="rule-error">
            {problem ?? task.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function BehaviourRow<K extends keyof Settings>({
  setting,
  label,
  hint,
  options,
}: {
  setting: K;
  label: string;
  hint?: string;
  options: readonly (readonly [Settings[K], string])[];
}) {
  const value = useSettings((s) => s.settings[setting]);
  const update = useSettings((s) => s.update);
  const id = `setting-${String(setting)}`;
  return (
    <div className="settings__setting">
      <div className="settings__setting-text">
        <span id={id}>{label}</span>
        {hint !== undefined && <span className="muted small">{hint}</span>}
      </div>
      <div className="settings__row" role="radiogroup" aria-labelledby={id}>
        {options.map(([v, text]) => (
          <Pill
            key={String(v)}
            tone={value === v ? "primary" : "secondary"}
            role="radio"
            aria-checked={value === v}
            data-testid={`setting-${String(setting)}-${String(v)}`}
            onClick={() => update({ [setting]: v } as Partial<Settings>)}
          >
            {text}
          </Pill>
        ))}
      </div>
    </div>
  );
}

/** The cards waiting for you, the permanent rules, and how the cards behave on this computer. */
export function ApprovalsSettings() {
  const { sync } = useServices();
  const bots = useData((s) => s.bots);
  const approvals = useData((s) => s.approvals);
  const rulesById = useData((s) => s.rules);
  const rulesLoaded = useData((s) => s.rulesLoaded);
  const connectorsByName = useData((s) => s.connectors);
  const rules = useMemo(() => orderedRules({ rules: rulesById }), [rulesById]);
  const connectors = useMemo(() => Object.values(connectorsByName), [connectorsByName]);
  const waiting = useMemo(() => pendingApprovals({ approvals, bots }), [approvals, bots]);
  const [editing, setEditing] = useState<ApprovalRule | "new" | null>(null);
  const [deleting, setDeleting] = useState<ApprovalRule | null>(null);
  const [clicked, setClicked] = useState<ReadonlySet<string>>(new Set());
  const removal = useTask();
  const toggle = useCallback(
    (key: string) =>
      setClicked((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    [],
  );

  // The rules have no stream frame: read them (and the connectors, for the names of their tools) when the section opens.
  useEffect(() => {
    void sync.loadRules();
    void sync.loadPendingApprovals();
    void sync.loadConnectors();
  }, [sync]);

  return (
    <>
      <Card aria-label="Esperando você" data-testid="settings-pending-approvals">
        <h2 className="section-label">Esperando você</h2>
        {waiting.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck size={16} />}
            title="Nenhuma aprovação esperando"
            text="Quando um bot precisar da sua permissão, o cartão aparece aqui e na conversa."
          />
        ) : (
          <div className="ui-actions">
            {waiting.map((card) => (
              <ApprovalRow key={card.id} approval={card} clicked={clicked} onToggle={toggle} />
            ))}
          </div>
        )}
      </Card>
      <Card aria-label="Regras" data-testid="rules-card">
        <div className="row-between">
          <h2 className="section-label">Regras permanentes</h2>
          <Pill
            tone="secondary"
            icon={<Plus size={16} aria-hidden="true" />}
            data-testid="rule-new"
            onClick={() => setEditing("new")}
          >
            Nova regra
          </Pill>
        </div>
        <p className="muted small">
          {RULE_PRECEDENCE} Uma regra casa só quando os argumentos que ela nomeia são{" "}
          <strong>exatamente iguais</strong>; sem condições, vale para <strong>qualquer uso</strong>{" "}
          da ferramenta. Sem regra, o nível da ferramenta decide: leitura e escrita reversível
          rodam; o que sai para o mundo pede cartão.
        </p>
        {!rulesLoaded ? (
          <p className="muted">Carregando…</p>
        ) : rules.length === 0 ? (
          <EmptyState
            title="Nenhuma regra"
            text="Uma regra só nasce de um ato seu: aqui, no terminal (suup rules) ou, numa mensagem para outra pessoa, em “Permitir destinatário”."
          />
        ) : (
          <ul className="rule-list" data-testid="rule-list">
            {rules.map((rule) => (
              <li
                key={rule.id}
                className="rule-row"
                data-testid="rule-row"
                data-effect={rule.effect}
              >
                <div className="rule-row__main">
                  <div className="inline-tags">
                    <Tag tone={rule.effect === "deny" ? "danger" : "neutral"}>
                      {EFFECT_LABEL[rule.effect]}
                    </Tag>
                    {rule.botId === null ? (
                      <Tag tone="outline">Todos os bots</Tag>
                    ) : (
                      <Tag tone="outline">{bots[rule.botId]?.name ?? "Bot removido"}</Tag>
                    )}
                    {rule.createdBy === "approval" && <Tag tone="outline">Criada num cartão</Tag>}
                    {!rule.enabled && <Tag tone="danger">Desativada</Tag>}
                  </div>
                  <p className="wrap" data-testid="rule-sentence">
                    {ruleSentence(rule, {
                      botName: rule.botId === null ? undefined : bots[rule.botId]?.name,
                      connectors,
                    })}
                  </p>
                  {!rule.enabled && (
                    <p className="small wrap" data-testid="rule-disabled-reason">
                      {rule.disabledReason}
                    </p>
                  )}
                  {rule.note !== null && rule.note !== "" && (
                    <p className="muted small wrap">{rule.note}</p>
                  )}
                </div>
                <div className="rule-row__actions">
                  <Pill tone="secondary" onClick={() => setEditing(rule)} data-testid="rule-edit">
                    Editar
                  </Pill>
                  <Pill tone="danger" onClick={() => setDeleting(rule)} data-testid="rule-delete">
                    Apagar
                  </Pill>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card aria-label="Cartões" data-testid="approval-behaviour">
        <h2 className="section-label">Como os cartões se comportam</h2>
        <p className="muted small">Fica guardado neste computador.</p>
        <BehaviourRow
          setting="approvalResolved"
          label="Cartões já decididos"
          hint="Uma linha que abre ao clicar, ou já abertos."
          options={[
            ["collapsed", "Recolhidos"],
            ["open", "Abertos"],
          ]}
        />
        <BehaviourRow
          setting="approvalLong"
          label="Conteúdo longo de um cartão"
          hint="O que vai rodar aparece sempre; o que passa de oito linhas pode ficar recolhido."
          options={[
            ["collapse", "Recolher"],
            ["full", "Mostrar tudo"],
          ]}
        />
        <BehaviourRow
          setting="notifyApprovals"
          label="Avisar quando um bot pedir aprovação"
          hint="Notificação do sistema, só com a janela sem foco."
          options={[
            ["on", "Avisar"],
            ["off", "Não avisar"],
          ]}
        />
      </Card>
      {editing !== null && (
        <RuleDialog
          rule={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting !== null && (
        <Dialog
          title="Apagar a regra?"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <Pill tone="secondary" onClick={() => setDeleting(null)} disabled={removal.busy}>
                Cancelar
              </Pill>
              <Pill
                tone="danger"
                disabled={removal.busy}
                data-testid="rule-delete-confirm"
                onClick={() =>
                  void removal
                    .run(() => sync.deleteRule(deleting.id))
                    .then((ok) => ok && setDeleting(null))
                }
              >
                {removal.busy ? "Apagando…" : "Apagar"}
              </Pill>
            </>
          }
        >
          <p className="wrap">
            {ruleSentence(deleting, {
              botName: deleting.botId === null ? undefined : bots[deleting.botId]?.name,
              connectors,
            })}
          </p>
          <p className="muted small">
            Depois de apagada, as próximas chamadas voltam a seguir o nível da ferramenta: o que sai
            para o mundo volta a pedir cartão.
          </p>
          {removal.error !== undefined && (
            <p className="ui-field__error" role="alert">
              {removal.error}
            </p>
          )}
        </Dialog>
      )}
    </>
  );
}
