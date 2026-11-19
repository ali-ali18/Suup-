import type {
  ApprovalMode,
  ApprovalRule,
  ApprovalSettings,
  WrittenRule,
  WrittenRuleKind,
} from "@suup/api";
import { Ban, CircleCheck, CircleHelp, ListChecks, Plug, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { useUi } from "../../app/ui-store.js";
import { ruleSentence } from "../../data/approval-text.js";
import { orderedRules, writtenRulesOf } from "../../data/reducers.js";
import { messageOf } from "../../data/sync.js";
import { Dialog, FieldError, MutedText, Pill, PlainText, Toggle } from "../../ui/primitives.js";
import {
  PaneBody,
  PaneHead,
  RowAction,
  RowLine,
  type SectionProps,
  SettingsCard,
  SettingsGroup,
  SettingsRow,
  SettingsSelect,
} from "./parts.js";
import { useTask } from "./use-task.js";
import { KIND_TEXT, WrittenRuleDialog } from "./WrittenRuleDialog.js";

/** The two modes, as the owner names them. The description is the one line under the choice. */
const MODES: readonly { value: ApprovalMode; label: string; description: string }[] = [
  {
    value: "auto_review",
    label: "Auto-review",
    description: "Um modelo revisa cada ação com as suas regras e só pergunta quando precisa.",
  },
  {
    value: "ask_all",
    label: "Perguntar tudo",
    description: "Toda ação que não é só leitura pede aprovação.",
  },
];

/** The groups, in the order of the page: what is refused, what always asks, what runs alone. */
const GROUPS: readonly { kind: WrittenRuleKind; icon: typeof Ban; header: string }[] = [
  { kind: "never", icon: Ban, header: "O bot é avisado e a ação não roda." },
  { kind: "ask", icon: CircleHelp, header: "A ação sempre espera o seu cartão." },
  { kind: "allow", icon: CircleCheck, header: "Roda sozinha, quando a regra a cobre por inteiro." },
];

/** The line under the last group: what the written rules do in the mode and the reviewer you have. */
function precedenceHint(settings: ApprovalSettings | undefined): string {
  if (settings?.mode === "ask_all")
    return "No modo Perguntar tudo as regras escritas não são lidas: toda ação que não é só leitura pede aprovação.";
  if (settings !== undefined && !settings.reviewer.available)
    return "Sem o modelo de revisão as regras escritas não são lidas: vale o nível de risco de cada ação.";
  return "Quem proíbe ou manda perguntar vale mais do que quem libera.";
}

/** One written rule as a row: its sentence, whom it is for, the switch, "Editar" and "Remover". */
function WrittenRuleRow({
  rule,
  botName,
  onEdit,
  onRemove,
}: {
  rule: WrittenRule;
  botName: string | undefined;
  onEdit(): void;
  onRemove(): void;
}) {
  const { sync, api } = useServices();
  const toggling = useTask();
  return (
    <div data-testid="written-rule" data-kind={rule.kind} data-enabled={rule.enabled}>
      <SettingsRow
        title={rule.text}
        titleTestId="written-rule-sentence"
        description={
          <>
            <RowLine data-testid="written-rule-for">
              {botName ?? "Todos os bots"}
              {!rule.enabled && " · desligada"}
            </RowLine>
            {toggling.error !== undefined && (
              <RowLine className="text-danger-text" role="alert">
                {toggling.error}
              </RowLine>
            )}
          </>
        }
        control={
          <>
            <Toggle
              checked={rule.enabled}
              disabled={toggling.busy}
              label={`Regra ligada: ${rule.text}`}
              testId="written-rule-toggle"
              onChange={(next) =>
                void toggling.run(() =>
                  sync.writtenRuleCall(() => api.writtenRules.update(rule.id, { enabled: next })),
                )
              }
            />
            <RowAction data-testid="written-rule-edit" onClick={onEdit}>
              Editar
            </RowAction>
            <RowAction danger data-testid="written-rule-delete" onClick={onRemove}>
              Remover
            </RowAction>
          </>
        }
      />
    </div>
  );
}

/** The old exact rules (a field equal to a value), read and removed only: nothing new is made here. */
function ExactRulesDialog({ rules, onClose }: { rules: ApprovalRule[]; onClose(): void }) {
  const { sync } = useServices();
  const bots = useData((s) => s.bots);
  const connectorsByName = useData((s) => s.connectors);
  const connectors = useMemo(() => Object.values(connectorsByName), [connectorsByName]);
  const [deleting, setDeleting] = useState<ApprovalRule | null>(null);
  const removal = useTask();
  const context = (rule: ApprovalRule) => ({
    botName: rule.botId === null ? undefined : bots[rule.botId]?.name,
    connectors,
  });
  return (
    <>
      <Dialog
        title="Regras exatas (avançado)"
        onClose={onClose}
        footer={
          <Pill tone="secondary" onClick={onClose} data-testid="rules-exact-close">
            Fechar
          </Pill>
        }
      >
        <MutedText as="p">
          São as regras de antes, que comparam um campo com um valor exato. Valem como sempre; aqui
          você só as vê e as remove.
        </MutedText>
        <div className="flex flex-col gap-2" data-testid="rules-exact-list">
          <SettingsCard>
            {rules.length === 0 && <SettingsRow title="Nenhuma regra exata." />}
            {rules.map((rule) => (
              <div key={rule.id} data-testid="rule-row" data-effect={rule.effect}>
                <SettingsRow
                  title={ruleSentence(rule, context(rule))}
                  titleTestId="rule-sentence"
                  description={
                    <>
                      {!rule.enabled && (
                        <RowLine data-testid="rule-disabled-reason">
                          Desativada: {rule.disabledReason}
                        </RowLine>
                      )}
                      {rule.note !== null && rule.note !== "" && <RowLine>{rule.note}</RowLine>}
                    </>
                  }
                  control={
                    <RowAction danger data-testid="rule-delete" onClick={() => setDeleting(rule)}>
                      Remover
                    </RowAction>
                  }
                />
              </div>
            ))}
          </SettingsCard>
        </div>
      </Dialog>
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
          <PlainText>{ruleSentence(deleting, context(deleting))}</PlainText>
          <MutedText as="p">
            Depois de removida, as próximas chamadas voltam a seguir o nível da ferramenta: o que
            sai para o mundo volta a pedir cartão.
          </MutedText>
          {removal.error !== undefined && <FieldError>{removal.error}</FieldError>}
        </Dialog>
      )}
    </>
  );
}

