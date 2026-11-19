// Decide quando o acompanhamento de uma execução para por ela estar esperando alguém. O status da
// linha NÃO basta: ao retomar, a linha volta por instantes ao status de espera enquanto o laço a
// coloca onde o log está, antes de absorver a resposta ou a decisão que o log já tem. Parar ali
// derruba o worker embutido e deixa a execução na fila. Só se espera de verdade quando há algo
// pendente segundo os eventos (uma pergunta sem resposta) ou os cartões (um cartão sem decisão).

/** O que a decisão precisa de um evento: só o tipo. */
export interface WaitEvent {
  type: string;
}

/**
 * Há uma pergunta (`escalated`) ou um pedido de segredo (`secret_requested`) sem resposta: o último
 * evento entre esses dois e `user_message` (a resposta chega ao log como mensagem do usuário) é uma
 * pergunta, não uma resposta.
 */
export function questionPending(events: readonly WaitEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = (events[i] as WaitEvent).type;
    if (type === "user_message") return false;
    if (type === "escalated" || type === "secret_requested") return true;
  }
  return false;
}

/**
 * Se a execução está mesmo esperando por alguém: `waiting_user` com uma pergunta pendente nos
 * eventos, ou `waiting_approval` com ao menos um cartão pendente. Qualquer outro status: não.
 */
export function isReallyWaiting(
  status: string,
  events: readonly WaitEvent[],
  pendingCardCount: number,
): boolean {
  if (status === "waiting_approval") return pendingCardCount > 0;
  if (status === "waiting_user") return questionPending(events);
  return false;
}
