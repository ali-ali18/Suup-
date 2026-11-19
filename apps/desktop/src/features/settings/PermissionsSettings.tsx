import type { ApprovalRule } from "@suup/api";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { RULE_PRECEDENCE, ruleSentence } from "../../data/approval-text.js";
import { orderedRules } from "../../data/reducers.js";
import { Dialog, Pill } from "../../ui/primitives.js";
import { PaneHead, RowAction, type SectionProps, SettingsGroup, SettingsRow } from "./parts.js";
import { RuleDialog } from "./RuleDialog.js";
import { useTask } from "./use-task.js";

/**
 * Permissões, as small as it can be: how approvals work (one card), the two kinds of rule with
 * "Adicionar regra", and the way to the connectors' tool permissions. Pending cards live in
 * Pendências and in the chat, how the cards behave is in Geral.
 */
export function PermissionsSettings({ title, titleId, onClose }: SectionProps) {
  const { sync } = useServices();
  const bots = useData((s) => s.bots);
  const rulesById = useData((s) => s.rules);
  const rulesLoaded = useData((s) => s.rulesLoaded);
  const connectorsByName = useData((s) => s.connectors);
  const setTab = useUi((s) => s.setSettingsTab);
  const rules = useMemo(() => orderedRules({ rules: rulesById }), [rulesById]);
  const connectors = useMemo(() => Object.values(connectorsByName), [connectorsByName]);
  const [editing, setEditing] = useState<{
    rule: ApprovalRule | undefined;
    effect: "allow" | "deny";
  } | null>(null);
  const [deleting, setDeleting] = useState<ApprovalRule | null>(null);
  const removal = useTask();

  // The rules have no stream frame: read them (and the connectors, for the names of their tools) when the section opens.
  useEffect(() => {
    void sync.loadRules();
    void sync.loadConnectors();
  }, [sync]);

  const kinds: {
    effect: "allow" | "deny";
    title: string;
    description: string;
  }[] = [
    {
      effect: "deny",
      title: "Nunca permitir",
      description:
        "Nunca roda quando a ação corresponde a estas regras. Vale mais que as de permitir.",
    },
    {
      effect: "allow",
      title: "Permitir sem perguntar",
      description: "Roda sozinha quando a ação corresponde a estas regras.",
    },
  ];

  const ruleLine = (rule: ApprovalRule): ReactNode => (
    <div key={rule.id} data-testid="rule-row" data-effect={rule.effect}>
      <SettingsRow
        title={ruleSentence(rule, {
          botName: rule.botId === null ? undefined : bots[rule.botId]?.name,
          connectors,
        })}
        titleTestId="rule-sentence"
        description={
          <>
            {!rule.enabled && (
              <span className="srow__line" data-testid="rule-disabled-reason">
                Desativada: {rule.disabledReason}
              </span>
            )}
            {rule.note !== null && rule.note !== "" && (
              <span className="srow__line">{rule.note}</span>
            )}
          </>
        }
        control={
          <>
            <RowAction
              data-testid="rule-edit"
              onClick={() => setEditing({ rule, effect: rule.effect })}
            >
              Editar
            </RowAction>
            <RowAction danger data-testid="rule-delete" onClick={() => setDeleting(rule)}>
              Remover
            </RowAction>
          </>
        }
      />
    </div>
  );

  return (
    <>
      <PaneHead title={title} titleId={titleId} onClose={onClose} />
      <div className="spane__body">
        <SettingsGroup label="Aprovações">
          <SettingsRow
            title="Modo"
            description="Leitura e escrita reversível rodam sozinhas; o que sai para o mundo ou não tem volta espera o seu cartão."
            control={
              <span className="srow__value" data-testid="approval-mode">
                Por nível de risco
              </span>
            }
          />
        </SettingsGroup>
        <div className="sroot" data-testid="rules-card">
          {kinds.map((kind, index) => {
            const mine = rules.filter((r) => r.effect === kind.effect);
            return (
              <SettingsGroup
                key={kind.effect}
                label={kind.title}
                testId={`rules-${kind.effect}`}
                {...(index === kinds.length - 1 ? { hint: RULE_PRECEDENCE } : {})}
              >
                <SettingsRow
                  title="Regras"
                  description={kind.description}
                  control={
                    <RowAction
                      data-testid={`rule-new-${kind.effect}`}
                      onClick={() => setEditing({ rule: undefined, effect: kind.effect })}
                    >
                      Adicionar regra
                    </RowAction>
                  }
                />
                {!rulesLoaded ? <SettingsRow title="Carregando…" /> : mine.map(ruleLine)}
              </SettingsGroup>
            );
          })}
        </div>
        <SettingsGroup label="Conectores">
          <SettingsRow
            title="Permissões dos conectores"
            description="Você escolhe quais ferramentas de cada conector cada bot pode usar; as que o servidor mudou esperam a sua revisão."
            control={
              <RowAction data-testid="open-connectors" onClick={() => setTab("connectors")}>
                Abrir conectores
              </RowAction>
            }
          />
        </SettingsGroup>
      </div>
      {editing !== null && (
        <RuleDialog rule={editing.rule} effect={editing.effect} onClose={() => setEditing(null)} />
      )}
      {deleting !== null && (
        <Dialog
          title="Remover a regra?"
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
                {removal.busy ? "Removendo…" : "Remover"}
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
            Depois de removida, as próximas chamadas voltam a seguir o nível da ferramenta: o que
            sai para o mundo volta a pedir cartão.
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
