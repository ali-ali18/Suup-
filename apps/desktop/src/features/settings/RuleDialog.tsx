import type { ApprovalRule, ArgMatcher, ToolInfo } from "@suup/api";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useData, useServices } from "../../app/context.js";
import { sortedBots } from "../../app/selectors.js";
import { ruleSentence, toolTitle } from "../../data/approval-text.js";
import { Dialog, Pill, TextField } from "../../ui/primitives.js";
import { useTask } from "./use-task.js";

interface Draft {
  botId: string;
  tool: string;
  matchers: (ArgMatcher & { id: number })[];
  note: string;
}

let draftRow = 0;
const withId = (m: ArgMatcher) => ({ ...m, id: ++draftRow });

function draftOf(rule: ApprovalRule | undefined): Draft {
  return rule === undefined
    ? { botId: "", tool: "", matchers: [], note: "" }
    : {
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
      ...tools.map((t) => ({ value: t.name, label: toolTitle(t.name) })),
      ...connectors.flatMap((c) =>
        (c.tools ?? []).map((t) => ({
          value: t.name,
          label: `${c.name} → ${t.tool}`,
        })),
      ),
    ];
  }, [tools, connectorsByName]);
}

/**
 * "Adicionar regra" / "Editar": small and calm. A rule needs one thing, the tool; the bot, the exact
 * conditions and the note are behind "Mais opções" and nothing is shown until asked. A condition is
 * always `field is exactly value`; there is no other comparison.
 */
export function RuleDialog({
  rule,
  effect,
  onClose,
}: {
  rule: ApprovalRule | undefined;
  effect: "allow" | "deny";
  onClose(): void;
}) {
  const { sync, api } = useServices();
  const bots = useData((s) => s.bots);
  const connectorsByName = useData((s) => s.connectors);
  const connectors = useMemo(() => Object.values(connectorsByName), [connectorsByName]);
  const choices = useToolChoices();
  const [draft, setDraft] = useState<Draft>(() => draftOf(rule));
  const [more, setMore] = useState(
    () => rule !== undefined && (rule.matchers.length > 0 || rule.note !== null || !rule.enabled),
  );
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
              effect,
              matchers: clean,
              note: note === "" ? null : note,
              ...(disabled ? { enabled: true } : {}),
            }),
          )
        : sync.ruleCall(() =>
            api.rules.create({
              tool: draft.tool,
              effect,
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
      title={
        editing ? "Editar regra" : effect === "allow" ? "Permitir sem perguntar" : "Nunca permitir"
      }
      onClose={onClose}
      footer={
        <>
          <Pill tone="secondary" onClick={onClose} disabled={task.busy}>
            Cancelar
          </Pill>
          <Pill
            tone="primary"
            onClick={() => void save()}
            disabled={task.busy || (!editing && draft.tool === "")}
            data-testid="rule-save"
          >
            {task.busy ? "Salvando…" : disabled ? "Salvar e ativar" : "Salvar"}
          </Pill>
        </>
      }
    >
      <div className="srule-form" data-testid="rule-form" data-effect={effect}>
        {disabled && (
          <div className="ui-notice" data-testid="rule-disabled-notice">
            <strong>Regra desativada</strong>
            <p className="wrap">{rule.disabledReason}</p>
          </div>
        )}
        <div className="ui-field">
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
              {/* Nothing is chosen for the user: a rule for "any tool" is an explicit choice. */}
              <option value="" disabled>
                Escolha uma ferramenta
              </option>
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <p className="ui-field__hint" data-testid="rule-preview" aria-live="polite">
          {draft.tool !== "" &&
            ruleSentence(
              {
                effect,
                tool: draft.tool,
                botId: draft.botId === "" ? null : draft.botId,
                matchers,
              },
              { botName, connectors },
            )}
        </p>
        <div>
          <Pill
            tone="ghost"
            className="spill spill--ghost"
            aria-expanded={more}
            data-testid="rule-more"
            onClick={() => setMore(!more)}
          >
            {more ? "Menos opções" : "Mais opções"}
          </Pill>
        </div>
        {more && (
          <>
            <div className="ui-field">
              <label className="ui-field__label" htmlFor="rule-bot">
                De quem
              </label>
              {editing ? (
                <p>
                  {rule.botId === null
                    ? "Todos os bots"
                    : (bots[rule.botId]?.name ?? "Bot removido")}
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
            <div className="ui-field">
              <span className="ui-field__label">Só quando (igualdade exata)</span>
              {draft.matchers.length === 0 && (
                <p className="ui-field__hint" data-testid="rule-any-use">
                  Sem condições, a regra vale para <strong>qualquer uso</strong> da ferramenta.
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
                  className="spill spill--ghost"
                  icon={<Plus size={16} aria-hidden="true" />}
                  onClick={() =>
                    set({ matchers: [...draft.matchers, withId({ field: "", value: "" })] })
                  }
                >
                  Adicionar condição
                </Pill>
              </div>
            </div>
            <TextField
              label="Anotação (opcional)"
              value={draft.note}
              onChange={(note) => set({ note })}
            />
          </>
        )}
        {(problem ?? task.error) !== undefined && (
          <p className="ui-field__error" role="alert" data-testid="rule-error">
            {problem ?? task.error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
