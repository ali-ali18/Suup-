import { buildAnswerText, parseAnswerText, type Question, type QuestionAnswer } from "@suup/api";
import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { focusOnAppearance } from "../lib/focus.js";
import { Pill } from "./primitives.js";

const OTHER = "\u0000other";
const letter = (index: number): string => String.fromCharCode(65 + index);

export interface QuestionCardProps {
  questions: readonly Question[];
  /** The text of the user's reply, once there is one: the card is then dimmed and inert. */
  answer?: string | undefined;
  /** Move the focus into the card when it appears (the caller says whether the user is typing). */
  autoFocus?: boolean;
  disabled?: boolean;
  /** The answer, as the plain text that is sent as the user's message. */
  onSubmit(text: string): void;
}

/** True when the user is in the middle of typing something that is not an empty composer. */
export function userIsTyping(active: Element | null = document.activeElement): boolean {
  if (active === null) return false;
  const tag = active.tagName;
  if (tag !== "TEXTAREA" && tag !== "INPUT") return false;
  return (active as HTMLInputElement | HTMLTextAreaElement).value !== "";
}

/**
 * A question of the bot as a card (like the owner's reference): the question in bold, a muted
 * helper line, options as rows with a letter chip. One choice answers on click; several choices, or
 * several questions, use a footer with page dots and Voltar / Pular / Avançar (Enviar on the last
 * page). The answer is plain text (`buildAnswerText`); once there is a reply the card shows what was
 * chosen, dimmed.
 */
