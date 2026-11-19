// Decide quando o acompanhamento de uma execução para por ela estar esperando alguém. O status da
// linha NÃO basta: ao retomar, a linha volta por instantes ao status de espera enquanto o laço a
// coloca onde o log está, antes de absorver a resposta ou a decisão que o log já tem. Parar ali
// derruba o worker embutido e deixa a execução na fila. Só se espera de verdade quando há algo
// pendente segundo os eventos (uma pergunta sem resposta) ou os cartões (um cartão sem decisão).

/** O que a decisão precisa de um evento: o tipo e, para casar pergunta e resposta, o `callId`. */
export interface WaitEvent {
  type: string;
  payload?: unknown;
}

const callIdOf = (event: WaitEvent): string | undefined => {
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const id = (payload as { callId?: unknown }).callId;
  return typeof id === "string" ? id : undefined;
};

/**
 * Há uma pergunta (`escalated`) ou um pedido de segredo (`secret_requested`) sem resposta. A
 * resposta chega ao log de duas formas: como o `tool_result` da chamada que perguntou (mesmo
 * `callId`: é assim que o laço entrega a resposta a um `escalate` ou `request_secret`) ou como
 * `user_message` (mensagem entregue depois do pedido). Só vale a última pergunta do log.
 */
export function questionPending(events: readonly WaitEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i] as WaitEvent;
    if (event.type !== "escalated" && event.type !== "secret_requested") continue;
    const callId = callIdOf(event);
    return !events
      .slice(i + 1)
      .some(
        (later) =>
          later.type === "user_message" ||
          (later.type === "tool_result" && callId !== undefined && callIdOf(later) === callId),
      );
  }
  return false;
}

/**
 * Se a execução está mesmo esperando por alguém: `waiting_user` com uma pergunta pendente nos
 * eventos E nada na caixa de entrada à espera de ser lido, ou `waiting_approval` com ao menos um
 * cartão pendente. Qualquer outro status: não.
 *
 * A caixa de entrada conta porque `suup say` põe a resposta ali e recoloca a execução na fila; o
 * worker a pega e, antes de absorver a resposta (que só então vira evento), a linha volta por
 * instantes a `waiting_user` com a pergunta ainda sem resposta no log. Sem olhar a caixa, esse
 * instante parece uma espera de verdade e o acompanhamento para o worker embutido, deixando a
 * execução na fila.
 */
export function isReallyWaiting(
  status: string,
  events: readonly WaitEvent[],
  pendingCardCount: number,
  inboxPending = false,
): boolean {
  if (status === "waiting_approval") return pendingCardCount > 0;
  if (status === "waiting_user") return !inboxPending && questionPending(events);
  return false;
}