/**
 * Permissões, as small as it can be: how approvals work (the mode), the three kinds of rule YOU
 * WRITE with "Adicionar regra", and the way to the connectors' tool permissions. Pending cards live
 * in Pendências and in the chat, how the cards behave is in Geral. The old exact rules are one quiet
 * row at the end, only when some exist.
 */
export function PermissionsSettings({ title, titleId, onClose }: SectionProps) {
  const { sync, api } = useServices();
  const bots = useData((s) => s.bots);
  const writtenById = useData((s) => s.writtenRules);
  const writtenLoaded = useData((s) => s.writtenRulesLoaded);
  const exactById = useData((s) => s.rules);
  const setTab = useUi((s) => s.setSettingsTab);
  const exact = useMemo(() => orderedRules({ rules: exactById }), [exactById]);
  const [settings, setSettings] = useState<ApprovalSettings | undefined>(undefined);
  const [modeError, setModeError] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<{
    kind: WrittenRuleKind;
    rule: WrittenRule | undefined;
  } | null>(null);
  const [deleting, setDeleting] = useState<WrittenRule | null>(null);
  const [showExact, setShowExact] = useState(false);
  const removal = useTask();

  // None of these has a stream frame: read them when the section opens.
  useEffect(() => {
    void sync.loadWrittenRules();
    void sync.loadRules();
    void sync.loadConnectors();
    api.approvalSettings
      .get()
      .then(setSettings, (error: unknown) => setModeError(messageOf(error)));
  }, [sync, api]);

  // The mode changes at once on the screen and goes back, with the server's words, if it refuses.
  const changeMode = (mode: ApprovalMode) => {
    if (settings === undefined) return;
    const before = settings;
    setModeError(undefined);
    setSettings({ ...before, mode });
    api.approvalSettings.update({ mode }).then(setSettings, (error: unknown) => {
      setSettings(before);
      setModeError(messageOf(error));
    });
  };

  const mode = MODES.find((m) => m.value === settings?.mode);
  const reviewerNote =
    settings !== undefined && !settings.reviewer.available && settings.mode === "auto_review"
      ? (settings.reviewer.reason ?? "O modelo de revisão não está disponível.")
      : undefined;

  return (
    <>
      <PaneHead title={title} titleId={titleId} onClose={onClose} />
      <PaneBody>
        <SettingsGroup label="Aprovações">
          <SettingsRow
            icon={ShieldCheck}
            title="Modo"
            description={
              <>
                {mode !== undefined && (
                  <RowLine data-testid="approval-mode-description">{mode.description}</RowLine>
                )}
                {reviewerNote !== undefined && (
                  <RowLine data-testid="reviewer-unavailable">
                    {reviewerNote} Por enquanto vale o nível de risco de cada ação.
                  </RowLine>
                )}
              </>
            }
            control={
              <SettingsSelect
                label="Modo de aprovação"
                value={settings?.mode ?? ""}
                testId="approval-mode"
                options={MODES.map((m) => [m.value, m.label, m.description] as const)}
                onChange={(value) => changeMode(value as ApprovalMode)}
                {...(settings === undefined ? { disabled: true, placeholder: "Carregando…" } : {})}
              />
            }
          />
          {modeError !== undefined && (
            <SettingsRow
              title="Não foi possível mudar o modo"
              description={modeError}
              role="note"
            />
          )}
        </SettingsGroup>
        <div className="contents" data-testid="rules-card">
          {GROUPS.map(({ kind, icon, header }, index) => {
            const mine = writtenRulesOf({ writtenRules: writtenById }, kind);
            return (
              <SettingsGroup
                key={kind}
                label={KIND_TEXT[kind].title}
                testId={`rules-${kind}`}
                {...(index === GROUPS.length - 1 ? { hint: precedenceHint(settings) } : {})}
              >
                <SettingsRow
                  icon={icon}
                  title="Regras"
                  description={header}
                  control={
                    <RowAction
                      data-testid={`rule-new-${kind}`}
                      onClick={() => setEditing({ kind, rule: undefined })}
                    >
                      Adicionar regra
                    </RowAction>
                  }
                />
                {!writtenLoaded ? (
                  <SettingsRow title="Carregando…" />
                ) : (
                  mine.map((rule) => (
                    <WrittenRuleRow
                      key={rule.id}
                      rule={rule}
                      botName={rule.botId === null ? undefined : bots[rule.botId]?.name}
                      onEdit={() => setEditing({ kind, rule })}
                      onRemove={() => setDeleting(rule)}
                    />
                  ))
                )}
              </SettingsGroup>
            );
          })}
        </div>
        <SettingsGroup label="Conectores">
          <SettingsRow
            icon={Plug}
            title="Permissões dos conectores"
            description="Você escolhe quais ferramentas de cada conector cada bot pode usar; as que o servidor mudou esperam a sua revisão."
            control={
              <RowAction data-testid="open-connectors" onClick={() => setTab("connectors")}>
                Abrir conectores
              </RowAction>
            }
          />
        </SettingsGroup>
        {exact.length > 0 && (
          <SettingsGroup>
            <SettingsRow
              icon={ListChecks}
              title="Regras exatas (avançado)"
              description={`${exact.length} ${exact.length === 1 ? "regra" : "regras"}, de quando a comparação era de um campo com um valor exato.`}
              testId="rules-exact"
              control={
                <RowAction data-testid="rules-exact-open" onClick={() => setShowExact(true)}>
                  Abrir
                </RowAction>
              }
            />
          </SettingsGroup>
        )}
      </PaneBody>
      {editing !== null && (
        <WrittenRuleDialog
          kind={editing.kind}
          rule={editing.rule}
          onClose={() => setEditing(null)}
        />
      )}
      {showExact && <ExactRulesDialog rules={exact} onClose={() => setShowExact(false)} />}
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
                data-testid="written-rule-delete-confirm"
                onClick={() =>
                  void removal
                    .run(() => sync.deleteWrittenRule(deleting.id))
                    .then((ok) => ok && setDeleting(null))
                }
              >
                {removal.busy ? "Removendo…" : "Remover"}
              </Pill>
            </>
          }
        >
          <PlainText>{deleting.text}</PlainText>
          <MutedText as="p">
            Depois de removida, o revisor deixa de usar esta regra nas próximas chamadas.
          </MutedText>
          {removal.error !== undefined && <FieldError>{removal.error}</FieldError>}
        </Dialog>
      )}
    </>
  );
}
