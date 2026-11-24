import {
  type EscalateQuestion,
  escalatedQuestions,
  type PlanStep,
  type RunEventData,
  runEventSchema,
} from "@suup/core";
import {
  firstLines,
  formatClock,
  formatDuration,
  formatInt,
  formatUsd,
  indent,
  levelPt,
  oneLine,
  originExplanation,
  outcomePt,
  SOURCE_PT,
  statusPt,
} from "./format.js";
import { optionLines } from "./questionnaire.js";

/**
 * What the bot asked, for the terminal: the text and, for a question with choices, the numbered
 * options (the answer is their numbers, separated by commas, or free text; Enter skips).
 */
export function renderQuestions(questions: readonly EscalateQuestion[]): string[] {
  const lines: string[] = [];
  const many = questions.length > 1;
  questions.forEach((q, i) => {
    lines.push(...indent(`${many ? `${i + 1}. ` : ""}${q.question}`, "    "));
    for (const line of optionLines(q)) lines.push(`      ${line}`);
  });
  if (many) lines.push("    (Enter pula uma pergunta)");
  return lines;
}

/** An event as it comes out of the database, before any interpretation. */
export interface RawEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

/** The typed form of an event, or `undefined` when it does not match the current schema. */
export function typedEvent(event: RawEvent): RunEventData | undefined {
  const parsed = runEventSchema.safeParse({ type: event.type, payload: event.payload });
  return parsed.success ? parsed.data : undefined;
}

/** What the live view remembers between events. */
export interface RenderState {
  callNames: Map<string, string>;
  turn: number;
}

export function newRenderState(): RenderState {
  return { callNames: new Map(), turn: 0 };
}

/**
 * A render state that already knows the events before `fromSeq`, for a view that starts in the
 * middle of a run (a resume): the turn counter goes on, and the answers to calls made earlier are
 * recognized.
 */
export function primedRenderState(events: readonly RawEvent[]): RenderState {
  const state = newRenderState();
  for (const event of events) {
    const e = typedEvent(event);
    if (e?.type === "tool_call") state.callNames.set(e.payload.callId, e.payload.name);
    else if (e?.type === "model_request" && (e.payload.purpose ?? "agent") === "agent")
      state.turn += 1;
  }
  return state;
}

const PLAN_MARK: Record<PlanStep["status"], string> = {
  pending: "[ ]",
  in_progress: "[~]",
  done: "[x]",
  dropped: "[-]",
};

/** The plan as a checklist, one line per step. */
export function renderPlan(plan: readonly PlanStep[], prefix = "  "): string[] {
  if (plan.length === 0) return [`${prefix}(sem plano)`];
  return plan.map((s) => {
    const note =
      s.note === undefined || s.note === ""
        ? ""
        : ` (${s.status === "dropped" ? "descartado: " : ""}${s.note})`;
    return `${prefix}${PLAN_MARK[s.status]} ${s.title}${note}`;
  });
}

/** One-line summary of tool arguments: the argument that matters most, or compact JSON. */
export function summarizeArgs(name: string, args: unknown, max = 100): string {
  if (name === "finish" || name === "escalate") {
    const text = (args as Record<string, unknown> | null)?.[
      name === "finish" ? "summary" : "question"
    ];
    return typeof text === "string" ? JSON.stringify(oneLine(text, max)) : "";
  }
  if (name === "plan") {
    const steps = (args as { steps?: unknown[] } | null)?.steps;
    return Array.isArray(steps) ? `(${steps.length} passo${steps.length === 1 ? "" : "s"})` : "";
  }
  if (typeof args !== "object" || args === null)
    return args === undefined ? "" : oneLine(JSON.stringify(args), max);
  const record = args as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return "";
  // The first of these that is present leads; the rest follow while they fit.
  const lead = ["command", "path", "url", "pattern", "query", "question", "summary"].find(
    (k) => k in record,
  );
  const ordered = lead === undefined ? keys : [lead, ...keys.filter((k) => k !== lead)];
  const parts: string[] = [];
  for (const key of ordered) {
    const value = record[key];
    const text =
      typeof value === "string"
        ? JSON.stringify(oneLine(value, 60))
        : oneLine(JSON.stringify(value) ?? "null", 40);
    parts.push(`${key}=${text}`);
    if (parts.join(" ").length >= max) break;
  }
  return oneLine(parts.join(" "), max);
}