export function QuestionCard({
  questions,
  answer,
  autoFocus,
  disabled,
  onSubmit,
}: QuestionCardProps) {
  const [page, setPage] = useState(0);
  const [picks, setPicks] = useState<string[][]>(() => questions.map(() => []));
  const [others, setOthers] = useState<string[]>(() => questions.map(() => ""));
  const rootId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const answered = answer !== undefined;
  const count = questions.length;
  const quick = count === 1 && questions[0]?.multiple !== true;

  // The card appears: take the focus, unless the user is typing.
  useEffect(() => {
    if (autoFocus === true && !answered && !userIsTyping()) {
      focusOnAppearance(
        ref.current?.querySelector<HTMLElement>('[role="radio"], [role="checkbox"]'),
      );
    }
  }, []);

  const parsed: QuestionAnswer[] | null = answered ? parseAnswerText(questions, answer) : null;

  const submit = (nextPicks: string[][] = picks, nextOthers: string[] = others) => {
    const answers = questions.map((_, i): QuestionAnswer => {
      const chosen = [...(nextPicks[i] ?? []).filter((p) => p !== OTHER)];
      if ((nextPicks[i] ?? []).includes(OTHER) && (nextOthers[i] ?? "").trim() !== "")
        chosen.push((nextOthers[i] ?? "").trim());
      return chosen.length === 0 ? { chosen, skipped: true } : { chosen };
    });
    onSubmit(buildAnswerText(questions, answers));
  };

  const choose = (qi: number, label: string) => {
    const q = questions[qi] as Question;
    const current = picks[qi] ?? [];
    let next: string[];
    if (q.multiple === true)
      next = current.includes(label) ? current.filter((l) => l !== label) : [...current, label];
    else next = [label];
    const all = picks.map((p, i) => (i === qi ? next : p));
    setPicks(all);
    // One question, one choice: choosing is answering (typing "other" needs its text first).
    if (quick && label !== OTHER) submit(all);
  };

  const advance = (skip: boolean) => {
    const cleared = skip ? picks.map((p, i) => (i === page ? [] : p)) : picks;
    if (skip) setPicks(cleared);
    if (page === count - 1) submit(cleared);
    else setPage(page + 1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;
    const rows = Array.from(
      ref.current?.querySelectorAll<HTMLElement>('[role="radio"], [role="checkbox"]') ?? [],
    );
    const index = rows.indexOf(target);
    if (e.key === "ArrowDown" || e.key === "ArrowRight") {
      e.preventDefault();
      rows[(index + 1) % rows.length]?.focus();
    } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
      e.preventDefault();
      rows[(index - 1 + rows.length) % rows.length]?.focus();
    } else if (/^[a-fA-F]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const row = rows[e.key.toUpperCase().charCodeAt(0) - 65];
      if (row !== undefined) {
        e.preventDefault();
        row.focus();
        row.click();
      }
    }
  };

  const renderQuestion = (q: Question, qi: number, readOnly: boolean) => {
    const options = [
      ...(q.options ?? []).map((o) => ({
        key: o.label,
        label: o.label,
        description: o.description,
      })),
    ];
    if (q.allowOther === true && q.options !== undefined)
      options.push({ key: OTHER, label: "Outra resposta", description: undefined });
    const chosenBefore = parsed?.[qi]?.chosen ?? [];
    const multiple = q.multiple === true;
    const selected = picks[qi] ?? [];
    return (
      <div className="qcard__question" key={`${rootId}-${qi}`} data-testid="question-block">
        <p className="qcard__title wrap" id={`${rootId}-q${qi}`}>
          {q.question}
        </p>
        {multiple && !readOnly && (
          <p className="qcard__helper">Selecione todas as opções aplicáveis</p>
        )}
        {q.options !== undefined && (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: both roles named here are labelled groups
          <div
            role={multiple ? "group" : "radiogroup"}
            aria-labelledby={`${rootId}-q${qi}`}
            className="qcard__options"
          >
            {options.map((o, oi) => {
              const on = readOnly ? chosenBefore.includes(o.label) : selected.includes(o.key);
              return (
                // biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is checkbox or radio
                <button
                  key={o.key}
                  type="button"
                  role={multiple ? "checkbox" : "radio"}
                  aria-checked={on}
                  disabled={disabled === true || readOnly}
                  tabIndex={readOnly ? -1 : on || (selected.length === 0 && oi === 0) ? 0 : -1}
                  className={`qcard__option${on ? " qcard__option--on" : ""}`}
                  data-testid="question-option"
                  onClick={() => choose(qi, o.key)}
                >
                  <span className="qcard__chip" aria-hidden="true">
                    {letter(oi)}
                  </span>
                  <span className="qcard__text">
                    <span className="qcard__label">{o.label}</span>
                    {o.description !== undefined && o.description !== "" && (
                      <span className="qcard__detail">{o.description}</span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {!readOnly && (q.options === undefined || selected.includes(OTHER)) && (
          <input
            className="qcard__other ui-field__control"
            aria-label={`Sua resposta para: ${q.question}`}
            placeholder="Escreva a sua resposta"
            value={others[qi] ?? ""}
            onChange={(e) => setOthers(others.map((v, i) => (i === qi ? e.target.value : v)))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && quick && (others[qi] ?? "").trim() !== "") {
                e.preventDefault();
                submit();
              }
            }}
          />
        )}
      </div>
    );
  };

  if (answered) {
    return (
      <div
        className="qcard qcard--answered"
        data-testid="question-card"
        data-state="answered"
        inert
        aria-disabled="true"
      >
        {questions.map((q, i) => renderQuestion(q, i, true))}
      </div>
    );
  }

  const last = page === count - 1;
  const showFooter = !quick;
  return (
    <div
      ref={ref}
      className="qcard"
      data-testid="question-card"
      data-state="open"
      onKeyDown={onKeyDown}
    >
      {renderQuestion(questions[page] as Question, page, false)}
      {quick && questions[0]?.allowOther === true && (picks[0] ?? []).includes(OTHER) && (
        <div className="qcard__footer">
          <span />
          <Pill
            tone="primary"
            disabled={disabled === true || (others[0] ?? "").trim() === ""}
            onClick={() => submit()}
          >
            Enviar
          </Pill>
        </div>
      )}
      {showFooter && (
        <div className="qcard__footer">
          {count > 1 ? (
            <span
              className="qcard__dots"
              role="img"
              aria-label={`Pergunta ${page + 1} de ${count}`}
            >
              {questions.map((_, i) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: static dots, never reordered
                  key={`${rootId}-dot-${i}`}
                  className={`qcard__dot${i === page ? " qcard__dot--on" : ""}`}
                />
              ))}
            </span>
          ) : (
            <span />
          )}
          <span className="qcard__actions">
            {page === 0 ? (
              <Pill tone="secondary" disabled={disabled === true} onClick={() => advance(true)}>
                Pular
              </Pill>
            ) : (
              <Pill tone="secondary" disabled={disabled === true} onClick={() => setPage(page - 1)}>
                Voltar
              </Pill>
            )}
            <Pill tone="primary" disabled={disabled === true} onClick={() => advance(false)}>
              {last ? "Enviar" : "Avançar"}
            </Pill>
          </span>
        </div>
      )}
    </div>
  );
}
