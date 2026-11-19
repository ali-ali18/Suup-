import { MAX_WRITTEN_RULE_CHARS, type WrittenRule, type WrittenRuleKind } from "@suup/api";
import { type KeyboardEvent, useId, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { Dropdown } from "../../ui/dropdown.js";
import { Dialog, Pill } from "../../ui/primitives.js";
import { useTask } from "./use-task.js";

/** The three kinds of written rule: the name the owner knows, and the example that teaches the sentence. */
export const KIND_TEXT: Record<
  WrittenRuleKind,
  { title: string; description: string; placeholder: string }
> = {
  never: {
    title: "Nunca permitir",
    description: "A ação não roda e o bot é avisado.",
    placeholder: "Apagar a pasta notas",
  },
  ask: {
    title: "Sempre perguntar",
    description: "A ação sempre espera o seu cartão.",
    placeholder: "Qualquer coisa que gaste dinheiro",
  },
  allow: {
    title: "Permitir sem perguntar",
    description: "A ação roda sozinha, quando a regra a cobre por inteiro.",
    placeholder: "E-mails para minha equipe em acme.com",
  },
};

/** The counter shows only this close to the limit. */
const COUNTER_FROM = MAX_WRITTEN_RULE_CHARS - 80;

/**
 * "Adicionar regra" / "Editar regra": a rule is a sentence you WRITE (docs/DESIGN.md §3c). One text
 * area and, to say which bot, one dropdown. The text is not parsed by anything here: a model reads
 * it. The server's own words are shown when it refuses (too long, too many rules).
 */
export function WrittenRuleDialog({
  kind,
  rule,
  onClose,
}: {
  kind: WrittenRuleKind;
  rule: WrittenRule | undefined;
  onClose(): void;
}) {
  const { sync, api } = useServices();
  const botsById = useData((s) => s.bots);
  const bots = useMemo(() => sortedBots(botsById), [botsById]);
  const editing = rule !== undefined;
  const [text, setText] = useState(rule?.text ?? "");
  const [botId, setBotId] = useState(rule?.botId ?? "");
  const task = useTask();
  const textId = useId();
  const hintId = useId();
  const length = text.trim().length;

  const save = async () => {
    if (length === 0 || task.busy) return;
    const ok = await task.run(() =>
      editing
        ? sync.writtenRuleCall(() => api.writtenRules.update(rule.id, { text: text.trim() }))
        : sync.writtenRuleCall(() =>
            api.writtenRules.create({
              kind,
              text: text.trim(),
              botId: botId === "" ? null : botId,
            }),
          ),
    );
    if (ok) onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  };

  return (
    <Dialog
      title={editing ? "Editar regra" : KIND_TEXT[kind].title}
      onClose={onClose}
      footer={
        <>
          <Pill tone="secondary" onClick={onClose} disabled={task.busy}>
            Cancelar
          </Pill>
          <Pill
            tone="primary"
            onClick={() => void save()}
            disabled={task.busy || length === 0}
            data-testid="written-rule-save"
          >
            {task.busy ? "Salvando…" : editing ? "Salvar" : "Adicionar regra"}
          </Pill>
        </>
      }
    >
      <div className="srule-form" data-testid="written-rule-form" data-kind={kind}>
        <div className={`ui-field${task.error === undefined ? "" : " ui-field--error"}`}>
          <label className="ui-field__label" htmlFor={textId}>
            Aplica-se a
          </label>
          <textarea
            id={textId}
            className="ui-field__control srule-text"
            rows={4}
            value={text}
            placeholder={KIND_TEXT[kind].placeholder}
            aria-describedby={hintId}
            data-testid="written-rule-text"
            onChange={(e) => {
              setText(e.target.value);
              task.clear();
            }}
            onKeyDown={onKey}
          />
          <div className="srule-hint">
            <span className="ui-field__hint" id={hintId}>
              Diga qual é a ação e quem ou o que ela afeta.
            </span>
            {length >= COUNTER_FROM && (
              <span
                className={length > MAX_WRITTEN_RULE_CHARS ? "ui-field__error" : "ui-field__hint"}
                data-testid="written-rule-counter"
              >
                {length}/{MAX_WRITTEN_RULE_CHARS}
              </span>
            )}
          </div>
        </div>
        <div className="ui-field">
          <span className="ui-field__label">Para qual bot</span>
          <Dropdown
            variant="field"
            label="Para qual bot"
            value={botId}
            testId="written-rule-bot"
            disabled={editing}
            options={[
              { value: "", label: "Todos os bots" },
              ...bots.map((b) => ({ value: b.id, label: b.name })),
            ]}
            onChange={setBotId}
          />
        </div>
        {task.error !== undefined && (
          <p className="ui-field__error" role="alert" data-testid="written-rule-error">
            {task.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