/** An approval card for the terminal: what will run, how risky it is, which secrets it uses. */
export function renderApprovalCard(card: {
  id: string;
  tool: string;
  level: string;
  summary: string;
  args: unknown;
  secrets: readonly string[];
  /** Why the card exists, when the automatic review said so. */
  reviewReason?: string | null;
}): string[] {
  const args = JSON.stringify(card.args, null, 2) ?? "null";
  return [
    `┌ Aprovação ${card.id.slice(0, 8)} · ${levelPt(card.level)}`,
    `│ ${card.summary}`,
    `│ ferramenta: ${card.tool}`,
    ...(card.reviewReason === undefined || card.reviewReason === null
      ? []
      : [`│ por que pergunta: ${card.reviewReason}`]),
    ...(card.secrets.length === 0
      ? []
      : [`│ usa segredos: ${card.secrets.join(", ")} (o valor nunca é mostrado)`]),
    "│ conteúdo exato que será executado:",
    ...args.split("\n").map((line) => `│   ${line}`),
    "└",
  ];
}

const REVIEW_OUTCOME_PT = {
  allow: "liberou",
  ask: "mandou perguntar a você",
  deny: "bloqueou",
} as const;

const NUDGE_PT: Record<string, string> = {
  repetition: "chamada repetida",
  empty_response: "resposta vazia",
  output_truncated: "resposta cortada pelo limite de saída",
  stopped_without_finish: "parou sem concluir",
  error_loop: "mesmo erro várias vezes",
  alternation: "vai e volta entre duas chamadas",
  stuck: "sem sair do lugar",
};

const CHECK_ACTION_PT = {
  continue: "segue",
  nudge: "avisou o bot",
  extend: "estendeu o limite",
  ask: "perguntou ao dono",
  stop: "parou a execução",
} as const;

const CHECK_TRIGGER_PT = {
  soft_limit: "perto do limite",
  limit: "limite de passos",
  repeat: "chamada repetida",
  error_loop: "mesmo erro",
  no_tool: "sem ferramenta",
  alternation: "vai e volta",
  near_repeat: "quase repetição",
} as const;

const CHECK_VERDICT_PT = { avanca: "avança", circulo: "em círculo", incerto: "incerto" } as const;

/**
 * The lines the live view prints for one event (possibly none). Pure apart from `state`, which it
 * updates (call names, turn counter).
 */
