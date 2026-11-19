import type { ApprovalRule } from "@suup/api";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { RULE_PRECEDENCE, ruleSentence } from "../../data/approval-text.js";
import { orderedRules } from "../../data/reducers.js";
import { Dialog, Pill } from "../../ui/primitives.js";
import { PaneHead, type SectionProps, SettingsGroup, SettingsRow } from "./parts.js";
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
    <li key={rule.id} className="srow" data-testid="rule-row" data-effect={rule.effect}>
      <div className="srow__text">
        <span className="srow__title" data-testid="rule-sentence">
          {ruleSentence(rule, {
            botName: rule.botId === null ? undefined : bots[rule.botId]?.name,
            connectors,
          })}
        </span>
        {!rule.enabled && (
          <span className="srow__desc" data-testid="rule-disabled-reason">
            Desativada: {rule.disabledReason}
          </span>
        )}
        {rule.note !== null && rule.note !== "" && <span className="srow__desc">{rule.note}</span>}
      </div>
      <div className="srow__control">
        <Pill
          tone="ghost"
          className="spill spill--ghost"
          data-testid="rule-edit"
          onClick={() => setEditing({ rule, effect: rule.effect })}
        >
          Editar
        </Pill>
        <Pill
          tone="ghost"
          className="spill spill--ghost"
          data-testid="rule-delete"
          onClick={() => setDeleting(rule)}
        >
          Remover
        </Pill>
      </div>
    </li>
  );

  return (
    <>
      <PaneHead title={title} titleId={titleId} onClose={onClose} />
      <div className="spane__body">
        <SettingsGroup>
          <SettingsRow
            title="Aprovações"
            description="Leitura e escrita reversível rodam sozinhas; o que sai para o mundo ou não tem volta espera o seu cartão."
            control={
              <span className="srow__value" data-testid="approval-mode">
                Por nível de risco
              </span>
            }
          />
        </SettingsGroup>
        <div className="sgroup" data-testid="rules-card">
          {kinds.map((kind) => {
            const mine = rules.filter((r) => r.effect === kind.effect);
            return (
              <div key={kind.effect} data-testid={`rules-${kind.effect}`}>
                <div className="srow srow--bare">
                  <div className="srow__text">
                    <span className="srow__title">{kind.title}</span>
                    <span className="srow__desc">{kind.description}</span>
                  </div>
                  <div className="srow__control">
                    <Pill
                      tone="secondary"
                      className="spill"
                      data-testid={`rule-new-${kind.effect}`}
                      onClick={() => setEditing({ rule: undefined, effect: kind.effect })}
                    >
                      Adicionar regra
                    </Pill>
                  </div>
                </div>
                {!rulesLoaded ? (
                  <p className="slist__empty">Carregando…</p>
                ) : (
                  mine.length > 0 && (
                    <ul className="slist" data-testid="rule-list">
                      {mine.map(ruleLine)}
                    </ul>
                  )
                )}
              </div>
            );
          })}
          <p className="sgroup__hint">{RULE_PRECEDENCE}</p>
        </div>
        <SettingsGroup>
          <SettingsRow
            title="Permissões dos conectores"
            description="Você escolhe quais ferramentas de cada conector cada bot pode usar; as que o servidor mudou esperam a sua revisão."
            control={
              <Pill
                tone="secondary"
                className="spill"
                data-testid="open-connectors"
                onClick={() => setTab("connectors")}
              >
                Abrir conectores
              </Pill>
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