export function renderEvent(event: RawEvent, state: RenderState): string[] {
  const e = typedEvent(event);
  if (e === undefined)
    return [
      `· evento ${event.type} (seq ${event.seq}) fora do esquema atual; veja com suup inspect`,
    ];
  switch (e.type) {
    case "run_started": {
      const { objective, acceptanceCriteria } = e.payload;
      return [
        `Objetivo: ${objective}`,
        ...(acceptanceCriteria.length === 0
          ? []
          : ["Critérios de pronto:", ...acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`)]),
      ];
    }
    case "context_loaded": {
      const { rules, profile, history } = e.payload;
      if (rules.length + profile.length + history.length === 0) return [];
      const parts = [
        rules.length > 0 ? `${rules.length} regra${rules.length === 1 ? "" : "s"}` : "",
        profile.length > 0
          ? `${profile.length} fato${profile.length === 1 ? "" : "s"} do perfil`
          : "",
        history.length > 0
          ? `${history.length} mensagem${history.length === 1 ? "" : "s"} anterior${history.length === 1 ? "" : "es"} da conversa`
          : "",
      ].filter((part) => part !== "");
      return [`· contexto carregado: ${parts.join(", ")}`];
    }
    case "model_request": {
      const purpose = e.payload.purpose ?? "agent";
      if (purpose === "review") return [`· revisor (${e.payload.model}) conferindo a conclusão…`];
      if (purpose === "compaction")
        return [`· resumindo o início da conversa (${e.payload.model})…`];
      state.turn += 1;
      return [`· turno ${state.turn}: consultando ${e.payload.model}…`];
    }
    case "model_response": {
      const lines: string[] = [];
      const text = e.payload.blocks
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("\n")
        .trim();
      if (text !== "" && (e.payload.purpose ?? "agent") === "agent")
        lines.push(...indent(text, "  | "));
      if (e.payload.stopReason === "max_tokens")
        lines.push("  ! resposta cortada pelo limite de tokens de saída");
      if (e.payload.stopReason === "refusal") lines.push("  ! o provedor registrou uma recusa");
      return lines;
    }
    case "model_error":
      return [
        `  ! erro do provedor (${e.payload.kind}), tentativa ${e.payload.attempt}: ${oneLine(e.payload.message, 200)}${e.payload.retryable ? " — vai tentar de novo" : ""}`,
      ];
    case "tool_call": {
      state.callNames.set(e.payload.callId, e.payload.name);
      const summary = summarizeArgs(e.payload.name, e.payload.args);
      return [`→ ${e.payload.name}${summary === "" ? "" : `  ${summary}`}`];
    }
    case "tool_result": {
      const name = state.callNames.get(e.payload.callId) ?? "?";
      const { outcome, content, durationMs, truncated, isError } = e.payload;
      if (name === "escalate" && outcome === "ok") {
        return ["  ← resposta recebida:", ...indent(content, "    ")];
      }
      // The plan and the finish are shown by their own events; only their failures matter here.
      if ((name === "plan" || name === "finish") && !isError) return [];
      if (name === "finish") return [];
      const label = outcome === "ok" && !isError ? "ok" : outcomePt(outcome);
      const head = `  ← ${label}${durationMs > 0 ? ` (${formatDuration(durationMs)})` : ""}${truncated ? " [saída truncada]" : ""}`;
      const { shown, more } = firstLines(content);
      return [
        head,
        ...shown.map((l) => `    ${l}`),
        ...(more > 0 ? [`    … (+${more} linha${more === 1 ? "" : "s"})`] : []),
      ];
    }
    case "plan_updated":
      return ["Plano:", ...renderPlan(e.payload.plan)];
    case "user_message":
      return [
        `✉ sua mensagem chegou ao bot${e.payload.linkedApprovalId === undefined ? "" : " (ligada à ação que você recusou)"}: ${oneLine(e.payload.text, 160)}`,
      ];
    case "nudge":
      return [
        `↻ o harness lembrou o bot (${NUDGE_PT[e.payload.reason] ?? e.payload.reason}): ${oneLine(e.payload.text, 140)}`,
      ];
    case "finish_attempt": {
      if (e.payload.accepted) return ["Conclusão aceita."];
      return [
        "Conclusão recusada:",
        ...e.payload.rejectionReasons.flatMap((r) =>
          indent(r, "  - ").map((l, i) => (i === 0 ? l : `    ${l.trimStart()}`)),
        ),
        ...(e.payload.handedToUser === true ? ["  (a decisão foi passada para você)"] : []),
      ];
    }
    case "review": {
      const verdict = {
        approve: "aprovou",
        reject: "reprovou",
        unverified: "não conseguiu verificar",
      }[e.payload.verdict];
      return [
        `Revisor ${verdict}${e.payload.notes.trim() === "" ? "" : `: ${oneLine(e.payload.notes, 200)}`}`,
        ...(e.payload.discrepancies ?? []).map(
          (d) =>
            `  - ${oneLine(d.claimed, 80)} → ${oneLine(d.shows, 80)} (${oneLine(d.where, 40)})`,
        ),
        ...(e.payload.unchecked ?? []).map(
          (u) => `  - sem verificar (${u.kind} ${oneLine(u.ref, 40)}): ${oneLine(u.what, 80)}`,
        ),
        ...(e.payload.namedNothing === true
          ? ["  ! o revisor não nomeou nada que lhe faltasse (nem depois de perguntado de novo)"]
          : []),
        ...(e.payload.warning === undefined ? [] : [`  ! aviso: ${e.payload.warning}`]),
      ];
    }
    case "review_evidence": {
      const { supplied, missing, round, omitted } = e.payload;
      const cut = supplied.filter((i) => i.sent < i.chars).length;
      const left = omitted?.length ?? 0;
      return [
        `· revisor pediu mais evidências (rodada ${round}): ${supplied.length} item(ns) enviado(s)${cut > 0 ? `, ${cut} cortado(s) pelo limite` : ""}${left > 0 ? `, ${left} ficou(aram) de fora pelo limite` : ""}${missing.length > 0 ? `, ${missing.length} indisponível(is)` : ""}`,
      ];
    }
    case "review_reprompt":
      return [
        `· revisor reprovou sem apontar divergência; perguntado de novo (${e.payload.reason})`,
      ];
    case "escalated":
      return [
        e.payload.reason === "progress_limit"
          ? "? O bot parou e pergunta se deve continuar:"
          : e.payload.reason !== "review_tie_break"
            ? "? O bot precisa de você:"
            : e.payload.reviewVerdict === "unverified"
              ? "? O revisor não conseguiu verificar parte do trabalho e precisa da sua decisão:"
              : "? O bot e o revisor não chegaram a um acordo e precisam da sua decisão:",
        // The watchdog's own words (no model wrote them): what happened, what is done and left.
        ...(e.payload.reason === "progress_limit" && e.payload.lead !== undefined
          ? indent(e.payload.lead, "  ")
          : []),
        ...renderQuestions(escalatedQuestions(e.payload)),
      ];
    case "progress_check":
      return [
        `· vigia (${CHECK_TRIGGER_PT[e.payload.trigger]}): ${CHECK_ACTION_PT[e.payload.action]}${e.payload.verdict === undefined ? "" : `; o juiz diz: ${CHECK_VERDICT_PT[e.payload.verdict]}${e.payload.reason === undefined ? "" : ` (${oneLine(e.payload.reason, 100)})`}`}`,
      ];
    case "progress_decided":
      return [
        e.payload.choice === "continue"
          ? `· você deixou seguir por mais ${e.payload.grant} passos`
          : "· você pediu para parar por aqui",
      ];
    case "status_changed": {
      const { to, failure, result } = e.payload;
      const lines: string[] = [];
      if (to === "failed" && failure !== undefined) {
        lines.push(`Falhou [origem: ${failure.origin}]: ${oneLine(failure.detail, 300)}`);
        lines.push(`  ${failure.origin}: ${originExplanation(failure.origin)}`);
      } else if (to === "done") {
        lines.push("Concluída.");
        if (result !== undefined) {
          lines.push(...indent(result.summary, "  "));
          for (const item of result.evidence ?? []) {
            lines.push(`  - ${oneLine(item.criterion, 80)}: ${oneLine(item.evidence, 160)}`);
          }
        }
      } else if (to === "cancelled") {
        lines.push("Cancelada a pedido do usuário.");
      } else if (to === "waiting_user") {
        lines.push("● aguardando sua resposta");
      } else if (to === "waiting_approval") {
        lines.push("● aguardando aprovação");
      } else if (to === "waiting_timer") {
        lines.push("● parada até a hora do retorno");
      } else if (to === "running" && e.payload.from === "waiting_timer") {
        lines.push("● retomada");
      } else if (to === "running" && e.payload.from === "waiting_user") {
        lines.push("● retomada");
      }
      return lines;
    }
    case "compacted":
      return [
        `· contexto compactado: ${e.payload.droppedMessages} mensagens resumidas${e.payload.degraded === true ? " (sem resumo: o modelo falhou ao resumir)" : ""}`,
      ];
    case "policy_checked":
      return [
        `· política: ${e.payload.tool} (${levelPt(e.payload.level)}) ${e.payload.outcome === "allow" ? "liberada" : "recusada"} por ${SOURCE_PT[e.payload.source]}${e.payload.reason === undefined ? "" : `: ${oneLine(e.payload.reason, 120)}`}`,
      ];
    case "approval_review":
      return [
        `· revisão automática: ${e.payload.tool} (${levelPt(e.payload.level)}) ${REVIEW_OUTCOME_PT[e.payload.outcome]}${e.payload.reason === "" ? "" : `: ${oneLine(e.payload.reason, 140)}`}`,
      ];
    case "approval_requested":
      return [
        `? Aprovação necessária (${levelPt(e.payload.level)}): ${oneLine(e.payload.summary, 160)}`,
        ...(e.payload.reason === undefined ? [] : [`  por quê: ${oneLine(e.payload.reason, 160)}`]),
      ];
    case "approval_decided":
      return [
        e.payload.decision === "approved"
          ? "● aprovada"
          : `● ${e.payload.decision === "denied" ? "negada" : e.payload.decision === "expired" ? "expirada" : "cancelada"}${e.payload.reason === undefined ? "" : `: ${oneLine(e.payload.reason, 160)}`}`,
      ];
    case "approval_stale":
      return [
        `● aprovada tarde (esperou ${formatDuration(e.payload.waitedMs)}): a chamada não rodou; o bot foi avisado e a aprovação vale uma vez para a chamada idêntica`,
      ];
    case "approval_grant_used":
      return [`● chamada idêntica à aprovada tarde: rodou sem novo cartão (${e.payload.tool})`];
    case "secret_requested":
      return [
        `? O bot pede o segredo ${e.payload.name}${e.payload.reason === undefined ? "" : ` (${oneLine(e.payload.reason, 120)})`}`,
      ];
    case "tool_catalog":
      return [`· ferramentas de conectores: ${summarizeEvent(event)}`];
    case "wait_scheduled":
      return [
        `· retorno agendado para ${formatClock(new Date(e.payload.at))} (${e.payload.minutes} min): ${oneLine(e.payload.note, 160)}`,
      ];
    case "wait_fired":
      return [`· hora do retorno: ${oneLine(e.payload.note, 160)}`];
    case "wait_cancelled":
      return [`· retorno cancelado (${WAIT_CANCEL_PT[e.payload.reason]})`];
  }
}

/** The compact one-line summary used by `suup inspect` for the typed event, or JSON when unknown. */
export function summarizeEvent(event: RawEvent): string {
  const e = typedEvent(event);
  if (e === undefined) return oneLine(JSON.stringify(event.payload), 110);
  switch (e.type) {
    case "run_started":
      return `bot ${e.payload.botId.slice(0, 8)} objetivo=${JSON.stringify(oneLine(e.payload.objective, 70))}`;
    case "context_loaded":
      return `${e.payload.rules.length} regras · ${e.payload.profile.length} fatos do perfil · ${e.payload.history.length} mensagens de histórico${e.payload.historyNote === undefined ? "" : " (com aviso de mensagens omitidas)"}`;
    case "model_request": {
      const purpose = e.payload.purpose ?? "agent";
      const stats = e.payload.toolStats;
      const defs =
        stats === undefined
          ? ""
          : ` (definições: ${stats.definitions} enviadas, ${stats.deferred} adiadas, estimativa: ~${formatInt(stats.estimatedTokens)} tok no total, ~${formatInt(stats.loadedTokens)} no contexto)`;
      return `${purpose} ${e.payload.provider}/${e.payload.model} · ${e.payload.messages.length} msgs · ${e.payload.tools.length} ferramentas${defs}`;
    }
    case "model_response": {
      const calls = e.payload.blocks
        .filter((b) => b.type === "tool_call")
        .map((b) => (b.type === "tool_call" ? b.name : ""));
      const text = e.payload.blocks.flatMap((b) => (b.type === "text" ? [b.text] : [])).join(" ");
      const { inputTokens, outputTokens } = e.payload.usage;
      const measure = e.payload.measure;
      // The provider's real count, with the estimate beside it so the estimate can be judged; with
      // the provider's own tool search the count SUMS internal passes.
      const measured =
        measure === undefined
          ? ""
          : ` (pedido inteiro estimado em ~${formatInt(measure.estimatedTokens)}${measure.hostedToolSearch === undefined ? "" : "; busca do provedor: a entrada soma as passagens internas, não é o tamanho de um pedido"})`;
      return `${e.payload.stopReason} · ${e.payload.modelVersion} · ${formatInt(inputTokens)}→${formatInt(outputTokens)} tok${measured} · ${formatDuration(e.payload.durationMs)}${calls.length > 0 ? ` · chamadas: ${calls.join(", ")}` : ""}${text.trim() === "" ? "" : ` · "${oneLine(text, 50)}"`}`;
    }
    case "model_error":
      return `${e.payload.kind} (tentativa ${e.payload.attempt}${e.payload.retryable ? ", retentável" : ""}): ${oneLine(e.payload.message, 80)}`;
    case "tool_call":
      return `${e.payload.callId} ${e.payload.name} ${summarizeArgs(e.payload.name, e.payload.args, 80)}`;
    case "tool_result":
      return `${e.payload.callId} ${e.payload.outcome}${e.payload.isError ? " (erro)" : ""} · ${formatDuration(e.payload.durationMs)} · ${e.payload.content.length} caracteres${e.payload.truncated ? " (truncado)" : ""}: ${JSON.stringify(oneLine(e.payload.content, 50))}`;
    case "plan_updated": {
      const done = e.payload.plan.filter((s) => s.status === "done").length;
      return `${done}/${e.payload.plan.length} passos feitos`;
    }
    case "user_message":
      return `${e.payload.linkedApprovalId === undefined ? "" : `[ligada à aprovação ${e.payload.linkedApprovalId.slice(0, 8)}] `}${JSON.stringify(oneLine(e.payload.text, 90))}`;
    case "nudge":
      return `${e.payload.reason}: ${oneLine(e.payload.text, 80)}`;
    case "progress_check":
      return `${e.payload.trigger} → ${e.payload.action}${e.payload.verdict === undefined ? "" : ` (${e.payload.verdict})`} · passos ${e.payload.turns}/${e.payload.limit}`;
    case "progress_decided":
      return `${e.payload.choice}${e.payload.grant > 0 ? ` +${e.payload.grant}` : ""}`;
    case "finish_attempt":
      return e.payload.accepted
        ? `aceita: ${JSON.stringify(oneLine(e.payload.summary, 80))}`
        : `recusada: ${oneLine(e.payload.rejectionReasons.join(" | "), 90)}`;
    case "review":
      return `${e.payload.verdict}: ${oneLine(e.payload.notes, 80)}${e.payload.warning === undefined ? "" : ` (aviso: ${oneLine(e.payload.warning, 50)})`}`;
    case "review_evidence":
      return `rodada ${e.payload.round}: ${e.payload.supplied.length} enviado(s), ${e.payload.omitted?.length ?? 0} de fora pelo limite, ${e.payload.missing.length} indisponível(is)`;
    case "review_reprompt":
      return `reprovação sem divergência: ${oneLine(e.payload.reason, 80)}`;
    case "escalated":
      return JSON.stringify(oneLine(e.payload.question, 90));
    case "status_changed": {
      const { from, to, failure } = e.payload;
      return `${from} → ${to}${failure === undefined ? "" : ` [${failure.origin}] ${oneLine(failure.detail, 80)}`}`;
    }
    case "compacted":
      return `${e.payload.droppedMessages} mensagens resumidas até seq ${e.payload.uptoSeq}${e.payload.degraded === true ? " (degradado)" : ""}`;
    case "policy_checked":
      return `${e.payload.callId} ${e.payload.tool} ${e.payload.level} → ${e.payload.outcome} (${e.payload.source}${e.payload.ruleId === undefined ? "" : ` ${e.payload.ruleId.slice(0, 8)}`})`;
    case "approval_review":
      return `${e.payload.callId} ${e.payload.tool} ${e.payload.level} → ${e.payload.decision}/${e.payload.outcome}${e.payload.ruleId === null ? "" : ` (regra ${e.payload.ruleId.slice(0, 8)})`}${e.payload.skipped === undefined ? "" : ` [${e.payload.skipped}]`}${e.payload.costUsd === undefined ? "" : ` US$ ${e.payload.costUsd.toFixed(5)}`}`;
    case "approval_requested":
      return `${e.payload.callId} ${e.payload.tool} ${e.payload.level} · ${oneLine(e.payload.summary, 80)}${e.payload.secrets.length === 0 ? "" : ` · segredos: ${e.payload.secrets.join(", ")}`}`;
    case "approval_decided":
      return `${e.payload.callId} ${e.payload.decision}${e.payload.reason === undefined ? "" : `: ${oneLine(e.payload.reason, 80)}`}`;
    case "approval_stale":
      return `${e.payload.callId} esperou ${formatDuration(e.payload.waitedMs)} (limite ${formatDuration(e.payload.thresholdMs)})`;
    case "approval_grant_used":
      return `${e.payload.callId} ${e.payload.tool} (aprovação ${e.payload.approvalId.slice(0, 8)})`;
    case "secret_requested":
      return `${e.payload.callId} ${e.payload.name}`;
    case "wait_scheduled":
      return `${e.payload.at} (${e.payload.minutes} min) · ${oneLine(e.payload.note, 90)}`;
    case "wait_fired":
      return `${e.payload.at}${e.payload.delayMs === undefined ? "" : ` · ${Math.round(e.payload.delayMs / 1000)} s depois da hora`} · ${oneLine(e.payload.note, 80)}`;
    case "wait_cancelled":
      return WAIT_CANCEL_PT[e.payload.reason];
    case "tool_catalog":
      return `${MODE_PT[e.payload.mode]}: ${e.payload.connectorTools} ferramenta(s) de conectores, ~${formatInt(e.payload.definitionTokens)} tok de definições${e.payload.deferred.length > 0 ? `, ${e.payload.deferred.length} adiada(s)` : ""}`;
  }
}

const WAIT_CANCEL_PT = {
  user_message: "o usuário escreveu",
  cancelled: "a execução foi cancelada",
  replaced: "substituído por um novo retorno",
  finished: "a execução terminou",
} as const;

const MODE_PT = {
  direct: "carregadas direto",
  hosted: "busca do provedor",
  client: "busca nossa + carregamento do provedor",
  meta: "índice + search_tools/use_tool",
} as const;

export interface RunFooter {
  id: string;
  status: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | string;
  durationMs: number | null;
}

/** The lines closing a followed run: status, turns, tokens, cost. */
export function renderFooter(run: RunFooter): string[] {
  return [
    "────────────────────────────────────────",
    `Execução ${run.id}: ${statusPt(run.status)}${run.durationMs === null ? "" : ` em ${formatDuration(run.durationMs)}`}`,
    `Turnos: ${run.turns} · Tokens: ${formatInt(run.inputTokens)} de entrada, ${formatInt(run.outputTokens)} de saída · Custo: ${formatUsd(run.costUsd)}`,
  ];
}
